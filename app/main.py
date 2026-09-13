from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.auth import get_or_create_secret_key
from app.db import init_db
from app.routes_auth import router as auth_router
from app.routes_users import router as users_router
from app.rooms import router as rooms_router
from app.signaling import router as signaling_router

BASE_DIR = Path(__file__).resolve().parent.parent

app = FastAPI(title="rpg-tabletop")
app.add_middleware(SessionMiddleware, secret_key=get_or_create_secret_key(), same_site="lax")

init_db()

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(rooms_router)
app.include_router(signaling_router)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# Bundled example game definitions (content-only, plain content — see
# docs/GAME_DEFINITION.md). Served as static files: no database, no upload path, exactly
# like frontend/dist below (see docs/ARCHITECTURE.md principle 6 / D14).
GAME_DEFS_DIR = BASE_DIR / "game-defs"
if GAME_DEFS_DIR.exists():
    app.mount("/game-defs", StaticFiles(directory=str(GAME_DEFS_DIR)), name="game-defs")

# The built frontend (npm run build in frontend/) is committed to the repo, since the
# deploy host only guarantees python3, not Node — see docs/DECISIONS.md D2. Mounted last
# so it doesn't shadow the API/WS routes above; html=True makes "/" resolve to
# index.html (server-watcher's health check hits /healthz above, not "/", but browsers
# hitting "/" should still get the app).
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
