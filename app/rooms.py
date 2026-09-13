"""Room CRUD, the join flow, and guest tokens.

Two room kinds, per docs/DECISIONS.md D19:
- **Accounted rooms** need an admin account to *create* (joining is still just a
  display name plus the room's own optional password — no account needed there
  either). Persisted in SQLite, listed on the dashboard, deletable.
- **Anonymous rooms** need no account at all, for either the creator or anyone
  joining. Held entirely in memory (`_anonymous_rooms` below) — never a SQLite row,
  never listed anywhere, and cleaned up the moment they go empty
  (app/signaling.py's _handle_disconnect) — so the server's persistent footprint is
  exactly the same with or without anonymous rooms ever having existed. Their
  `game_def_ref` is `"custom"` or a bundled name, same as an accounted room; the
  difference is purely about the *server's* bookkeeping, not the game itself.

See docs/ARCHITECTURE.md "Room lifecycle" and docs/DECISIONS.md D5/D19.
"""
from __future__ import annotations

import re
import secrets
import sqlite3
from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from app import auth
from app.auth import get_or_create_secret_key, hash_password, verify_password
from app.db import connection, new_slug, now_iso

router = APIRouter(tags=["rooms"])

GUEST_TOKEN_MAX_AGE = 60 * 60 * 12  # 12 hours — long enough for one session's reconnects


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_or_create_secret_key(), salt="room-guest-token")


def issue_guest_token(slug: str, guest_id: str, display_name: str) -> str:
    return _serializer().dumps({"slug": slug, "guestId": guest_id, "displayName": display_name})


