# RPG Tabletop

A generic, browser-only virtual tabletop — think Tabletop Simulator, but no client
install and no 3D engine. The server is a thin coordinator: accounts, rooms, and WebRTC
signaling, full stop. Everything else — cards, boards, dice, chat, and every rule/image a
game needs — is synced and shared peer-to-peer between browsers; the server never stores
or serves a single game asset.

It's not RPG-specific, and it's **not a rules engine** — it has no idea what a card's
text means, whose turn it is, or when a game ends, any more than a physical table does.
It just gives people physical-feeling objects (cards, dice, boards, tokens) to move
around together over the network. A D&D-style character sheet with `/roll 1d20+dex`, a
board-builder game with custom dice (stress-tested against the actual rules of
*Betrayal at House on the Hill*), and a hidden-role game like *Avalon* or Mafia are all
just different starting arrangements of the same small object model, not different code
paths — see [docs/GAME_DEFINITION.md](docs/GAME_DEFINITION.md) "Why no rules layer?"

**Status:** planning. Nothing is implemented yet — see `docs/` for the design and
`docs/PLAN.md` for the build order.

## Documents

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Object model, components, repo layout, data model, room lifecycle |
| [docs/NETWORKING.md](docs/NETWORKING.md) | WebRTC signaling, host-authoritative sync, reconnection, trust model |
| [docs/GAME_DEFINITION.md](docs/GAME_DEFINITION.md) | The per-room game definition format — pieces and starting layout only, no rules |
| [docs/PLAN.md](docs/PLAN.md) | Milestones / build order |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Key architectural decisions and why |

## Elevator pitch

- **Admin-invited accounts only.** No public signup. First run bootstraps an `admin`/`admin`
  account that must change its password on first login. Only admins can create further
  accounts.
- **Rooms, not persistent campaigns (v1).** A logged-in admin creates a room, optionally
  picks a game definition, and gets a shareable link (+ optional password). Anyone with
  the link joins as a guest with just a display name — no account needed.
- **Mostly peer-to-peer — assets included.** Once a room's players are connected, the
  table — cards, board pieces, tokens, dice, chat — syncs directly browser-to-browser
  over WebRTC data channels. A room's whole game package (rules **and every image it
  uses**) is a portable file its host loads and P2P-distributes to joiners; the server
  only brokers the initial handshake (WebSocket signaling) and holds a recovery snapshot
  in case the host reconnects. Export/import that package as a file anytime. See
  docs/NETWORKING.md "Asset distribution."
- **A handful of generic pieces, and nothing that understands game rules.** Card (moves,
  rotates, flips, hides, and merges into a shuffleable Stack when piled), Piece (board
  tiles/terrain — moves and rotates but never stacks, since building a board isn't the
  same act as piling cards), Token, Die (any custom face set, not just d4/d6/d20), Track
  (a bounded stat you slide, not just a number), Actor, and Zone (public/private
  visibility). No turns, phases, roles, or win conditions — those are the group's own
  job, same as at a physical table. See docs/GAME_DEFINITION.md "Why no rules layer?"
- **Secrecy without a game definition.** Right-click any Card to hide it — you keep
  seeing its front (with a private reminder icon), everyone else sees only its back. No
  Zone or setup required; it's the same mechanism a Zone formalizes for a whole region.
- **Assumes a cooperating group, like a real table.** No anti-cheat, no per-object
  ownership locks, no cryptography for secret roles — just don't broadcast what a player
  shouldn't see. See docs/NETWORKING.md "Trust model."
- **The room's creator is the GM.** Independent of whichever peer's browser happens to be
  holding state at the moment (see docs/NETWORKING.md), the admin who created the room
  can spawn or delete any object and peek at anything hidden. Everyone else can freely
  manipulate whatever's already on the table (including sliding tracks — no ownership
  lock there either), but only the GM conjures new things onto it or looks at secrets
  that aren't theirs. See docs/ARCHITECTURE.md "Roles: GM vs. players."

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
