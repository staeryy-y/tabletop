"""HTTP-level behavior of app/routes_auth.py: session cookies, status codes, and the
forced-password-change flow end to end."""
from __future__ import annotations


def test_login_with_bootstrap_credentials_succeeds_and_flags_must_change_password(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200
    body = r.json()
    assert body == {"username": "admin", "isAdmin": True, "mustChangePassword": True}


def test_login_with_wrong_password_is_401_and_does_not_leak_whether_the_user_exists(client):
    r_unknown_user = client.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    r_wrong_pass = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r_unknown_user.status_code == 401
    assert r_wrong_pass.status_code == 401
    assert r_unknown_user.json()["detail"] == r_wrong_pass.json()["detail"]


def test_me_requires_login(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 401


def test_me_reflects_the_logged_in_user(admin_client):
    r = admin_client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["username"] == "admin"


def test_logout_clears_the_session(admin_client):
    assert admin_client.get("/api/auth/me").status_code == 200
    r = admin_client.post("/api/auth/logout")
    assert r.status_code == 200
    assert admin_client.get("/api/auth/me").status_code == 401


def test_change_password_requires_login(client):
    r = client.post(
        "/api/auth/change-password",
        json={"current_password": "admin", "new_password": "something else"},
    )
    assert r.status_code == 401


def test_change_password_rejects_wrong_current_password(admin_client):
    r = admin_client.post(
        "/api/auth/change-password",
        json={"current_password": "not-the-password", "new_password": "something else"},
    )
    assert r.status_code == 401


def test_change_password_rejects_reusing_the_bootstrap_password(admin_client):
    r = admin_client.post(
        "/api/auth/change-password", json={"current_password": "admin", "new_password": "admin"}
    )
    assert r.status_code == 400


def test_change_password_success_updates_flag_and_credentials(admin_client):
    r = admin_client.post(
        "/api/auth/change-password",
        json={"current_password": "admin", "new_password": "a real password"},
    )
    assert r.status_code == 200

    me = admin_client.get("/api/auth/me").json()
    assert me["mustChangePassword"] is False

    # the old password no longer works for a fresh login attempt
    r_old = admin_client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert r_old.status_code == 401
    r_new = admin_client.post(
        "/api/auth/login", json={"username": "admin", "password": "a real password"}
    )
    assert r_new.status_code == 200