def verify_guest_token(token: str, expected_slug: str) -> Optional[dict]:
    """Returns {slug, guestId, displayName} if valid for this room, else None."""
    try:
        data = _serializer().loads(token, max_age=GUEST_TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    if data.get("slug") != expected_slug:
        return None
    return data


class CreateRoomBody(BaseModel):
    name: str
    password: Optional[str] = None
    game_def_ref: str = "bundled:generic-freeform"


class JoinRoomBody(BaseModel):
    display_name: str
    password: Optional[str] = None


@dataclass
class AnonymousRoom:
    slug: str
    name: str
    game_def_ref: str
    password_hash: Optional[str]
    created_at: str


# Purely in-memory, process-lifetime only — see this module's own docstring (D19) for
# why anonymous rooms never touch SQLite. Cleaned up by
# app/signaling.py's _handle_disconnect the moment a room goes empty, the same way
# app.signaling's own `_rooms` dict already holds nothing durable.
_anonymous_rooms: dict[str, AnonymousRoom] = {}


def get_room_by_slug(slug: str) -> Optional[dict]:
    """Returns the same dict shape regardless of which kind of room this is, so
    callers (join_room below, app/signaling.py's room_socket) don't need to care —
    `owner_user_id` is simply always None for an anonymous room (there's no account to
    own it), and `is_anonymous` is there for the one place that *does* need to know:
    telling the client, via `roomInfo`, not to bother uploading a recovery snapshot to
    a server that was never going to persist it anyway (see D19)."""
    with connection() as conn:
        row = conn.execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
    if row is not None:
        return {**dict(row), "is_anonymous": False}

    anon = _anonymous_rooms.get(slug)
    if anon is None:
        return None
    return {
        "slug": anon.slug,
        "name": anon.name,
        "owner_user_id": None,
        "game_def_ref": anon.game_def_ref,
        "password_hash": anon.password_hash,
        "created_at": anon.created_at,
        "is_anonymous": True,
    }


def delete_anonymous_room(slug: str) -> None:
    """Called once a room goes empty (app/signaling.py's _handle_disconnect) — an
    anonymous room that nobody's connected to isn't reachable by anyone who didn't
    already have the link memorized, so there's nothing lost by discarding it
    immediately rather than keeping it around "just in case." A no-op if `slug` isn't
    (or is no longer) an anonymous room, so callers don't need to check first."""
    _anonymous_rooms.pop(slug, None)


MAX_SLUG_COLLISION_RETRIES = 5


@router.post("/api/rooms", status_code=status.HTTP_201_CREATED)
def create_room(body: CreateRoomBody, user: dict = Depends(auth.require_admin)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name required")
    password_hash = hash_password(body.password) if body.password else None

    # new_slug() is random and, vanishingly rarely, could collide with an existing
    # room — sqlite's UNIQUE constraint on rooms.slug is what actually prevents two
    # rooms sharing one, but a collision should retry with a fresh slug rather than
    # surface a raw IntegrityError as a 500.
    for attempt in range(MAX_SLUG_COLLISION_RETRIES):
        slug = new_slug()
        try:
            with connection() as conn:
                conn.execute(
                    "INSERT INTO rooms (slug, name, owner_user_id, game_def_ref, password_hash, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (slug, name, user["id"], body.game_def_ref, password_hash, now_iso()),
                )
            return {"slug": slug}
        except sqlite3.IntegrityError:
            if attempt == MAX_SLUG_COLLISION_RETRIES - 1:
                raise
            continue


@router.post("/api/rooms/anonymous", status_code=status.HTTP_201_CREATED)
def create_anonymous_room(body: CreateRoomBody):
    """No `Depends(auth.require_admin)` — this is the whole point (D19): anyone can
    host a game without an account. See this module's docstring for what "anonymous"
    actually means here (no SQLite row, ever)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name required")
    password_hash = hash_password(body.password) if body.password else None

    for _ in range(MAX_SLUG_COLLISION_RETRIES):
        slug = new_slug()
        # Checked against both namespaces (accounted rooms too) so an anonymous room
        # can never shadow/collide with either kind, even though each is vanishingly
        # unlikely on its own.
        if slug not in _anonymous_rooms and get_room_by_slug(slug) is None:
            _anonymous_rooms[slug] = AnonymousRoom(
                slug=slug, name=name, game_def_ref=body.game_def_ref, password_hash=password_hash, created_at=now_iso()
            )
            return {"slug": slug}
    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "failed to allocate a room slug")


@router.get("/api/rooms")
def list_my_rooms(user: dict = Depends(auth.require_admin)):
    with connection() as conn:
        rows = conn.execute(
            "SELECT slug, name, game_def_ref, password_hash IS NOT NULL AS has_password, created_at "
            "FROM rooms WHERE owner_user_id = ? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    return [
        {
            "slug": r["slug"],
            "name": r["name"],
            "gameDefRef": r["game_def_ref"],
            "hasPassword": bool(r["has_password"]),
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


@router.delete("/api/rooms/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_room(slug: str, user: dict = Depends(auth.require_admin)):
    """Accounted rooms only — an anonymous room has no dashboard listing to delete it
    from in the first place, and already self-deletes the moment it goes empty (see
    delete_anonymous_room)."""
    with connection() as conn:
        row = conn.execute("SELECT owner_user_id FROM rooms WHERE slug = ?", (slug,)).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
        if row["owner_user_id"] != user["id"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not your room")
        conn.execute("DELETE FROM rooms WHERE slug = ?", (slug,))


@router.get("/api/rooms/{slug}")
def get_room(slug: str):
    room = get_room_by_slug(slug)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    return {
        "slug": room["slug"],
        "name": room["name"],
        "gameDefRef": room["game_def_ref"],
        "hasPassword": room["password_hash"] is not None,
    }


_SAFE_NAME = re.compile(r"^[^\x00-\x1f]{1,32}$")


@router.post("/api/rooms/{slug}/join")
def join_room(slug: str, body: JoinRoomBody):
    room = get_room_by_slug(slug)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    if room["password_hash"] is not None:
        if not body.password or not verify_password(body.password, room["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong room password")
    display_name = body.display_name.strip()
    if not display_name or not _SAFE_NAME.match(display_name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid display name")
    guest_id = secrets.token_urlsafe(9)
    token = issue_guest_token(slug, guest_id, display_name)
    return {"token": token, "guestId": guest_id, "displayName": display_name}
