"""The signaling WebSocket: presence, WebRTC offer/answer/ICE relay, GM attestation,
host election/migration, and the relay-fallback/snapshot-recovery path.

Protocol is documented in docs/NETWORKING.md. This module is intentionally the only
place that holds any in-memory, per-room, cross-connection state — and even that is
just presence bookkeeping (who's connected, who's host, who's GM) plus an opaque
snapshot blob for recovery; it never parses game state. See docs/ARCHITECTURE.md
principle 1.
"""
from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.rooms import get_room_by_slug, verify_guest_token

router = APIRouter()

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")

# A small, visually-distinct palette for the random default assignment — see
# docs/GAME_DEFINITION.md-adjacent request: every player gets a color, randomly
# assigned but changeable, used for their default player Token and (once M6 lands)
# their live cursor. This is presence metadata, not table state, so it rides the
# already-working signaling WS rather than waiting on the P2P object-sync layer.
DEFAULT_COLOR_PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231",
    "#911eb4", "#42d4f4", "#f032e6", "#bfef45",
]


@dataclass
class Peer:
    peer_id: str
    name: str
    is_gm: bool
    ws: WebSocket
    joined_at: float = field(default_factory=time.monotonic)
    color: str = field(default_factory=lambda: random.choice(DEFAULT_COLOR_PALETTE))
    eyes_closed: bool = False


@dataclass
class RoomState:
    peers: dict[str, Peer] = field(default_factory=dict)
    host_peer_id: Optional[str] = None
    snapshot: Optional[dict] = None

    def pick_next_host(self, exclude: str) -> Optional[str]:
        candidates = [p for pid, p in self.peers.items() if pid != exclude]
        if not candidates:
            return None
        gm_candidates = [p for p in candidates if p.is_gm]
        pool = gm_candidates or candidates
        return min(pool, key=lambda p: p.joined_at).peer_id

    def elect_host_on_join(self, peer_id: str, is_gm: bool) -> tuple[bool, bool]:
        """The room's creator is always its host when connected (see docs/DECISIONS.md
        D13) — this is the join-time half of that; pick_next_host above is the
        disconnect-time half. A non-GM peer can still become a *temporary* host by
        joining an otherwise-empty room (so it isn't unusable before the GM shows up),
        but the moment the GM joins — first or not — hosting moves to them, mutating
        `host_peer_id` here exactly like a migration would.

        Returns (promoted, displaced_a_different_host): `promoted` is whether this join
        made `peer_id` host; `displaced_a_different_host` is whether that took hosting
        away from someone else who needs a `host-changed` broadcast (the plain
        first-join-into-an-empty-room case has no one to tell)."""
        is_first = self.host_peer_id is None
        had_different_host = not is_first and self.host_peer_id != peer_id
        promoted = is_first or (is_gm and had_different_host)
        if promoted:
            self.host_peer_id = peer_id
        return promoted, promoted and had_different_host


_rooms: dict[str, RoomState] = {}


def _room_state(slug: str) -> RoomState:
    return _rooms.setdefault(slug, RoomState())


def _session_user_id(websocket: WebSocket) -> Optional[int]:
    try:
        return websocket.session.get("user_id")
    except AssertionError:
        # SessionMiddleware not present (shouldn't happen outside tests)
        return None


async def _send(peer: Peer, message: dict) -> None:
    try:
        await peer.ws.send_json(message)
    except Exception:
        pass  # best-effort; a dead peer will surface via its own receive loop


async def _broadcast(state: RoomState, message: dict, exclude: Optional[str] = None) -> None:
    for pid, peer in list(state.peers.items()):
        if pid != exclude:
            await _send(peer, message)


def _presence(peer: Peer) -> dict:
    return {"peerId": peer.peer_id, "name": peer.name, "isGM": peer.is_gm, "color": peer.color, "eyesClosed": peer.eyes_closed}


