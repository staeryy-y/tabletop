"""Test isolation.

The whole point here: no test may ever touch the real project's data/ directory (real
accounts, real rooms), and every test gets its own fresh SQLite database so tests can
run in any order with no shared state. See app/db.py's RPG_TABLETOP_DATA_DIR.

The env var is set *before* app.main is imported anywhere (module-level, at collection
time) so even the one-time, import-time SessionMiddleware secret-key creation in
app.main lands in a throwaway session-wide temp dir rather than the real repo.
Per-test isolation (a fresh DB per test) is then layered on top by the `client` fixture,
which monkeypatches app.db's DATA_DIR/DB_PATH to a fresh tmp_path before the FastAPI
lifespan (which calls init_db()) runs.
"""
from __future__ import annotations

import os
import tempfile

os.environ.setdefault("RPG_TABLETOP_DATA_DIR", tempfile.mkdtemp(prefix="rpg-tabletop-test-session-"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.db as db  # noqa: E402
import app.auth as auth  # noqa: E402
import app.signaling as signaling  # noqa: E402


@pytest.fixture()
def _app(tmp_path, monkeypatch):
    """The FastAPI app, wired to a brand-new, empty database for this test only. Not
    used directly by tests — see `client`/`second_client` below. Fixture-cached per
    test by name, so every fixture that depends on `_app` within one test shares this
    exact app/DB, which is what lets `client` and `second_client` be two genuinely
    independent sessions (separate cookie jars) against the *same* backend."""
    data_dir = tmp_path / "data"
    monkeypatch.setattr(db, "DATA_DIR", data_dir)
    monkeypatch.setattr(db, "DB_PATH", data_dir / "db.sqlite3")
    monkeypatch.setattr(auth, "SECRET_KEY_PATH", data_dir / ".secret_key")

    # app.signaling's per-room registry is process-global, in-memory state (by design —
    # see docs/ARCHITECTURE.md "Data model"). The FastAPI `app` object is a module-level
    # singleton reused across every test in this process (importing app.main only
    # re-runs its module body once), so without this reset, room state from one test
    # could leak into the next if slugs ever collided.
    monkeypatch.setattr(signaling, "_rooms", {})

    from app.main import app as fastapi_app  # imported lazily so the patched paths above are in effect

    return fastapi_app


@pytest.fixture()
def client(_app):
    """A TestClient with its own session/cookie jar, wired to the per-test app/DB."""
    with TestClient(_app) as c:
        yield c


@pytest.fixture()
def second_client(_app):
    """A *second*, independent session against the same app/DB as `client` — for tests
    that need two genuinely distinct browsers (e.g. the room owner plus an unrelated
    guest). Do not use `client` twice for this: pytest caches a fixture's value per
    test by name, so two parameters both named `client` (or one `client` and one
    `admin_client`, which is built on `client`) resolve to the *same* object — same
    cookies, same login. That bug bit test_signaling.py once already; keep it fixed by
    reaching for `second_client` whenever a test needs an actually-different peer."""
    with TestClient(_app) as c:
        yield c


@pytest.fixture()
def admin_client(client):
    """A `client` already logged in as the bootstrap admin (still on the admin/admin
    password — most tests don't care about the forced-change flow)."""
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    return client
