"""app/rooms.py: room CRUD (admin-only), the no-account join flow, and guest tokens."""
from __future__ import annotations

import time

import pytest

from app.rooms import delete_anonymous_room, get_room_by_slug, issue_guest_token, verify_guest_token


# --- Guest token: pure roundtrip logic, independent of any route ---


def test_guest_token_roundtrips(client):
    token = issue_guest_token("abc123", "guest-1", "Alice")
    data = verify_guest_token(token, expected_slug="abc123")
    assert data == {"slug": "abc123", "guestId": "guest-1", "displayName": "Alice"}


def test_guest_token_rejects_a_mismatched_slug(client):
    token = issue_guest_token("room-a", "guest-1", "Alice")
    assert verify_guest_token(token, expected_slug="room-b") is None


def test_guest_token_rejects_garbage(client):
    assert verify_guest_token("not-a-real-token", expected_slug="abc123") is None


def test_guest_token_rejects_tampering(client):
    # Flip the *first* character rather than the last: the last base64 character of a
    # token can, depending on byte-length alignment, encode a couple of padding bits
    # that don't affect the decoded payload at all — occasionally making a last-char
    # flip a no-op tamper and this assertion flaky. The first character always encodes
    # real high-order payload bits, so this is deterministic regardless of token length.
    token = issue_guest_token("abc123", "guest-1", "Alice")
    tampered = ("x" if token[0] != "x" else "y") + token[1:]
    assert verify_guest_token(tampered, expected_slug="abc123") is None


def test_guest_token_rejects_expiry(client, monkeypatch):
    import app.rooms as rooms_module

    monkeypatch.setattr(rooms_module, "GUEST_TOKEN_MAX_AGE", 0)
    token = issue_guest_token("abc123", "guest-1", "Alice")
    time.sleep(1.1)
    assert verify_guest_token(token, expected_slug="abc123") is None


# --- Room CRUD ---


def test_create_room_requires_login(client):
    r = client.post("/api/rooms", json={"name": "No Auth Room"})
    assert r.status_code == 401


def test_create_room_requires_admin(admin_client):
    admin_client.post("/api/users", json={"username": "plain", "password": "password123", "is_admin": False})
    admin_client.post("/api/auth/logout")
    admin_client.post("/api/auth/login", json={"username": "plain", "password": "password123"})

    r = admin_client.post("/api/rooms", json={"name": "Should Fail"})
    assert r.status_code == 403


def test_create_room_rejects_empty_name(admin_client):
    r = admin_client.post("/api/rooms", json={"name": "   "})
    assert r.status_code == 400