@router.websocket("/ws/room/{slug}")
async def room_socket(websocket: WebSocket, slug: str, token: str) -> None:
    room = get_room_by_slug(slug)
    if room is None:
        await websocket.close(code=4404, reason="room not found")
        return

    guest = verify_guest_token(token, slug)
    if guest is None:
        await websocket.close(code=4401, reason="invalid or expired token")
        return

    await websocket.accept()

    state = _room_state(slug)
    peer_id = guest["guestId"]
    is_gm = _session_user_id(websocket) == room["owner_user_id"]
    peer = Peer(peer_id=peer_id, name=guest["displayName"], is_gm=is_gm, ws=websocket)
    state.peers[peer_id] = peer

    promoted, needs_host_changed_broadcast = state.elect_host_on_join(peer_id, is_gm)

    await _send(
        peer,
        {
            "type": "welcome",
            "peerId": peer_id,
            "hostPeerId": state.host_peer_id,
            "gmPeerId": next((pid for pid, p in state.peers.items() if p.is_gm), None),
            "roomInfo": {"slug": room["slug"], "name": room["name"], "gameDefRef": room["game_def_ref"]},
            # Every already-connected peer's presence, so a joiner can render everyone
            # immediately rather than waiting on a peer-joined for each one it missed.
            "peers": [_presence(p) for p in state.peers.values() if p.peer_id != peer_id],
        },
    )
    if promoted:
        await _send(peer, {"type": "you-are-host", "snapshot": state.snapshot})
    await _broadcast(
        state,
        {"type": "peer-joined", **_presence(peer)},
        exclude=peer_id,
    )
    if needs_host_changed_broadcast:
        # Tell whoever was hosting (and everyone else) to re-link to the GM instead —
        # the same message a disconnect-triggered migration sends to survivors.
        await _broadcast(state, {"type": "host-changed", "hostPeerId": peer_id}, exclude=peer_id)

    try:
        while True:
            msg = await websocket.receive_json()
            await _handle_message(state, peer, msg)
    except WebSocketDisconnect:
        pass
    finally:
        await _handle_disconnect(state, peer_id)


async def _handle_message(state: RoomState, sender: Peer, msg: dict) -> None:
    msg_type = msg.get("type")

    if msg_type in ("offer", "answer", "ice"):
        target_id = msg.get("to")
        target = state.peers.get(target_id)
        if target is not None:
            payload = {**msg, "from": sender.peer_id}
            await _send(target, payload)
        return

    if msg_type == "snapshot":
        if sender.peer_id == state.host_peer_id:
            state.snapshot = msg.get("blob")
        return

    if msg_type == "relay":
        target = state.peers.get(msg.get("to"))
        if target is not None:
            await _send(target, {"type": "relay", "from": sender.peer_id, "payload": msg.get("payload")})
        return

    if msg_type == "promote-ack":
        return  # informational only; nothing to do server-side

    if msg_type == "set-presence":
        # Partial update: a client sends only the field(s) it's changing. Presence
        # (color, eyes-closed), unlike game state, is cheap enough and infrequent
        # enough to just live on the signaling WS rather than needing the P2P data
        # channel — see docs/NETWORKING.md's transport-layer split.
        color = msg.get("color")
        if isinstance(color, str) and _HEX_COLOR.fullmatch(color):
            sender.color = color
        eyes_closed = msg.get("eyesClosed")
        if isinstance(eyes_closed, bool):
            sender.eyes_closed = eyes_closed
        await _broadcast(state, {"type": "presence-changed", **_presence(sender)})
        return


async def _handle_disconnect(state: RoomState, peer_id: str) -> None:
    state.peers.pop(peer_id, None)
    await _broadcast(state, {"type": "peer-left", "peerId": peer_id})

    if state.host_peer_id != peer_id:
        return

    new_host_id = state.pick_next_host(exclude=peer_id)
    state.host_peer_id = new_host_id
    if new_host_id is None:
        state.snapshot = None  # room is empty; nothing to resume
        return
    new_host = state.peers[new_host_id]
    await _send(new_host, {"type": "you-are-host", "snapshot": state.snapshot})
    await _broadcast(state, {"type": "host-changed", "hostPeerId": new_host_id}, exclude=new_host_id)
