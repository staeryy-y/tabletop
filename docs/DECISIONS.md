# Decisions

Numbered log of choices that weren't fully dictated by the requirements, and why. Revisit
if a listed assumption stops holding.

## D1 — Client stack: Vite + TypeScript, PixiJS for canvas, Preact for UI chrome

Needed a WebGL-backed 2D canvas for a pannable/zoomable table with draggable
cards/pieces/tokens at reasonable frame rates — plain `<canvas>` 2D is workable but
PixiJS gives sprite batching, hit-testing, and a scene graph for free.

**PixiJS over Phaser/Excalibur.js specifically:** those two are full *game engines* —
built-in physics, an opinionated Scene lifecycle that owns the update/render loop,
tilemap/animation-FSM/audio systems — aimed at building games with levels and win/lose
states. None of that fits a persistent, network-synced canvas of draggable objects with
no physics (dice results come from RNG, not simulated tumbling) and no game loop to
speak of (the host-authoritative object model in ARCHITECTURE.md is the source of
truth, not a local engine loop). Using either would mean fighting their state-ownership
assumptions to instead drive everything from our own synced object model, plus shipping
a physics engine and tilemap loader that never get used. PixiJS is a bare renderer with
no opinion about where state lives — told "draw this sprite here," which is exactly the
shape a WebRTC-synced scene graph needs — and it's the smaller, more mature dependency of
the three (Phaser 2 itself was built on top of Pixi).

For the surrounding UI (chat, sheets, lobby, admin dashboard) a full React would be
heavier than this needs; Preact (~3KB) gives components/state without the weight, and its
API is close enough to React that it's not an unusual choice. Both PixiJS and Preact are
plain npm deps built by Vite — no runtime dependency on either at request time.

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

## D13 — The GM is always host when connected; a non-GM peer may hold the role only until they join

The room's creator is always its GM — attested by the server, based on
`rooms.owner_user_id`, not asserted by a peer (see "GM attestation" below) — and,
whenever connected, is also always the technical **host**: the "master copy" of the
table lives in the room creator's browser. Even though the session is otherwise P2P,
it isn't a session of equals; one participant is privileged by construction. A non-GM
peer can still become a *temporary* host (see D3's star topology) if they open the room
before the GM ever does, so the table isn't unusable while waiting — but the instant the
GM connects, whether that's the very first join or long after someone else has been
hosting for a while, hosting transfers to them immediately (`RoomState.elect_host_on_join`
in app/signaling.py), the same `host-changed` message a disconnect-triggered migration
sends. If the GM later disconnects, `pick_next_host` picks a temporary replacement
(preferring a *different* connected GM if one somehow exists, otherwise the
oldest-joined peer) exactly as before — and the moment the real GM reconnects, the same
join-time promotion takes hosting straight back.

Tying host election to the account system this way — rather than "whoever's state
everyone else's client trusts" being a free-floating role decided purely by connection
order — means it's the one place server-known identity is allowed to affect an otherwise
fully P2P session. Everything about manipulating what's *already* on the table stays
purely peer-trust-based (see NETWORKING.md "Trust model"); only bringing new things into
existence, removing them, seeing something hidden, or being the authority everyone else
syncs from needs the server's word for who's allowed. GM-gated actions are still checked
against the server-attested `gmPeerId` by whoever the current host is — which, per this
decision, is normally the GM anyway, but the check stays in place for the brief windows
(before the GM joins, or between their disconnect and reconnect) where it isn't.

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

## D17 — Custom package transfer rides the existing table-sync link, not a second data channel

NETWORKING.md's transport-layer table calls for a *second* RTCDataChannel per peer
dedicated to asset transfer, separate from the one carrying table-sync traffic. The
actual implementation (net/packageTransfer.ts) doesn't do that: it reuses the same
PeerLink net/roomConnection.ts already manages for TableRequest/TableEvent messages,
distinguishing package-transfer messages from table-sync ones purely by a `type` prefix
(`RoomConnection.SideChannel`). A custom package's content (rules plus every card/piece
image, all embedded as data: URIs — see D14) is chunked and sent this way to whoever
doesn't already have it, whether that's a newly-joined peer or a peer that just became
host and needs to serve it onward.

