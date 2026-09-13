"""The signaling WebSocket: presence, WebRTC offer/answer/ICE relay, GM attestation,
host election/migration, and the relay-fallback/snapshot-recovery path.

Protocol is documented in docs/NETWORKING.md. This module is intentionally the only
place that holds any in-memory, per-room, cross-connection state — and even that is
just presence bookkeeping (who's connected, who's host, who's GM) plus an opaque
snapshot blob for recovery; it never parses game state. See docs/ARCHITECTURE.md
principle 1.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import connection
from app.rooms import get_room_by_slug, verify_guest_token

router = APIRouter()


@dataclass
class Peer:
    peer_id: str
    name: str
    is_gm: bool
    ws: WebSocket
    joined_at: float = field(default_factory=time.monotonic)


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


_rooms: dict[str, RoomState] = {}


def _room_state(slug: str) -> RoomState:
    return _rooms.setdefault(slug, RoomState())


def _session_user_id(websocket: WebSocket) -> Optional[int]:
    try:
        return websocket.session.get("user_id")
    except AssertionError:
        # SessionMiddleware not present (shouldn't happen outside tests)
        return None


def _room_owner_id(slug: str) -> Optional[int]:
    with connection() as conn:
        row = conn.execute("SELECT owner_user_id FROM rooms WHERE slug = ?", (slug,)).fetchone()
    return row["owner_user_id"] if row else None


async def _send(peer: Peer, message: dict) -> None:
    try:
        await peer.ws.send_json(message)
    except Exception:
        pass  # best-effort; a dead peer will surface via its own receive loop


async def _broadcast(state: RoomState, message: dict, exclude: Optional[str] = None) -> None:
    for pid, peer in list(state.peers.items()):
        if pid != exclude:
            await _send(peer, message)


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

    is_first = state.host_peer_id is None
    if is_first:
        state.host_peer_id = peer_id

    await _send(
        peer,
        {
            "type": "welcome",
            "peerId": peer_id,
            "hostPeerId": state.host_peer_id,
            "gmPeerId": next((pid for pid, p in state.peers.items() if p.is_gm), None),
            "roomInfo": {"slug": room["slug"], "name": room["name"], "gameDefRef": room["game_def_ref"]},
        },
    )
    if is_first:
        await _send(peer, {"type": "you-are-host", "snapshot": state.snapshot})
    await _broadcast(
        state,
        {"type": "peer-joined", "peerId": peer_id, "name": peer.name, "isGM": is_gm},
        exclude=peer_id,
    )

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
