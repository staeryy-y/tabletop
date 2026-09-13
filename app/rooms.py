"""Room CRUD, the join flow, and guest tokens.

Rooms need an account only to *create* (admin-only); joining is a display name plus the
room's own optional password — no account. See docs/ARCHITECTURE.md "Room lifecycle" and
docs/DECISIONS.md D5.
"""
from __future__ import annotations

import re
import secrets
import sqlite3
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


def get_room_by_slug(slug: str) -> Optional[dict]:
    with connection() as conn:
        row = conn.execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
    return dict(row) if row else None


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
