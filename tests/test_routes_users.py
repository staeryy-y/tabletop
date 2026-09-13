"""app/routes_users.py: admin-only user management. There is no signup route anywhere
— every path to a new account goes through here (or scripts/create_user.py, which
shares the same app.auth.create_user)."""
from __future__ import annotations


def test_list_users_requires_login(client):
    assert client.get("/api/users").status_code == 401


def test_create_user_requires_login(client):
    r = client.post("/api/users", json={"username": "x", "password": "password123", "is_admin": False})
    assert r.status_code == 401


def test_non_admin_cannot_list_or_create_users(admin_client):
    admin_client.post("/api/users", json={"username": "plain", "password": "password123", "is_admin": False})
    admin_client.post("/api/auth/logout")
    admin_client.post("/api/auth/login", json={"username": "plain", "password": "password123"})

    assert admin_client.get("/api/users").status_code == 403
    r = admin_client.post("/api/users", json={"username": "y", "password": "password123", "is_admin": False})
    assert r.status_code == 403


def test_admin_can_list_users(admin_client):
    r = admin_client.get("/api/users")
    assert r.status_code == 200
    usernames = [u["username"] for u in r.json()]
    assert usernames == ["admin"]


def test_admin_can_create_a_user_and_it_appears_in_the_list(admin_client):
    r = admin_client.post("/api/users", json={"username": "newbie", "password": "password123", "is_admin": False})
    assert r.status_code == 201

    listed = {u["username"]: u for u in admin_client.get("/api/users").json()}
    assert "newbie" in listed
    assert listed["newbie"]["isAdmin"] is False
    assert listed["newbie"]["mustChangePassword"] is True


def test_create_user_rejects_duplicate_username(admin_client):
    admin_client.post("/api/users", json={"username": "dupe", "password": "password123", "is_admin": False})
    r = admin_client.post("/api/users", json={"username": "dupe", "password": "password456", "is_admin": False})
    assert r.status_code == 409


def test_create_user_rejects_empty_username(admin_client):
    r = admin_client.post("/api/users", json={"username": "   ", "password": "password123", "is_admin": False})
    assert r.status_code == 400


def test_create_user_rejects_too_short_password(admin_client):
    r = admin_client.post("/api/users", json={"username": "shortpw", "password": "abc", "is_admin": False})
    assert r.status_code == 400


def test_newly_created_admin_can_use_admin_only_routes(admin_client):
    admin_client.post("/api/users", json={"username": "second-admin", "password": "password123", "is_admin": True})
    admin_client.post("/api/auth/logout")
    admin_client.post("/api/auth/login", json={"username": "second-admin", "password": "password123"})

    assert admin_client.get("/api/users").status_code == 200
