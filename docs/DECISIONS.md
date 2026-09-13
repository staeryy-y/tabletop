# Decisions

Numbered log of choices that weren't fully dictated by the requirements, and why. Revisit
if a listed assumption stops holding.

## D1 — Client stack: Vite + TypeScript, PixiJS for canvas, Preact for UI chrome

Needed a WebGL-backed 2D canvas for a pannable/zoomable map with draggable tokens at
reasonable frame rates — plain `<canvas>` 2D is workable but PixiJS gives sprite batching,
hit-testing, and a scene graph for free. For the surrounding UI (chat, sheets, lobby,
admin dashboard) a full React would be heavier than this needs; Preact (~3KB) gives
components/state without the weight, and its API is close enough to React that it's not
an unusual choice. Both are plain npm deps built by Vite — no runtime dependency on either
at request time.

## D2 — Build output committed to git, no Node at deploy time

server-watcher's guaranteed host baseline is `bash`, `git`, `python3`(+venv/pip) only —
no Node, no root to install it, no guaranteed `curl`/`tar` to vendor a portable Node
build either. Rather than have `run.sh` fetch a Node binary at deploy time (possible per
the spec's example, but one more moving part and one more thing that can break on a
redeploy), `frontend/dist/` is built locally/in CI and committed, matching the pattern
already used in `3d-model-viewer` in this workspace. `run.sh` never touches `npm`.

## D3 — Host-authoritative star topology + WS-relay fallback instead of TURN

A full mesh (every peer to every peer) scales badly and complicates "whose state wins."
Making the room's opener the single source of truth mirrors how a GM already runs the
table and keeps sync conflicts from existing in the first place — the host decides.
Symmetric-NAT peers that can't complete a direct WebRTC handshake normally need a TURN
relay server; server-watcher's no-root/no-Docker host can't run one (coturn needs a
system package/daemon). Instead, a peer that fails P2P setup falls back to relaying the
*same* application-level messages through the existing FastAPI WebSocket. It's slower and
uses server bandwidth, but it needs no extra infrastructure and reuses a connection that
already exists for signaling. See NETWORKING.md.

## D4 — SQLite for server-owned data

The server only ever stores accounts, room metadata, rulesets, and asset filenames — low
volume, single-process, no concurrent-write contention worth a client/server DB. SQLite
ships in the Python stdlib, needs no service to install or root to run, and matches every
sibling project in this workspace (file-uploader, journal, splitter, etc.).

## D5 — Two-tier identity: accounts for admins, ephemeral tokens for guests

The spec requires accounts to be admin-invited only, but also requires zero-friction
joining for players. Rather than force every player through the account system (which
would contradict "no login required"), only room *creation* needs an account; joining a
room issues a short-lived, room-scoped guest identity (display name + random token,
persisted client-side for reconnects) that the server never asks a password for beyond
the room's own optional password.

## D6 — Roll results are computed and asserted by the roller, not re-validated by the host

Keeping the host as sole arbiter of every roll (host re-rolls on request) would remove
the one legitimate cheating vector but adds a round trip to every dice roll and makes the
host a bottleneck for something that should feel instant. Given the target use case
(private, cooperating groups — see NETWORKING.md "Trust model," now stated as an explicit
design assumption rather than a limitation), this is not really a tradeoff at all. The
protocol doesn't preclude switching a specific room to host-arbitrated rolls later.

## D7 — Grid/connector snapping is a per-Board or per-Piece setting, not a top-level mode

Originally scoped as two room-level toggles for a fixed VTT map (show grid / force
snap). Generalizing the object model (see [ARCHITECTURE.md](ARCHITECTURE.md) "Object
model") turned "grid" into one placement mode among several a Board or a Piece can use —
free placement, grid-snap, or connector-snap (Betrayal's tile edges) — configured where
the object is defined rather than as a single room-wide flag. The original motivating
case (a GM wants snap without visible grid lines, or vice versa) still holds; it's just
now two independent properties of a placement mode rather than two room settings.

## D8 — Game definition files are YAML (with JSON accepted as the same schema)

YAML for anything a GM/game-author hand-edits (comments, less punctuation, easier to
template from a rulebook) with no cost to also accepting plain JSON, since YAML is a
superset in practice for this schema's shape — an uploaded `.json` definition parses with
the same loader. No separate schema or code path per format.

## D9 — Generic object model (Card/Stack/Piece/Token/Die/Track/Actor/Zone) instead of an
RPG-specific engine

The original design was scoped around a fixed background map, grid-based tokens, and a
character-sheet roll grammar — workable for D&D, but it doesn't generalize: *Betrayal at
House on the Hill* needs a dynamically-built board, custom (non-d20) dice whose pool size
comes from a stat, stat *tracks* rather than number+modifier, three separate card decks,
and a mid-game rule swap with a secret role. Rather than special-case a second game, the
whole engine moved down a level of abstraction to the physical primitives every tabletop
game is actually built from (see ARCHITECTURE.md "Object model" and
[GAME_DEFINITION.md](GAME_DEFINITION.md)). This is deliberately modeled on how Tabletop
Simulator works — generic physical objects plus per-game configuration — but browser-only
and, per this project's original scope, still runs the network/account/room layer
underneath it rather than being a bare sandbox.

## D10 — Cards and Pieces are different primitives, not one "flat object" type

A first pass conflated them (a board tile is just a big Card). That's wrong for a
concrete reason: Cards need to *merge into a shuffleable Stack* when piled — that's the
whole point of a hand or a discard pile — while board-building objects (Betrayal's room
tiles, terrain, standees) are drawn from a pile once and then only ever moved/rotated;
piling two placed tiles together should never turn into "shuffle these two rooms." Rather
than add a flag to suppress stacking on certain Cards, Piece is its own primitive with its
own (non-stacking, connector-aware) placement behavior, and both can still originate from
the same underlying shuffle/draw-pile mechanic. See GAME_DEFINITION.md.

## D11 — Game definitions are a fixed, data-only trigger vocabulary, not a scripting
language

Betrayal alone has 50 haunts' worth of bespoke logic; a real per-game scripting layer
(Tabletop Simulator's Lua model) could express all of it, but at the cost of sandboxing
untrusted uploaded scripts and a large, ongoing engine surface. Instead, the engine
automates only the mechanical bookkeeping common to most tabletop games (shuffle, draw,
roll, track math, reveal-to-role) through a small fixed action vocabulary, and leaves a
specific scenario's unique judgment calls to the players — the same way a physical
rulebook or haunt booklet already expects a human to read and apply it. See
GAME_DEFINITION.md "Why not just script it?" This is consistent with D6/D9's cooperating-
players assumption: there's no adversary to defend the rules against, so under-enforcing
edge cases costs nothing a real tabletop group doesn't already tolerate.

## D12 — Pixel-art visual theme, as a rendering default rather than an object-model rule

Requested explicitly: the client's own bootstrap assets and UI chrome are pixel art
(nearest-neighbor-scaled sprites, a bitmap font), giving the app a distinct, consistent
look out of the box. This is implemented purely as a rendering layer choice (PixiJS
`SCALE_MODES.NEAREST`, integer-scale snapping where practical — see ARCHITECTURE.md
"Visual style") rather than a constraint baked into the object model or game-definition
format: a room using photographed/painted card art (e.g. a scan of real Betrayal cards)
still renders correctly, it just doesn't get the crisp up-scaling treatment native
pixel-art assets do. Keeping this a presentation detail, not a schema rule, avoids
coupling the generic engine to one game's/one project's specific aesthetic.
