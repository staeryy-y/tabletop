# Architecture

## Principles

1. **The server is a coordinator, not a game engine.** It never interprets game state —
   what's a legal move, whose turn it is, what a card says. Its job is: accounts, room
   bookkeeping, serving/storing game definitions and image assets, and WebRTC signaling.
2. **Gameplay state lives in the browser.** The room's *host* peer (whoever opened the
   room) holds the canonical table state in memory and is the source of truth for
   everyone else, connected directly over WebRTC.
3. **No account required to play.** Accounts exist only to gate *room creation*. Joining
   a room is a display name (+ room password, if the admin set one).
4. **Generic like a physical table, not like a specific game.** The engine models a
   handful of physical primitives (cards, tokens, dice, tracks, boards) the same way a
   real table does, plus a thin declarative layer for automating a specific game's
   bookkeeping. It does not try to encode any one game's full rules — see
   [GAME_DEFINITION.md](GAME_DEFINITION.md) for why, and how that's still enough to run
   something as unusual as *Betrayal at House on the Hill* (dynamically-built board,
   custom dice, mid-game rule swap, secret role) alongside a D&D-style character sheet.
5. **Works within server-watcher's constraints.** No Node/build tooling at deploy time,
   no root, no background daemons — see "Deployment" below.

## Object model

Everything on the table is one of a small number of primitive types, synced as part of
the host's game state. This is the layer that makes the system game-agnostic — a specific
game is just a starting arrangement of these plus a short list of automation rules
(GAME_DEFINITION.md), not bespoke code.

