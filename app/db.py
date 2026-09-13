"""SQLite connection + schema. Per docs/ARCHITECTURE.md "Data model": this is the
server's *entire* persistent footprint — accounts and room metadata, nothing else. No
game state, no rulesets, no assets live here (see docs/DECISIONS.md D14).
"""
from __future__ import annotations

import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# Overridable via RPG_TABLETOP_DATA_DIR — mainly so tests can point this at a fresh temp
# directory per test (see tests/conftest.py) without ever touching the real project's
# data/. Also lets an operator relocate persistent state without editing code.
DATA_DIR = Path(os.environ.get("RPG_TABLETOP_DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
DB_PATH = DATA_DIR / "db.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    game_def_ref TEXT NOT NULL DEFAULT 'bundled:generic-freeform',
    password_hash TEXT,
    created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if needed, then bootstrap admin/admin if there are no users yet."""
    with connection() as conn:
        conn.executescript(SCHEMA)
        row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        if row["n"] == 0:
            from app.auth import hash_password  # local import: avoid a circular import

            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, must_change_password, created_at) "
                "VALUES (?, ?, 1, 1, ?)",
                ("admin", hash_password("admin"), now_iso()),
            )


def new_slug() -> str:
    """A short, URL-safe, unguessable room slug.

    Fixed-length lowercase hex rather than token_urlsafe: base64url's alphabet is
    case-sensitive (A-Z and a-z are distinct symbols), so lowercasing it — an earlier
    version of this function did — silently halved its effective entropy and made the
    output length variable (stripping `-`/`_` after the fact could shorten it). Hex has
    no such trap and needs no post-processing.
    """
    return secrets.token_hex(5)  # 10 lowercase hex chars, 16**10 ≈ 1.1e12 possibilities
