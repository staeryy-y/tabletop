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


def test_change_password_refuses_to_run_before_setup_is_completed(admin_client):
    # admin_client is still on the bootstrap admin/admin credentials at this point —
    # must_change_password is set, so this must route through /complete-setup instead
    # (see its docstring: skipping straight to /change-password would let the account
    # clear the flag without ever renaming itself off "admin").
    r = admin_client.post(
        "/api/auth/change-password",
        json={"current_password": "admin", "new_password": "a real password"},
    )
    assert r.status_code == 400


def test_complete_setup_requires_login(client):
    r = client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "real-name", "new_password": "a real password"},
    )
    assert r.status_code == 401


def test_complete_setup_rejects_wrong_current_password(admin_client):
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "not-the-password", "new_username": "real-name", "new_password": "x1234567"},
    )
    assert r.status_code == 401


def test_complete_setup_rejects_reusing_the_bootstrap_password(admin_client):
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "real-name", "new_password": "admin"},
    )
    assert r.status_code == 400


def test_complete_setup_rejects_an_empty_username(admin_client):
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "   ", "new_password": "a real password"},
    )
    assert r.status_code == 400


def test_complete_setup_rejects_a_username_already_taken_by_someone_else(admin_client):
    admin_client.post("/api/users", json={"username": "taken", "password": "password123", "is_admin": False})
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "taken", "new_password": "a real password"},
    )
    assert r.status_code == 409


def test_complete_setup_renames_the_account_changes_the_password_and_clears_the_flag(admin_client):
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "real-name", "new_password": "a real password"},
    )
    assert r.status_code == 200
    assert r.json() == {"username": "real-name", "isAdmin": True, "mustChangePassword": False}

    me = admin_client.get("/api/auth/me").json()
    assert me == {"username": "real-name", "isAdmin": True, "mustChangePassword": False}

    # neither the old username nor the old password work anymore
    assert admin_client.post("/api/auth/login", json={"username": "admin", "password": "admin"}).status_code == 401
    r_new = admin_client.post("/api/auth/login", json={"username": "real-name", "password": "a real password"})
    assert r_new.status_code == 200


def test_complete_setup_cannot_be_repeated_once_setup_is_done(admin_client):
    admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "real-name", "new_password": "a real password"},
    )
    r = admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "a real password", "new_username": "yet-another-name", "new_password": "whatever123"},
    )
    assert r.status_code == 400


def test_change_password_works_normally_once_setup_is_complete(admin_client):
    admin_client.post(
        "/api/auth/complete-setup",
        json={"current_password": "admin", "new_username": "real-name", "new_password": "first real password"},
    )

    r = admin_client.post(
        "/api/auth/change-password",
        json={"current_password": "first real password", "new_password": "second real password"},
    )
    assert r.status_code == 200

    r_old = admin_client.post("/api/auth/login", json={"username": "real-name", "password": "first real password"})
    assert r_old.status_code == 401
    r_new = admin_client.post("/api/auth/login", json={"username": "real-name", "password": "second real password"})
    assert r_new.status_code == 200