| Primitive | What it is | Free manipulation (any player) | Special behavior |
|---|---|---|---|
| **Card** | A deck/hand object: a front face and a back face (image and/or text), a position, a rotation, and a face-up/face-down state. Playing cards, event/item/omen cards, reference sheets. | Move, rotate, flip — always, no ownership lock (see "Trust model" in NETWORKING.md) | When 2+ cards land on top of each other they merge into a **Stack** |
| **Stack** | An emergent, ordered pile of Cards. Not authored directly — it's what a pile of Cards *becomes*, and stays "live" for as long as they're piled: cards dropped on each other anywhere on the table re-merge. | Drag the top card off to pull it back out as a standalone Card | Gains pile-only operations: **shuffle**, **draw** (top/bottom/random), **deal** (to zones/seats), **cut**, **peek** (subject to the zone it's in — see Zones) |
| **Piece** | A board-building or generic movable object that is *not* a deck member: a room/terrain tile, a board section, a standee. Optionally has **connectors** so it snaps edge-to-edge into a layout as it's placed (this is how Betrayal's house gets built room by room). May start in a face-down draw pile (shuffle/draw work the same as a Card Stack), but once placed it's just moved/rotated — placed Pieces never re-merge into a stack the way Cards do; several overlapping (e.g. a pawn standing on a tile) just z-order. | Move, rotate, place | Connector-aware placement can auto-snap to an open edge; a Board can enforce "don't allow a placement that seals off a whole section" as an opt-in rule |
| **Token** | A small marker that rides on a Card or Piece: a pawn, a status marker, an item-pile flag. Toggles between a short list of named states (e.g. "stunned" / "active") rather than a free flip or full movement. | Move, cycle its state | Usually one per Actor, or a handful of shared markers |
| **Die** | A named face set (not limited to d4/d6/d20 — a face can be a number, a symbol, or blank) plus a current rolled value. A *pool* of N dice of one type can be rolled together and combined with an aggregator (sum / count-successes / keep-highest). | Roll (click/drag), and the pool size can be entered manually or driven by a Track's current value | — |
| **Track** | A bounded, ordered sequence of positions representing a stat you slide along (e.g. Might: 1–5, with a "death" floor and an overflow-above-max rule) — not just a number+modifier. Lives on an Actor's sheet. | Slide up/down by an effect's amount | Can drive a Die pool size (see Die) or resolve through a formula (raw D&D-style score → modifier) |
| **Actor** | A controllable entity — a player's character, or an NPC/monster controlled by another role. Owns a sheet of Tracks/resources and zero or more Tokens/Cards on the board. | — | Can belong to a **group** so one roll/move applies to several Actors at once (e.g. "the zombies") |
| **Board / Zone** | The table surface(s) — can be a single fixed background (classic VTT map) or an open area that Cards get placed onto to build the layout live (Betrayal's floors). A **Zone** is a named region with a visibility rule: `public`, `owner-only` (a hand, a secret role token), or `owner+host`. | — | Determines who a Card/Token's *contents* are broadcast to (see NETWORKING.md) |
| **Phase / Turn order** | The game can be in a named phase (e.g. "exploration" vs "haunt"). Each phase has its own turn-order sequence (plain round-robin, or a scripted sequence like "each hero, then the antagonist, then the antagonist's monsters"). | — | A trigger (GAME_DEFINITION.md) can switch phases mid-game, reassign roles, and reveal a Zone to specific players — this is how a scenario-level rule change (like the haunt) is expressed without new engine code |

This list is deliberately small. Two games that look nothing alike — a D&D-style sheet
with `/roll 1d20+dex` and a board-builder with custom pip dice and a secret traitor — are
both just particular starting layouts and trigger sets over the same handful of primitives.
See [GAME_DEFINITION.md](GAME_DEFINITION.md) for the authoring format and worked examples
of both.

### Two ways to set up a game

1. **Freeform sandbox, no game definition at all.** Import some Card images (a deck, a
   board), some Tokens, define a custom Die if you want one, and play — exactly like
   sitting at a physical table, with the host doing no automation. This alone covers
   *any* tabletop game, at the cost of players doing their own bookkeeping (which is what
   they'd do at a physical table anyway).
2. **Declarative game definition (YAML/JSON).** Optionally describe the game's fixed
   content (card sets, custom dice, tracks, tile connectors, starting layout) and a short
   list of `when X happens, do Y` triggers for the tedious, mechanical bookkeeping (draw
   a card on entering a tile, roll dice on an event, reveal a zone when a phase changes).
   This is data, not a scripting language — see GAME_DEFINITION.md for why that ceiling
   is deliberate and how far it goes.

## Components

```
┌─────────────────────────────────────────────────────────────┐
│                      FastAPI server                          │
│  - session auth for admins (cookie)                          │
│  - user management (admin-only invite/create)                │
│  - room registry (id, name, password hash, game def, host)   │
│  - game definition library (bundled + uploaded YAML/JSON)     │
│  - asset store (card/tile/token images, static files on disk)│
│  - WS endpoint: signaling + presence + recovery snapshot     │
└───────────────┬───────────────────────────────┬──────────────┘
                │ WebSocket (signaling)          │ WebSocket (signaling)
        ┌───────▼────────┐                ┌──────▼─────────┐
        │  Host browser   │◄──WebRTC DC───►│ Player browser │
        │ (canonical state)│               │ (thin client)  │
        └────────────────┘                └────────────────┘
                                     ▲ additional players connect
                                     │ star-topology to the same host
```

See [docs/NETWORKING.md](NETWORKING.md) for the signaling protocol and sync model in
detail.

### Server responsibilities

- **Auth.** Bootstrap `admin`/`admin` on first run (`must_change_password = true`).
  Session-cookie auth for the admin dashboard. Admins create other user accounts
  (username + temp password, or an invite link); there is no public signup route.
- **Rooms.** Admin-only creation: name, game definition selection (bundled or upload),
  optional room password. Returns a room code / shareable URL (`/room/{slug}`). Room
  membership itself needs no account.
- **Game definitions.** Store bundled example game definitions and any uploaded
  per-room custom ones (see [GAME_DEFINITION.md](GAME_DEFINITION.md)). Served to clients
  on room join.
- **Assets.** Store uploaded card/tile/token images under `data/uploads/`, serve
  statically. Ship a small bootstrap set (blank grid board, a generic playing-card
  back/deck, generic token shapes) so a room is usable with zero uploads.
- **Signaling & recovery.** One WebSocket per connected browser, scoped to a room.
  Relays WebRTC offer/answer/ICE between the host and each joining peer. Also accepts
  periodic opaque state snapshots from the host (table state + chat log) purely for
  recovery — the server does not parse them — so a reconnecting or promoted host doesn't
  lose state.

### Client responsibilities

- Render the shared table (PixiJS): pan/zoom, arbitrary Cards/Tokens/Dice, per-board
  optional grid overlay and optional snap-to-grid placement (a rendering/placement mode
  on a Board or a Card, not a hardcoded RPG feature). Pixel-art visual style throughout
  (see "Visual style" below) — this is a rendering choice, independent of the object
  model, so any uploaded card/tile art still just works even if it isn't pixel art.
- Run the object model: card move/rotate/flip, stack merge/split/shuffle/draw/deal, piece
  placement/connector-snapping, die rolls and pools, track sliders, zone visibility.
- Interpret a room's game definition, if any: starting layout, custom dice/cards/tracks,
  and triggers.
- Chat log, including `/roll` results and card-draw announcements.
- WebRTC connection management: host serves state to peers; peers send input actions to
  the host and render whatever state the host broadcasts back.
- Persist the player's own display name / last-joined rooms in `localStorage` for
  reconnect convenience. No account needed.

## Visual style

The client is pixel-art themed: bundled bootstrap assets (the generic token shapes, card
backs, default board) are authored as low-resolution sprites (e.g. 32×32/64×64) scaled up
crisply, and the UI chrome (chat, sheets, dialogs) uses a bitmap/pixel font, not a
smooth-scaling one. Concretely:

- PixiJS textures use `SCALE_MODES.NEAREST` (no bilinear smoothing) so scaling up never
  blurs a sprite.
- Table zoom is free (drag to any level), but the renderer snaps the *effective* pixel
  scale to integer multiples of each sprite's native resolution where practical, so art
  stays crisp rather than shimmering at fractional zoom — a common pixel-art-renderer
  technique, not a gameplay constraint.
- This is a rendering default, not a requirement on content: a user-uploaded card/tile
  image in any style (a scanned photo, a painted illustration) still displays fine — it
  just won't get the crisp-scaling treatment a native pixel-art asset does.
- Rotation (cards/pieces can be rotated freely per the object model) uses ordinary
  sub-pixel rotation; pixel-perfect rotation snapping is a nice-to-have, not required.

## Repo layout

```
rpg-tabletop/
  run.sh                     # server-watcher entrypoint
  watcher.config.json
  requirements.txt
  app/                       # FastAPI backend
    main.py                  # app factory, mounts frontend/dist as static
    auth.py                  # session auth, password hashing, bootstrap admin
    users.py                 # admin-only user CRUD/invites
    rooms.py                 # room CRUD, join/password check
    game_defs.py             # load bundled + uploaded game definitions
    assets.py                # upload/serve card/tile/token images
    signaling.py             # WS endpoint: join/offer/answer/ice/snapshot
    db.py                    # sqlite connection + schema
    models.py
  game-defs/                 # bundled example game definitions (committed)
    generic-freeform.yaml
    dnd5e-srd.yaml
    betrayal-house-on-the-hill.yaml   # partial, see GAME_DEFINITION.md
  data/                      # runtime state (gitignored, created at first run)
    db.sqlite3
    uploads/
  scripts/
    create_user.py           # admin CLI for account creation (mirrors invite flow)
  frontend/
    src/
      net/                   # signaling.ts, webrtc.ts, protocol.ts
      engine/                # card.ts, stack.ts, piece.ts, token.ts, dice.ts, track.ts, board.ts, trigger.ts
      ui/                    # chat.tsx, sheet.tsx, lobby.tsx, admin.tsx (Preact)
      main.ts
    dist/                    # committed build output — see README §Stack
    package.json
    vite.config.ts
  docs/
```

## Data model (SQLite)

Only durable, server-owned facts live here — never gameplay state.

```
users
  id, username, password_hash, is_admin, must_change_password, created_at

rooms
  id, slug, name, owner_user_id, game_def_id NULL, password_hash NULL, created_at

game_defs
  id, name, source ('bundled'|'uploaded'), room_id NULL (NULL = shared/bundled),
  format ('yaml'|'json'), body, created_at

assets
  id, room_id, kind ('card'|'tile'|'token'|'board'), filename, uploaded_by, created_at
```

`rooms` and `game_defs`/`assets` are the only cross-session state the server keeps; a
room's live table state (card positions, track values, chat history) is never written
here — only the host-supplied recovery snapshot, held in memory (or a single `snapshot`
blob column), which is discarded once the room has been empty for a while.

## Room lifecycle

1. Admin logs in, creates a room (name, game definition, optional password) →
   gets `/room/{slug}`.
2. Admin (or anyone with the link) opens `/room/{slug}`, enters a display name (+ room
   password if set) → server issues a short-lived, room-scoped guest token and opens a
   signaling WebSocket.
3. The first client to open the room becomes **host** (typically the admin who created
   it). The server tells later joiners who the current host is.
4. Joining clients exchange SDP/ICE with the host over the signaling WS, establish a
   WebRTC data channel, and receive a full state snapshot directly from the host.
5. Gameplay proceeds peer-to-peer. The host periodically (and on significant changes)
   ships an opaque snapshot to the server over the signaling WS, for recovery only.
6. If the host disconnects, the server picks the next-longest-connected peer as host
   candidate and hands it the last snapshot to resume from (see NETWORKING.md).

## Deployment (server-watcher compliance)

The app is deployed by [server-watcher](https://watcher.staery.com/spec), which
guarantees only `bash`, `git`, and `python3` (+ `venv`/`pip`) on the host — no Node,
no root, no `apt`. Consequences for this project:

- `run.sh` creates/activates a `.venv`, `pip install -r requirements.txt`, then
  `exec uvicorn app.main:app --host "$HOST" --port "$PORT"` (foreground, logs to
  stdout/stderr, binds to the injected `$HOST:$PORT`, i.e. `127.0.0.1`).
- `watcher.config.json` sets `health_check_path` to a cheap `/healthz` route.
- The frontend is built locally/in CI with `npm run build`; **`frontend/dist/` is
  committed to git** and served by FastAPI's `StaticFiles(..., html=True)` mounted at
  `/`. There is no npm/node step in `run.sh`.
- SQLite needs no separate service and no root to install (ships in the stdlib).