def test_create_room_defaults_to_generic_freeform(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Defaults"}).json()["slug"]
    info = admin_client.get(f"/api/rooms/{slug}").json()
    assert info["gameDefRef"] == "bundled:generic-freeform"


def test_get_room_404_for_unknown_slug(client):
    assert client.get("/api/rooms/does-not-exist").status_code == 404


def test_get_room_never_exposes_the_password_hash(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Locked", "password": "secret"}).json()["slug"]
    info = admin_client.get(f"/api/rooms/{slug}").json()
    assert info["hasPassword"] is True
    assert "password" not in info
    assert "password_hash" not in info


def test_list_my_rooms_only_shows_rooms_i_own(admin_client):
    admin_client.post("/api/rooms", json={"name": "Mine"})
    admin_client.post("/api/users", json={"username": "other-admin", "password": "password123", "is_admin": True})

    mine = {r["name"] for r in admin_client.get("/api/rooms").json()}
    assert "Mine" in mine

    admin_client.post("/api/auth/logout")
    admin_client.post("/api/auth/login", json={"username": "other-admin", "password": "password123"})
    others_view = {r["name"] for r in admin_client.get("/api/rooms").json()}
    assert "Mine" not in others_view


# --- Join flow ---


def test_join_room_without_password_ignores_any_password_supplied(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Open Room"}).json()["slug"]
    r = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob", "password": "irrelevant"})
    assert r.status_code == 200
    assert r.json()["displayName"] == "Bob"


def test_join_room_with_password_requires_correct_password(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Locked", "password": "hunter2"}).json()["slug"]

    r_no_pw = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob"})
    assert r_no_pw.status_code == 401

    r_wrong = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob", "password": "wrong"})
    assert r_wrong.status_code == 401

    r_right = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob", "password": "hunter2"})
    assert r_right.status_code == 200


def test_join_room_404_for_unknown_slug(client):
    r = client.post("/api/rooms/does-not-exist/join", json={"display_name": "Bob"})
    assert r.status_code == 404


@pytest.mark.parametrize("bad_name", ["", "   ", "a" * 33, "line1\nline2"])
def test_join_room_rejects_invalid_display_names(admin_client, bad_name):
    slug = admin_client.post("/api/rooms", json={"name": "Room"}).json()["slug"]
    r = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": bad_name})
    assert r.status_code == 400


def test_join_room_issues_a_distinct_guest_id_each_time(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Room"}).json()["slug"]
    j1 = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob"}).json()
    j2 = admin_client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob"}).json()
    assert j1["guestId"] != j2["guestId"]
    assert j1["token"] != j2["token"]


def test_join_room_token_is_scoped_to_that_room(admin_client):
    slug_a = admin_client.post("/api/rooms", json={"name": "Room A"}).json()["slug"]
    admin_client.post("/api/rooms", json={"name": "Room B"})

    token = admin_client.post(f"/api/rooms/{slug_a}/join", json={"display_name": "Bob"}).json()["token"]
    assert verify_guest_token(token, expected_slug=slug_a) is not None


# --- Anonymous rooms (docs/DECISIONS.md D19): no account needed, never in SQLite ---


def test_create_anonymous_room_requires_no_login(client):
    r = client.post("/api/rooms/anonymous", json={"name": "Pickup Game"})
    assert r.status_code == 201
    assert "slug" in r.json()


def test_create_anonymous_room_rejects_empty_name(client):
    r = client.post("/api/rooms/anonymous", json={"name": "   "})
    assert r.status_code == 400


def test_anonymous_room_is_immediately_joinable_with_no_account(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup Game"}).json()["slug"]
    r = client.post(f"/api/rooms/{slug}/join", json={"display_name": "Alice"})
    assert r.status_code == 200
    assert r.json()["displayName"] == "Alice"


def test_anonymous_room_password_is_enforced_like_an_accounted_room(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Locked", "password": "hunter2"}).json()["slug"]
    assert client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob"}).status_code == 401
    assert client.post(f"/api/rooms/{slug}/join", json={"display_name": "Bob", "password": "hunter2"}).status_code == 200


def test_get_room_by_slug_marks_an_anonymous_room_correctly(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup Game"}).json()["slug"]
    room = get_room_by_slug(slug)
    assert room is not None
    assert room["is_anonymous"] is True
    assert room["owner_user_id"] is None


def test_get_room_by_slug_marks_an_accounted_room_correctly(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Owned"}).json()["slug"]
    room = get_room_by_slug(slug)
    assert room["is_anonymous"] is False
    assert room["owner_user_id"] is not None


def test_anonymous_rooms_never_appear_in_the_dashboard_room_list(admin_client, second_client):
    anon_slug = second_client.post("/api/rooms/anonymous", json={"name": "Pickup"}).json()["slug"]
    admin_client.post("/api/rooms", json={"name": "Mine"})

    slugs = {r["slug"] for r in admin_client.get("/api/rooms").json()}
    assert anon_slug not in slugs


def test_delete_anonymous_room_is_idempotent_and_needs_no_prior_check(client):
    slug = client.post("/api/rooms/anonymous", json={"name": "Pickup"}).json()["slug"]
    delete_anonymous_room(slug)
    assert get_room_by_slug(slug) is None
    delete_anonymous_room(slug)  # already gone — must not raise
    delete_anonymous_room("never-existed")  # must not raise either


# --- Deleting an accounted room ---


def test_delete_room_requires_login(client):
    assert client.delete("/api/rooms/does-not-exist").status_code == 401


def test_delete_room_404_for_unknown_slug(admin_client):
    assert admin_client.delete("/api/rooms/does-not-exist").status_code == 404


def test_delete_room_removes_it(admin_client):
    slug = admin_client.post("/api/rooms", json={"name": "Doomed"}).json()["slug"]
    r = admin_client.delete(f"/api/rooms/{slug}")
    assert r.status_code == 204
    assert get_room_by_slug(slug) is None


def test_delete_room_requires_ownership(admin_client, second_client):
    slug = admin_client.post("/api/rooms", json={"name": "Not Yours"}).json()["slug"]

    admin_client.post("/api/users", json={"username": "other-admin", "password": "password123", "is_admin": True})
    second_client.post("/api/auth/login", json={"username": "other-admin", "password": "password123"})

    r = second_client.delete(f"/api/rooms/{slug}")
    assert r.status_code == 403
    assert get_room_by_slug(slug) is not None  # still there