The simplification is deliberate: negotiating a second data channel per peer (and,
for real WebRTC, a second round of local/remote description exchange) is real added
complexity for something that only ever runs once, briefly, right after a peer
connects — table-sync traffic and a handful of package chunks interleaving on one
channel is not a bandwidth or latency concern at that scale. If a room's packages grow
large and frequent enough that this stops being true, splitting them onto their own
channel is a contained change (a second PeerLink per peer) rather than a protocol
rewrite. Also intentionally *not* built, matching NETWORKING.md's own framing of these
as "nice-to-have, not required for v1": a cryptographic content hash, an IndexedDB
asset cache keyed by it, and any retry logic for a dropped chunk — a lost chunk just
means that attempt silently never completes, acceptable given the cooperating-players
trust model (NETWORKING.md "Trust model") and the fact that a package is requested once,
not continuously streamed.

## D18 — A host reloading resumes from its own browser's IndexedDB, not the server

The host's client already periodically uploads a recovery snapshot to the signaling
server (NETWORKING.md "Host migration"), but that exists for a narrower reason — so a
*different* peer can take over if the host is gone for good — and depending on it for
the far more common case (the host simply reloading their own tab) turned out to be
fragile in exactly the way relying on a server round trip for a same-machine event
always is: bound by the periodic upload interval's staleness window, and by whether a
best-effort flush on the tab's `pagehide` event actually completes before the
WebSocket tears down. A first attempt at hardening this made the server-side snapshot
durable across a process restart too (persisting it to SQLite) — but that was solving
the wrong layer: a host's own browser reloading doesn't need the server involved at
all to remember what it was just showing.

net/tableStore.ts persists the host's current table snapshot to that browser's own
IndexedDB, keyed by room slug, on the same cadence the server upload already used.
On becoming host (`you-are-host`), this local copy — if present — is preferred over
whatever the server last saw: it's guaranteed to be exactly this tab's own most recent
state, with no network involved and no staleness window. The server-side snapshot
remains exactly what it always was, unrevised: the fallback for a peer that has no
local copy of its own (a different peer being promoted, or a genuinely first-ever
host), not the primary mechanism for the same-browser-reload case. Server state is
still in-memory only (see D14) — a full server *process* restart still starts a room
fresh unless some peer's own browser still has it locally, which is an accepted
consequence of not persisting a game's actual state to the server (D14's real
concern), not an oversight this decision reopens.

## D19 — Anonymous rooms: no account needed, and genuinely zero server footprint

Accounts were originally required to create a room at all (D5's two-tier identity:
accounts for admins, ephemeral guest tokens for everyone else). Requested explicitly:
an account should no longer be *necessary* — anyone should be able to host a game with
no sign-up, the same way joining one already needs nothing but a display name — while
keeping the account system itself for whoever wants persistent rooms, user management,
or a saved room list on a dashboard.

The two kinds of room this creates are deliberately asymmetric, not just "anonymous
rooms have a blank owner field":

- An **accounted** room is a SQLite row (`owner_user_id` set), listed on the dashboard,
  deletable (`DELETE /api/rooms/{slug}`, new alongside this), and its GM is
  server-attested from that row exactly as D13 already describes.
- An **anonymous** room (`POST /api/rooms/anonymous`, no auth) is held entirely in
  `app/rooms.py`'s own in-memory `_anonymous_rooms` dict — never a SQLite row, at any
  point in its life. It has no GM at all (there's no account to attest one from —
  `room["owner_user_id"]` is simply `None`, guarded explicitly in
  app/signaling.py's `is_gm` computation so `None == None` can't silently make every
  not-logged-in guest "the GM" of a room nobody owns), so D13's host-follows-GM
  re-election never triggers for one — whoever joins first just stays host,
  `pick_next_host` picking the next-oldest if they leave, same as any room would work
  pre-D13. Its client also never uploads a recovery snapshot to the signaling server at
  all (`roomInfo.isAnonymous`, checked in `persistSnapshotIfHost`) — pointless, since
  app/signaling.py's `_handle_disconnect` discards the room's entire in-memory
  `RoomState` *and* its `_anonymous_rooms` entry the instant it goes empty, rather than
  keeping either the way an accounted room's snapshot is kept (see D18). This is the
  literal request: "no server uploads, no data scaling" — creating and abandoning any
  number of anonymous rooms leaves the server's persistent and in-memory footprint
  exactly as it would have been if none of them had ever existed. A custom game package
  still works the same for an anonymous room as an accounted one — it was always
  client-side/IndexedDB, never server-held, regardless of who owns the room (D14).

## D20 — Multi-select is client-local selection state plus two new pile-level requests

