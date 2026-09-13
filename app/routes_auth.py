from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


def _public_user(user: dict) -> dict:
    return {
        "username": user["username"],
        "isAdmin": bool(user["is_admin"]),
        "mustChangePassword": bool(user["must_change_password"]),
    }


@router.post("/login")
def login(body: LoginBody, request: Request):
    user = auth.authenticate(body.username, body.password)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid username or password")
    auth.login(request, user["id"])
    return _public_user(user)


@router.post("/logout")
def logout(request: Request):
    auth.logout(request)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = auth.current_user(request)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not logged in")
    return _public_user(user)


@router.post("/change-password")
def change_password(body: ChangePasswordBody, request: Request, user: dict = Depends(auth.require_user)):
    fresh = auth.authenticate(user["username"], body.current_password)
    if fresh is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "current password is incorrect")
    if not body.new_password or body.new_password == "admin":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "choose a real password")
    auth.set_password(user["id"], body.new_password)
    return {"ok": True}
