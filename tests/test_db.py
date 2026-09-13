"""app/db.py: schema creation, the admin/admin bootstrap, and slug generation.

Uses the `client` fixture purely for its DB isolation side effect (fresh, patched
DATA_DIR/DB_PATH) — these tests talk to app.db directly, not over HTTP.
"""
from __future__ import annotations

import re

import app.db as db


def test_init_db_bootstraps_a_single_admin_admin_account(client):
    with db.connection() as conn:
        rows = conn.execute("SELECT * FROM users").fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert row["username"] == "admin"
    assert row["is_admin"] == 1
    assert row["must_change_password"] == 1
    # Never store the plaintext password.
    assert row["password_hash"] != "admin"


def test_init_db_is_idempotent_and_does_not_reset_an_already_changed_password(client):
    from app.auth import set_password

    with db.connection() as conn:
        admin_id = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()["id"]
    set_password(admin_id, "a real password")

    db.init_db()  # simulates a second app startup against the same DB
    db.init_db()

    with db.connection() as conn:
        rows = conn.execute("SELECT * FROM users").fetchall()
    assert len(rows) == 1, "init_db must not create a second admin once one exists"
    assert rows[0]["must_change_password"] == 0, "must not reset a password that was already changed"


def test_init_db_creates_the_rooms_table(client):
    with db.connection() as conn:
        # Will raise sqlite3.OperationalError if the table doesn't exist.
        conn.execute("SELECT * FROM rooms").fetchall()


def test_new_slug_is_fixed_length_lowercase_hex(client):
    slug = db.new_slug()
    assert re.fullmatch(r"[0-9a-f]{10}", slug), f"slug {slug!r} is not 10 lowercase hex chars"


def test_new_slug_has_enough_entropy_to_not_collide_in_practice(client):
    slugs = {db.new_slug() for _ in range(5000)}
    assert len(slugs) == 5000, "collision in 5000 slugs suggests too little entropy"