Requested: drag a box to select several cards, then move/rotate/flip/hide/collapse
them together. Selection itself (`selectedPileIds` in engine/table.ts) is never synced
— it's exactly like which card your own mouse happens to be hovering, purely local UI
state that means nothing to anyone else's browser, so it needed no protocol changes at
all. What *does* need to be synced is the result of acting on a selection, and that
turned out to need surprisingly little new protocol:

- **Move** — a new `move-pile` request/`TableModel.movePile`, deliberately simpler than
  the existing `pick-up-and-drop`: no stack-splitting, no merge-on-drop. Merging two
  piles just because a group drag happened to end near a third pile would be a strange,
  surprising side effect of a multi-select action; a group drag always keeps every
  selected pile as its own pile, just relocated.
- **Rotate** — no new request at all. Rotating the group rigidly around its centroid
  ("center of mass" per the request) is computed entirely client-side (rotate each
  pile's offset-from-centroid vector by the same delta, same rotation convention as the
  existing single-pile rotate handle — see engine/table.ts's `rotateVector`), then
  committed as one `move-pile` + one `set-rotation` per pile — both already existed.
- **Flip / hide** — no new request either: just the existing single-pile `flip`/
  `toggle-hide`, sent once per selected pile. A batch-flip protocol message would only
  save a handful of small WebSocket frames for a case (selecting many cards at once)
  that's already relatively rare, which isn't worth it — consistent with this project's
  existing "coarse and simple over perfectly batched" choice for hints (D-adjacent, see
  HINT_INTERVAL_MS's doc comment).
- **Collapse into a deck** — the one genuinely new operation, `collapse-into-stack`/
  `TableModel.collapseIntoStack`: merges N existing piles' cards (concatenated in
  selection order) into a single new pile under a fresh id, landing at the selection's
  centroid. A fresh id (never one of the originals) means callers never have to guess
  which of several merged piles is "the" survivor.

The box-select rectangle itself is computed in screen space, not world space, and
purposefully replaces the old click-drag-to-pan gesture (WASD/Q/E already cover
panning/rotating the camera — see engine/camera.ts): the camera can be rotated, so an
axis-aligned rectangle only means "what's visually inside this box" in screen-space
coordinates, not world-space ones.

## D21 — Pieces are a separate object family from Cards, not a variant of Pile

Pieces (`PieceSet`/`PieceEntry` in packages/gamePackage.ts) had existed in the package
data model and editor since early on, but nothing ever turned one into an actual
on-table object — a long-standing, repeatedly-noted gap. Closing it raised one real
design choice: model a Piece as a `PileState` with a single, never-flippable,
never-hideable card (reusing all the existing Pile/sync-protocol machinery), or give it
its own, smaller, parallel model.

Reuse lost to a dedicated `PieceState` (engine/pileModel.ts) with its own sync-protocol
requests/events (`spawn-piece`/`move-piece`/`rotate-piece-by`/`set-piece-rotation`/
`remove-piece`, `piece-upserted`/`piece-removed`) and rendering (engine/piece.ts,
mirroring card.ts's image-loading/caching approach). The deciding factor is
docs/GAME_DEFINITION.md's own framing: "the only thing that's different from a Card is
the absence of stack/shuffle semantics once it's on the table" undersells it — a Piece
also has no flip, no Hide, and (per that same doc) *never* merges with another Piece
even on visual overlap, which is precisely the behavior `dropPile`'s merge-radius
check exists to provide for Cards. Reusing PileState would mean either quietly
disabling half of what makes a Pile a Pile (special-casing it everywhere: redaction,
merge, flip, the multi-select group operations) or leaving those paths reachable for
something the spec says should never do them. A parallel model needs more surface area
(its own request/event variants, its own map in TableModel, its own render module) but
none of it is conditional — every method that exists always applies, and nothing needs
a runtime check for "is this actually a Piece."

Consequences of the split, kept deliberately narrow for this first cut:
- No per-recipient redaction for pieces at all (`emitTouchedPieces` in
  syncProtocol.ts) — there's no Hide equivalent to redact.
- No live drag-hint/rotate-hint preview for a Piece gesture (unlike a Card drag) — only
  the final `move-piece`/`set-piece-rotation` request on release. Other players see a
  piece jump to its final spot rather than glide, a minor cosmetic gap versus a Card's
  smoother live preview, judged not worth the added protocol surface for a first cut.
- Multi-select (D20) covers Cards only, per that feature's own explicit request
  ("select multiple cards") — box-select doesn't consider pieceViews at all.
- A package's `draw_pile: true` piece mode (GAME_DEFINITION.md: a face-down pile of
  tiles a player draws from by hand, reusing shuffle/draw the same way a Card Stack
  does) and connector-snapping placement aid are both still unbuilt — this decision
  only closes "nothing spawns/renders a Piece at all," the simpler freeform-placement
  case the spec also describes ("any player can pick it up, move it, and rotate it at
  any time, same as a Card").
- Each piece set's entries auto-fan out from a settable anchor point
  (`PieceSet.startX/startY`, `packages/startingLayout.ts`'s `pieceEntryOffset`) the same
  way an unpositioned card set falls back to an auto-spread default — but unlike
  CardSet, the editor doesn't yet expose a drag-to-position control for that anchor
  (that's the still-open "Layout tab" request, not solved by this decision).

## D22 — All UI copy lives in one file (`frontend/src/uiText.ts`), not inline in JSX

Requested explicitly: every piece of UI text/label should be a reference to a constant
in a JS file, not a literal string in component code — the stated reason being that
AI-written copy is easy to spot and grating, so the user wants to rewrite all of it
themselves without having to hunt through component logic to find each string.

`frontend/src/uiText.ts` exports one `UI_TEXT` object, nested by component (matching
the file/function it's used from — `UI_TEXT.login`, `UI_TEXT.gamePackageEditor.tracks`,
etc.) rather than grouped by "kind of string" (all headings together, all buttons
together): the point is to make "what text does this one component show" fast to find
and replace, not to produce a general glossary. A plain string covers the common case;
a small function (`deleteRoomConfirm(name)`, `flipAll(count)`) covers the few that need
to interpolate a value — the file has no other logic, deliberately, so nothing but
wording ever needs to change there. `engine/table.ts`'s plain-DOM right-click menus
pull from the same file (`UI_TEXT.tableMenu`) as the JSX components do, since a
right-click menu label is exactly as much "UI text" as a button's — one file covers
both, not one per rendering technology.

Not extracted: CSS class names, HTML attribute values that aren't prose (`type="file"`,
`href="#/new"`), decorative punctuation/separators (" &middot; ", the space before a
suffix), and console-only error logging (`console.error` calls no one but a developer
ever sees) — none of that reads as "written" text a person would want to rewrite for
voice, so extracting it would just add noise without serving the actual goal.

## D23 — "+ Add card"/"+ Add piece" opens a modal, not a blank tile to fill in after

Previously, clicking "+ Add card" (or "+ Add piece") immediately appended a
default-titled blank entry to the grid, which the author then edited in place. Per
explicit feedback ("it should pop up a new virtual window/prompt... where the user
fills in the details of the card"), both buttons now open an in-page modal dialog
(`GamePackageEditor.tsx`'s `Modal`/`NewCardModal`/`NewPieceModal` — a `position: fixed`
overlay, not an actual browser window) where the author fills in the new entry's
fields before it's added at all; Cancel or Escape discards it with nothing added to the
package. The modal's fields are exactly what an existing tile already let you edit —
title/body-text/image for a card, symbol-or-image/connectors for a piece — this only
changes *when* you fill them in, not what's editable overall (an existing tile still
edits in place afterward; only creation moved into the modal, since that's what was
asked). Piece creation got the identical treatment for consistency — one generic
`Modal` component backs both, so there's no separate "how does a dialog work" pattern
per entry type.

## D24 — Fixed: WASD pan was backwards on both axes

A user caught this by feel ("W goes backwards instead of forwards, same with A"), not
by reading the code — worth recording since the bug was exactly the kind that's easy to
get wrong on paper and only actually notice by using the controls. `engine/camera.ts`'s
`stepCamera` returns an (x, y) that `engine/table.ts`'s `tickCamera` applies *directly*
as the world container's on-screen position — the table sprite slides under a fixed
viewport, rather than a separate "camera" position being tracked and negated somewhere
downstream. Given that, moving "forward" (W, toward what's further up the table) must
*increase* `world.position.y` (sliding the table down, revealing more of what's above),
not decrease it (which slides the table up, revealing what's below — backward). All
four directions (`up`/`down`/`left`/`right`) had this inverted; fixed by flipping the
sign of each in `stepCamera`, with `camera.test.ts`'s direction assertions updated to
match the corrected (intended) behavior rather than the previously-shipped one.
