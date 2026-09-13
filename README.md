# RPG Tabletop

A generic, browser-only virtual tabletop — think Tabletop Simulator, but no client
install and no 3D engine. The server is a thin coordinator (accounts, rooms, game
definitions, bootstrap assets, and WebRTC signaling); actual gameplay — cards, boards,
dice, chat — is synced peer-to-peer between browsers.

It's not RPG-specific. A D&D-style character sheet with `/roll 1d20+dex` and a
board-builder game with custom dice, a shuffled deck of room tiles, and a secret traitor
role (validated against the actual rules of *Betrayal at House on the Hill* — see
[docs/GAME_DEFINITION.md](docs/GAME_DEFINITION.md)) are both just configurations of the
same small object model, not two different code paths.

**Status:** planning. Nothing is implemented yet — see `docs/` for the design and
`docs/PLAN.md` for the build order.

## Documents

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Object model, components, repo layout, data model, room lifecycle |
| [docs/NETWORKING.md](docs/NETWORKING.md) | WebRTC signaling, host-authoritative sync, reconnection, trust model |
| [docs/GAME_DEFINITION.md](docs/GAME_DEFINITION.md) | The per-room game definition format: cards, pieces, dice, tracks, triggers |
| [docs/PLAN.md](docs/PLAN.md) | Milestones / build order |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Key architectural decisions and why |

## Elevator pitch

- **Admin-invited accounts only.** No public signup. First run bootstraps an `admin`/`admin`
  account that must change its password on first login. Only admins can create further
  accounts.
- **Rooms, not persistent campaigns (v1).** A logged-in admin creates a room, optionally
  picks a game definition, and gets a shareable link (+ optional password). Anyone with
  the link joins as a guest with just a display name — no account needed.
- **Mostly peer-to-peer.** Once a room's players are connected, the table — cards, board
  pieces, tokens, dice, chat — syncs directly browser-to-browser over WebRTC data
  channels. The FastAPI server only brokers the initial handshake (WebSocket signaling)
  and holds a recovery snapshot in case the host reconnects.
- **A handful of generic pieces, not a rules engine.** Card (moves, rotates, flips, and
  merges into a shuffleable Stack when piled), Piece (board tiles/terrain — moves and
  rotates but never stacks, since building a board isn't the same act as piling cards),
  Token, Die (any custom face set, not just d4/d6/d20), Track (a bounded stat you slide,
  not just a number), Actor, Zone (public/private visibility), and Phase/turn-order. Any
  tabletop game is some starting arrangement of these, optionally with a short list of
  `when X happens, do Y` triggers automating the tedious bookkeeping. See
  docs/GAME_DEFINITION.md.
- **Assumes a cooperating group, like a real table.** No anti-cheat, no per-object
  ownership locks, no cryptography for secret roles — just don't broadcast what a player
  shouldn't see. See docs/NETWORKING.md "Trust model."

## Stack

- **Server:** FastAPI (Python 3), SQLite, uvicorn. Deployed under
  [server-watcher](https://watcher.staery.com/spec) — see `docs/ARCHITECTURE.md` §Deployment
  for what that constrains.
- **Client:** TypeScript + Vite, [PixiJS](https://pixijs.com/) for the table canvas,
  [Preact](https://preactjs.com/) for chat/sheet/lobby UI. Pixel-art visual theme —
  nearest-neighbor-scaled sprites and a bitmap UI font, see `docs/ARCHITECTURE.md`
  §Visual style. Built with `npm run build` and the **built `frontend/dist/` is committed
  to git** — the deploy host only guarantees `python3`, not Node, so there's no build
  step at deploy time.

## Local dev (once code exists)

```bash
./run.sh --reload          # backend, http://127.0.0.1:8000
cd frontend && npm run dev # frontend, with API/WS proxied to the backend
```
