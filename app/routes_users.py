"""Admin-only user management. There is no signup route anywhere in this app — the
only ways an account gets created are here and scripts/create_user.py (same underlying
app.auth.create_user call). See docs/DECISIONS.md D5.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app import auth
from app.db import connection

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(auth.require_admin)])


class CreateUserBody(BaseModel):
    username: str
    password: str
    is_admin: bool = False


@router.get("")
def list_users():
    with connection() as conn:
        rows = conn.execute(
            "SELECT username, is_admin, must_change_password, created_at FROM users ORDER BY username"
        ).fetchall()
    return [
        {
            "username": r["username"],
            "isAdmin": bool(r["is_admin"]),
            "mustChangePassword": bool(r["must_change_password"]),
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_user(body: CreateUserBody):
    if not body.username.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "username required")
    if len(body.password) < 4:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "password too short")
    try:
        auth.create_user(body.username.strip(), body.password, body.is_admin)
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    return {"ok": True}
