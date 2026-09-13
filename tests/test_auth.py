"""app/auth.py: password hashing, account creation, and authentication — the pure
logic, independent of any HTTP route (routes are covered separately in
test_routes_auth.py)."""
from __future__ import annotations

import pytest

from app import auth


def test_hash_password_roundtrips(client):
    h = auth.hash_password("correct horse battery staple")
    assert h != "correct horse battery staple"
    assert auth.verify_password("correct horse battery staple", h) is True


def test_verify_password_rejects_wrong_password(client):
    h = auth.hash_password("right password")
    assert auth.verify_password("wrong password", h) is False


def test_verify_password_is_case_sensitive(client):
    h = auth.hash_password("Password1")
    assert auth.verify_password("password1", h) is False


def test_verify_password_handles_a_malformed_hash_without_raising(client):
    # A defensive case: bcrypt.checkpw raises ValueError on a hash that isn't valid
    # bcrypt output; that should read as "doesn't match", not crash the caller.
    assert auth.verify_password("anything", "not-a-real-bcrypt-hash") is False


def test_create_user_persists_a_hashed_password_and_forces_a_change(client):
    user_id = auth.create_user("newuser", "s3cret-pass", is_admin=False)
    assert isinstance(user_id, int)

    fetched = auth.get_user(user_id)
    assert fetched["username"] == "newuser"
    assert fetched["is_admin"] is False or fetched["is_admin"] == 0
    assert fetched["must_change_password"] == 1


def test_create_user_can_grant_admin(client):
    user_id = auth.create_user("newadmin", "s3cret-pass", is_admin=True)
    fetched = auth.get_user(user_id)
    assert bool(fetched["is_admin"]) is True


def test_create_user_rejects_a_duplicate_username(client):
    auth.create_user("dupe", "password-one", is_admin=False)
    with pytest.raises(ValueError):
        auth.create_user("dupe", "password-two", is_admin=False)


def test_authenticate_succeeds_with_correct_credentials(client):
    auth.create_user("alice", "alice-password", is_admin=False)
    result = auth.authenticate("alice", "alice-password")
    assert result is not None
    assert result["username"] == "alice"


def test_authenticate_fails_with_wrong_password(client):
    auth.create_user("alice", "alice-password", is_admin=False)
    assert auth.authenticate("alice", "wrong-password") is None


def test_authenticate_fails_for_unknown_username(client):
    assert auth.authenticate("nobody", "whatever") is None


def test_set_password_changes_the_hash_and_clears_must_change_password(client):
    user_id = auth.create_user("bob", "old-password", is_admin=False)
    assert auth.get_user(user_id)["must_change_password"] == 1

    auth.set_password(user_id, "new-password")

    assert auth.authenticate("bob", "old-password") is None
    assert auth.authenticate("bob", "new-password") is not None
    assert auth.get_user(user_id)["must_change_password"] == 0


def test_get_user_returns_none_for_a_missing_id(client):
    assert auth.get_user(999999) is None
