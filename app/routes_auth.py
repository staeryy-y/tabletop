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


class CompleteSetupBody(BaseModel):
    current_password: str
    new_username: str
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
    if user["must_change_password"]:
        # Not just a redundant path to the same effect: skipping straight to
        # /change-password would let an account clear must_change_password without
        # ever renaming itself off "admin" (or whatever placeholder it was created
        # with) — see /complete-setup, which this flag specifically requires.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "complete account setup first")
    fresh = auth.authenticate(user["username"], body.current_password)
    if fresh is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "current password is incorrect")
    if not body.new_password or body.new_password == "admin":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "choose a real password")
    auth.set_password(user["id"], body.new_password)
    return {"ok": True}


@router.post("/complete-setup")
def complete_setup(body: CompleteSetupBody, request: Request, user: dict = Depends(auth.require_user)):
    """The forced first-login flow for any account that still has must_change_password
    set — the bootstrap admin/admin account, or one an admin just created. Both the
    username and password are placeholders assigned by someone else at that point, so
    both get replaced together rather than just the password (see
    app.auth.complete_setup's docstring for why "admin" specifically shouldn't linger
    as a real identity)."""
    if not user["must_change_password"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this account has already completed setup")
    fresh = auth.authenticate(user["username"], body.current_password)
    if fresh is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "current password is incorrect")
    new_username = body.new_username.strip()
    if not new_username:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "choose a username")
    if not body.new_password or body.new_password == "admin":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "choose a real password")
    try:
        auth.complete_setup(user["id"], new_username, body.new_password)
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    return _public_user(auth.get_user(user["id"]))
