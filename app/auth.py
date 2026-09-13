"""Password hashing + session-cookie auth for admins.

Only admins have accounts at all (see docs/DECISIONS.md D5) — there is no signup route.
Session state is a signed cookie (Starlette's SessionMiddleware); it holds just the
user id. Guest (room-joining) identity is a separate, room-scoped concern — see
app/rooms.py — and never touches this module.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Optional

import bcrypt
from fastapi import HTTPException, Request, status

from app.db import connection, now_iso

# See app/db.py's DATA_DIR for why this honors the same env var override.
SECRET_KEY_PATH = (
    Path(os.environ.get("RPG_TABLETOP_DATA_DIR") or Path(__file__).resolve().parent.parent / "data") / ".secret_key"
)


def get_or_create_secret_key() -> str:
    """A stable secret for signing session cookies, generated once and persisted so
    sessions survive a restart/redeploy."""
    SECRET_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_text().strip()
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key)
    return key


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_user(username: str, password: str, is_admin: bool = False) -> int:
    with connection() as conn:
        existing = conn.execute(
            "SELECT 1 FROM users WHERE username = ?", (username,)
        ).fetchone()
        if existing:
            raise ValueError(f"user {username!r} already exists")
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, is_admin, must_change_password, created_at) "
            "VALUES (?, ?, ?, 1, ?)",
            (username, hash_password(password), int(is_admin), now_iso()),
        )
        return cur.lastrowid


def authenticate(username: str, password: str) -> Optional[dict]:
    with connection() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash, is_admin, must_change_password FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    if not row or not verify_password(password, row["password_hash"]):
        return None
    return dict(row)


def set_password(user_id: int, new_password: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
            (hash_password(new_password), user_id),
        )


def complete_setup(user_id: int, new_username: str, new_password: str) -> None:
    """Clears must_change_password *and* renames the account — used for the forced
    first-login flow. A freshly bootstrapped or admin-created account starts with a
    placeholder identity assigned by someone else (literally "admin" for the bootstrap
    account, or whatever an inviting admin typed for a new one) as well as a placeholder
    password; both are "not really yours yet" in the same way, so both get replaced in
    the same step rather than treating the username as a permanent given.
    """
    with connection() as conn:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ? AND id != ?", (new_username, user_id)
        ).fetchone()
        if existing:
            raise ValueError(f"user {new_username!r} already exists")
        conn.execute(
            "UPDATE users SET username = ?, password_hash = ?, must_change_password = 0 WHERE id = ?",
            (new_username, hash_password(new_password), user_id),
        )


def get_user(user_id: int) -> Optional[dict]:
    with connection() as conn:
        row = conn.execute(
            "SELECT id, username, is_admin, must_change_password FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def login(request: Request, user_id: int) -> None:
    request.session["user_id"] = user_id


def logout(request: Request) -> None:
    request.session.clear()


def current_user(request: Request) -> Optional[dict]:
    user_id = request.session.get("user_id")
    if user_id is None:
        return None
    return get_user(user_id)


def require_user(request: Request) -> dict:
    user = current_user(request)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not logged in")
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if not user["is_admin"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin only")
    return user
