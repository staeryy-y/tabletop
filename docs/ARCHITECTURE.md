# Architecture

## Principles

1. **The server is a coordinator, not a game engine.** It never interprets game state —
   what's a legal move, whose turn it is, what a card says. Its job is: accounts, room
   bookkeeping, and WebRTC signaling — nothing more. It holds no game assets and no game
   state; see principle 6.
2. **Gameplay state lives in the browser.** The room's *host* peer (whoever opened the
   room) holds the canonical table state in memory and is the source of truth for
   everyone else, connected directly over WebRTC.
3. **No account required to play.** Accounts exist only to gate *room creation*. Joining
   a room is a display name (+ room password, if the admin set one).
4. **A digital prop box, not a rules engine.** The engine models a handful of physical
   primitives (cards, tokens, dice, tracks, boards) the same way a real table does — full
   stop. It has no concept of turns, phases, roles, or win conditions, and doesn't try to
   understand what a card's text means or automate what should happen next; a GM and
   players handle all of that themselves, the way they already would at a physical table.
   See [GAME_DEFINITION.md](GAME_DEFINITION.md) "Why no rules layer?" for why that's the
   right ceiling, and how it's still enough to set up something as unusual as *Betrayal at
   House on the Hill* or *Avalon*'s hidden roles, alongside a D&D-style character sheet.
5. **Works within server-watcher's constraints.** No Node/build tooling at deploy time,
   no root, no background daemons — see "Deployment" below.
6. **Game packages (rules + assets) are portable files, not a server-hosted library.**
   A game definition's card/tile/token images travel the same way everything else does —
   peer-to-peer, from the host — not fetched from the server. The server never stores or
   serves a single uploaded image; see "Game packages" in
   [GAME_DEFINITION.md](GAME_DEFINITION.md) and "Asset distribution" in
   [NETWORKING.md](NETWORKING.md). This keeps the server genuinely lightweight: a room
   and an account are a few rows in SQLite, full stop.

## Object model

Everything on the table is one of a small number of primitive types, synced as part of
the host's game state. This is the layer that makes the system game-agnostic — a specific
game is just a starting arrangement of these (GAME_DEFINITION.md), not bespoke code, and
not a set of rules the engine understands or enforces.

