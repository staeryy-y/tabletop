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

The server only ever stores accounts and room metadata (a couple of small tables) — low
volume, single-process, no concurrent-write contention worth a client/server DB. SQLite
ships in the Python stdlib, needs no service to install or root to run, and matches every
sibling project in this workspace (file-uploader, journal, splitter, etc.). See D14 for
why that's *all* it stores — no rulesets or asset bytes, unlike an earlier version of
this design.

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

## D11 — No rules/flow layer at all: no scripting, and no trigger system either
(revised)

An earlier version of this decision proposed a small, fixed, data-only trigger
vocabulary (`when X happens, do Y`) as the middle ground between "no automation" and "a
full scripting language" — reasoning that Betrayal's 50 haunts needed *some* automated
bookkeeping (draw-on-entry, reveal-to-role, phase switches) and a fixed action list would
cover the common cases without the sandboxing burden of real scripting. On reflection
(prompted directly: "the goal isn't to simulate the games, it's just to allow the players
to move things around like they would on a tabletop"), that middle ground was still
solving the wrong problem. A trigger system — however small and data-only — is still the
engine forming an opinion about what should happen next, which is a fundamentally
different (and open-ended) project from giving people physical-feeling objects to move
around themselves. The corrected position: **the engine has no concept of turns, phases,
roles, or win conditions, full stop** — not "a small fixed set of them." A GM and players
provide 100% of game flow themselves, the same as at a physical table; the engine's
entire job is objects (Card/Piece/Token/Die/Track/Zone) behaving the way their physical
counterparts do. See GAME_DEFINITION.md "Why no rules layer?" This is consistent with
D6/D9's cooperating-players assumption for a different reason than originally stated:
it's not that under-enforcing costs nothing to a trusted group (true, but beside the
point) — it's that there's nothing here to enforce in the first place, since the engine
was never meant to know the rules.

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

## D13 — GM is a role bound to the room-creating account, decoupled from "host"

The room's creator is always its GM, independent of which peer happens to be the
technical host holding canonical state (D3's star topology) — these solve different
problems. Host is a networking concern (whoever's state everyone else's client trusts
and syncs deltas from) and can migrate on disconnect. GM is a permissions concern (who
may spawn/despawn objects or peek at anything hidden) and is
simply re-attested by the server on every connection, based on `rooms.owner_user_id` — it
never needs migration logic of its own, and it survives the GM's own reconnects without
depending on connection order the way host election does. Tying it to the account system
means it's the one place server-known identity is allowed to affect an otherwise fully
P2P session — everything about manipulating what's *already* on the table stays purely
peer-trust-based (see NETWORKING.md "Trust model"); only bringing new things into
existence, removing them, or seeing something hidden needs the server's word for who's
allowed. Host election prefers a connected GM as the promotion candidate when the current
host
drops, since it's a natural continuation of "the GM already runs the table" (see D3), but
that's a nicety — GM-gated actions are checked against the server-attested `gmPeerId` by
whoever the current host is, regardless of whether the GM is that host.

## D14 — Game packages (rules + assets) are P2P-distributed files; the server stores none
of it

Requested explicitly: extend "mostly P2P" (D3) to cover assets too, not just game state.
A room's card/tile/token images now travel host-to-peer over the data channel, the same
star topology as everything else, and are never uploaded to or served by the server —
`data/uploads/` and the `assets`/`game_defs` tables from an earlier version of this design
are gone. The server's only remaining involvement is (a) serving the handful of bundled
example packages as plain static files, exactly like `frontend/dist/` — no database, no
upload path — and (b) recording, per room, whether it's using a bundled example or "a
custom one" (`rooms.game_def_ref`), never the custom one's actual content. The tradeoff
this accepts: a custom package that every holder has left the session without exporting
is gone — there's no server-side copy to fall back to. That's judged acceptable in
exchange for a genuinely asset-free, single-table server; see NETWORKING.md "Asset
distribution" for why sending the *full* package to every joiner up front (rather than
fetching assets lazily on demand) also avoids a subtler problem: a peer promoted to host
later needs to already have everything, not just what it happened to need so far.

## D15 — Zones stay just public/owner-only/owner+host; hidden-role games need nothing
more than per-card Hide (revised)

An earlier version of this decision added role-set Zone ownership and a computed,
optionally-ambiguous reveal-query mechanism to Zones, reasoning that *Avalon*'s
overlapping hidden knowledge (Evil knows Evil; Merlin knows Evil except Mordred;
Percival knows {Merlin, Morgana} but not which is which) needed the engine to compute
"who secretly knows what about whom." Directly challenged on this ("doesn't hidden card
viewing suffice? ... the goal isn't to simulate the games") — and correctly: a player
needing to know their *own* role is exactly what per-card Hide already provides (deal a
face-down role Card, its owner Hides it), and the cross-player knowledge Avalon's ritual
exists to grant — evil knowing evil, Merlin knowing evil — is not something the engine
needs to compute at all. It's something the GM or group arranges themselves (a private
message, a verbal agreement), the same as the physical ritual it replaces, just without
needing the ritual's choreography since there's no paper to protect. See
GAME_DEFINITION.md "Why no rules layer?" and its Avalon design-validation note. Betrayal's
Quest-card submission (secret, then shuffled, then revealed) still needed *nothing new
at all* even before this walk-back — it's exactly a Card Stack — which was itself the
first sign the more elaborate machinery wasn't earning its keep.

## D16 — Per-card Hide is a base primitive; there is no `simultaneous-reveal` Zone mode

Any single Card can be hidden ad hoc via a right-click toggle, with no Zone or game
definition involved at all — the hider's own client renders its front (plus a private
eye-icon reminder), everyone else's renders only its back, enforced the same
non-broadcast way as a Zone (see NETWORKING.md "Trust model"). This is the one piece of
the earlier, more elaborate Zone design (D15) that survives, because it's not game-flow
automation — it's a physical behavior (holding a card so only you can see it) that has
nothing to do with any specific game's rules. What did *not* survive: a
`simultaneous-reveal` Zone timing mode originally added for secret-ballot voting
(Avalon's team vote). Under the cooperating-players assumption (NETWORKING.md "Trust
model"), enforcing "hidden until everyone's submitted" was solving a problem that
doesn't exist here — players who won't cheat also won't peek at a pile of face-down
ballots before the group agrees to flip them, the same social contract that makes a
physical secret ballot work with no mechanism at all. A vote, if a game wants one, is
just players placing Cards face-down and flipping them together by agreement.