| Primitive | What it is | Free manipulation (any player) | Special behavior |
|---|---|---|---|
| **Card** | A deck/hand object: a front face and a back face (image and/or text), a position, a rotation, and a face-up/face-down state. Playing cards, event/item/omen cards, reference sheets. | Move, rotate, flip, **hide** — always, no ownership lock (see "Trust model" in NETWORKING.md) | When 2+ cards land on top of each other they merge into a **Stack**; while hidden, only the hider's own client renders its front — see "Hiding a card" below |
| **Stack** | An emergent, ordered pile of Cards. Not authored directly — it's what a pile of Cards *becomes*, and stays "live" for as long as they're piled: cards dropped on each other anywhere on the table re-merge. | Drag the top card off to pull it back out as a standalone Card | Gains pile-only operations: **shuffle**, **draw** (top/bottom/random), **deal** (to zones/seats), **cut**, **peek** (subject to the zone it's in — see Zones) |
| **Piece** | A board-building or generic movable object that is *not* a deck member: a room/terrain tile, a board section, a standee. Optionally has **connectors**, purely as a placement aid — dragging it near an open connector snaps it into alignment, like a jigsaw piece's shape. May start in a face-down draw pile (shuffle/draw work the same as a Card Stack), but once placed it's just moved/rotated — placed Pieces never re-merge into a stack the way Cards do; several overlapping (e.g. a pawn standing on a tile) just z-order. | Move, rotate, place | Connector-aware placement can auto-snap to an open edge; whether a placement is otherwise *legal* by a specific game's rules is left to the players to judge |
| **Token** | A small marker that rides on a Card or Piece: a pawn, a status marker, an item-pile flag. Toggles between a short list of named states (e.g. "stunned" / "active") rather than a free flip or full movement. | Move, cycle its state | Usually one per Actor, or a handful of shared markers |
| **Die** | A named face set (not limited to d4/d6/d20 — a face can be a number, a symbol, or blank) plus a current rolled value. A *pool* of N dice of one type can be rolled together and combined with an aggregator (sum / count-successes / keep-highest). | Roll (click/drag), and the pool size can be entered manually or driven by a Track's current value | — |
| **Track** | A bounded slider representing a stat's current position (e.g. Might: 1–5) — not just a number+modifier. Lives on an Actor's sheet, clamps to its declared range like a physical stat clip hitting its printed ends. | Slide up/down freely — same no-ownership-lock trust model as Cards (see NETWORKING.md "Trust model"); a player can adjust their own or another Actor's Track, the same way a physical player hands over coins or slides someone else's clip when a card tells them to | Can drive a Die pool size (see Die) or resolve through a formula (raw D&D-style score → modifier) — arithmetic shortcuts, not game logic; what hitting either end of a track *means* is for the players to notice |
| **Actor** | A controllable entity — a player's character sheet, or an NPC/monster piece the GM controls. Owns a sheet of Tracks/resources and zero or more Tokens/Cards on the board. | — | Can belong to a **group** so one roll/move applies to several Actors at once (e.g. "the zombies") |
| **Board / Zone** | The table surface(s) — can be a single fixed background (classic VTT map) or an open area that Pieces get placed onto to build the layout live. A **Zone** is a named region with a visibility rule: `public`, `owner-only` (a hand), or `owner+host`. | — | Determines who a Card's *contents* are broadcast to (see NETWORKING.md) |

This list is deliberately small, and deliberately stops there — no turns, phases, roles,
or win conditions. Two games that look nothing alike — a D&D-style sheet with
`/roll 1d20+dex` and a board-builder with custom pip dice and a hidden traitor — are both
just particular starting arrangements of the same handful of primitives; everything about
how each is actually *played* is left to the humans, the same as at a physical table. See
[GAME_DEFINITION.md](GAME_DEFINITION.md) for the authoring format, worked examples, and
"Why no rules layer?" for why that boundary is deliberate.

### Hiding a card

Any player can right-click a Card and toggle **Hide** on it — no game definition, Zone,
or setup required. While hidden: the hiding player's own client renders the card's true
front face, plus a small eye icon only they see, as a self-reminder that they're the one
keeping it secret; every other player's client renders only its back, regardless of the
card's actual flip state. Nothing about the hidden state itself leaks to others — a
hidden card looks exactly like an ordinary face-down one to everyone but the hider,
matching how a player holding a card close to their chest looks the same as one who just
hasn't flipped it yet. Like a Zone (below), this is enforced by never sending the true
front-face content to any peer but the hider in the first place — not by hiding it in the
UI after broadcasting it — so there's nothing to inspect even if a player tried; see
NETWORKING.md "Trust model."

This is the same underlying visibility mechanism a **Zone**'s `owner-only` setting uses,
just applied ad hoc to a single card by whoever's holding it instead of declared for a
whole named region up front: a "my hand" Zone is really "auto-hide every card placed
here from everyone but its owner." The manual toggle is what makes secrecy available in
the bare freeform sandbox with zero authoring; Zones are the same capability formalized
for a game definition that wants a standing private hand, a computed role reveal, or a
role-set of owners. See [GAME_DEFINITION.md](GAME_DEFINITION.md) "Zones."

### Two ways to set up a game

1. **Freeform sandbox, no game definition at all.** Import some Card images (a deck, a
   board), some Tokens, define a custom Die if you want one, and play — exactly like
   sitting at a physical table. This alone covers *any* tabletop game.
2. **Declarative game definition (YAML/JSON).** Optionally pre-declare the game's fixed
   content — card sets, custom dice, tracks, tile connectors, starting layout — so the
   room opens with the right pieces already on the table instead of everyone importing
   them by hand. It is *only* content: no turns, phases, roles, or "when X happens, do Y"
   rules — see [GAME_DEFINITION.md](GAME_DEFINITION.md) "Why no rules layer?" for why.

### Roles: GM vs. players

The account that created the room is always that room's **GM** — independent of which
peer is currently the technical **host** holding canonical state (below/NETWORKING.md).
These are two different concerns: host is about whose browser everyone else's state
syncs from; GM is about who's allowed to reach outside what's currently on the table. Any
connected player can already freely manipulate whatever's there — move/rotate/flip/hide
any Card, slide any Track, roll any die (see NETWORKING.md "Trust model") — but only the
GM can:

- **Spawn** a new Card/Piece/Token/Die onto the table at will — pull a blank card, drop
  in an extra monster token, add a die type mid-session — without going through a draw
  pile. This is the digital equivalent of a GM reaching into the box for something not
  currently in front of the players.
- **Despawn** (delete) any object.
- **Peek** at any hidden Card or Zone regardless of ownership — a physical GM can always
  look if they need to; this is that same authority, not a way to enforce anything.

The GM identity is **attested by the server**, not asserted by a peer — the server
already knows the room's owning account (`rooms.owner_user_id`) and tells every peer,
alongside who the current host is, which connected peer (if any) is the GM. This is the
one place the account system reaches into an otherwise fully P2P session; see
NETWORKING.md "GM attestation."

## Components

```
┌─────────────────────────────────────────────────────────────┐
│                      FastAPI server                          │
│  - session auth for admins (cookie)                          │
│  - user management (admin-only invite/create)                │
│  - room registry (id, name, password hash, game def ref, host)│
│  - WS endpoint: signaling + presence + recovery snapshot     │
└───────────────┬───────────────────────────────┬──────────────┘
                │ WebSocket (signaling)          │ WebSocket (signaling)
        ┌───────▼────────┐                ┌──────▼─────────┐
        │  Host browser   │◄──WebRTC DC───►│ Player browser │
        │ (canonical state  │  (state + assets) │ (thin client)  │
        │  + game package) │               │                │
        └────────────────┘                └────────────────┘
                                     ▲ additional players connect
                                     │ star-topology to the same host
```

Note what's *not* in that box: no asset store, no game-definition library. A room's
game package (rules + images) lives in the host's browser, loaded from a local file or
one of the small bundled examples shipped as static files in the repo — never uploaded
to or stored by the server. See "Game packages" (GAME_DEFINITION.md) and "Asset
distribution" (NETWORKING.md).

See [docs/NETWORKING.md](NETWORKING.md) for the signaling protocol and sync model in
detail.

### Server responsibilities

- **Auth.** Bootstrap `admin`/`admin` on first run (`must_change_password = true`).
  Session-cookie auth for the admin dashboard. Admins create other user accounts
  (username + temp password, or an invite link); there is no public signup route.
- **Rooms.** Admin-only creation: name, a reference to which game package is in play
  (one of the small bundled examples, or "custom" if the admin's client will supply one),
  optional room password. Returns a room code / shareable URL (`/room/{slug}`). Room
  membership itself needs no account. The server stores this reference and nothing else
  about the package — no rules text, no assets — see "Game packages"
  (GAME_DEFINITION.md).
- **Bundled examples only, as plain static files.** The handful of example game
  packages this repo ships (`game-defs/`) are committed files served the same way
  `frontend/dist/` is — `StaticFiles`, no database, no upload path. A custom package an
  admin brings never touches the server at all; it's loaded client-side from a local
  file and P2P-distributed from there (see NETWORKING.md "Asset distribution").
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
- Run the object model: card move/rotate/flip/hide, stack merge/split/shuffle/draw/deal,
  piece placement/connector-snapping, die rolls and pools, track sliders, zone visibility.
- Load a game package (a bundled example, fetched as a static file, or a custom one from
  a local file the admin picks) and hold it in memory; if this client is host, serve the
  package's assets to joining peers over the data channel. Export the room's current
  package back out as a downloadable file at any time — a pure local operation, no
  server round trip.
- Interpret a room's game definition, if any, to lay out its starting content
  (custom dice/cards/pieces/tracks) — nothing beyond content, per GAME_DEFINITION.md.
- Chat log, including `/roll` results.
- WebRTC connection management: host serves state to peers; peers send input actions to
  the host and render whatever state the host broadcasts back.
- Persist the player's own display name / last-joined rooms in `localStorage` for
  reconnect convenience. No account needed.

## Visual style

The client is pixel-art themed: the generic fallback visuals used when no game package
supplies its own (a blank grid board, a plain token shape, a generic card back) ship as
part of `frontend/dist` itself, like the pixel/bitmap UI font — client-bundle assets, not
game content, so they need no game package, no server, and no upload to be present.
They're authored as low-resolution sprites (e.g. 32×32/64×64) scaled up crisply, and the
UI chrome (chat, sheets, dialogs) uses that same bitmap/pixel font, not a smooth-scaling
one. Concretely:

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
    main.py                  # app factory, mounts frontend/dist + game-defs as static
    auth.py                  # session auth, password hashing, bootstrap admin
    users.py                 # admin-only user CRUD/invites
    rooms.py                 # room CRUD, join/password check — stores a game-def *reference* only
    signaling.py             # WS endpoint: join/offer/answer/ice/snapshot
    db.py                    # sqlite connection + schema
    models.py
  game-defs/                 # bundled example game packages (committed, served as static files)
    generic-freeform.yaml            # no assets needed
    dnd5e-srd.yaml                   # no assets needed
    poker-5-card-draw/
      manifest.yaml
      assets/                        # card face/back images referenced by manifest.yaml
    mafia-werewolf/
      manifest.yaml
      assets/
  data/                      # runtime state (gitignored, created at first run)
    db.sqlite3                       # accounts + room metadata only — no assets, ever
  scripts/
    create_user.py           # admin CLI for account creation (mirrors invite flow)
  frontend/
    src/
      net/                   # signaling.ts, webrtc.ts, protocol.ts
      engine/                # card.ts, stack.ts, piece.ts, token.ts, dice.ts, track.ts, board.ts
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
  id, slug, name, owner_user_id, game_def_ref, password_hash NULL, created_at
  -- game_def_ref is either "bundled:<name>" (one of the committed game-defs/ packages)
  -- or "custom" (the host's browser supplies the actual package at join time — the
  -- server never sees its rules text or assets, only that the room uses a custom one)
```

That's the whole schema — no `game_defs` or `assets` table; a room's actual rules text
and every image it uses live only in browsers, never in this database. `rooms` is the
only cross-session state the server keeps at all: a room's live table state (card
positions, track values, chat history) is never written here either — only the
host-supplied recovery snapshot, held in memory (or a single `snapshot` blob column),
which is discarded once the room has been empty for a while.

## Room lifecycle

1. Admin logs in, creates a room: name, optional password, and a game package — either
   picks one of the bundled examples, or picks a package file from their own computer
   (in which case only their browser ever holds its rules/assets; the server just
   records `game_def_ref = "custom"`) → gets `/room/{slug}`.
2. Admin (or anyone with the link) opens `/room/{slug}`, enters a display name (+ room
   password if set) → server issues a short-lived, room-scoped guest token and opens a
   signaling WebSocket.
3. The first client to open the room becomes **host** (technical state authority).
   Separately, the server tags whichever connected peer is logged in as the room's
   owning account as the **GM** (see "Roles" above) — in the common case that's the same
   person, since the admin usually opens their own room first, but it isn't required to
   be: a GM joining after someone else is already host doesn't disrupt hosting, and a
   room with no GM connected simply has no spawn/override privileges available. The
   server tells every peer both who the current host is and who (if anyone) is GM.
4. Joining clients exchange SDP/ICE with the host over the signaling WS, establish a
   WebRTC data channel, and receive a full state snapshot **and the complete game
   package (rules + every asset)** directly from the host — not fetched from the server,
   and not fetched lazily per-asset either, so that any peer already has everything it'd
   need if it were later promoted to host itself. See NETWORKING.md "Asset distribution."
5. Gameplay proceeds peer-to-peer. The host periodically (and on significant changes)
   ships an opaque game-*state* snapshot to the server over the signaling WS, for
   recovery only — never the package/assets, which the server never touches.
6. If the host disconnects, the server picks the next-longest-connected peer as host
   candidate and hands it the last snapshot to resume from (see NETWORKING.md). That peer
   already has the full game package from step 4, so it can resume hosting without
   needing to fetch anything from anywhere.

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
- There's no `data/uploads/` and nothing for the server to garbage-collect: game
  packages and their assets never touch disk on this end at all (see principle 6 above).
  `db.sqlite3` — accounts and room metadata — is the server's entire persistent footprint.
