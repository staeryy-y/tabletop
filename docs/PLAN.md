# Build plan

Milestones are ordered so every one lands a runnable, deployable app (server-watcher
compliant from M0 on). The object model comes before any specific game's rules, since
it's the reusable part — a D&D-style sheet and a Betrayal-style board are both just
configurations of it (see [ARCHITECTURE.md](ARCHITECTURE.md) "Object model").

## M0 — Skeleton & deploy compliance

- `run.sh`, `watcher.config.json`, `requirements.txt`, `app/main.py` returning a
  `/healthz` 200 and mounting an (initially placeholder) `frontend/dist/`.
- `frontend/` scaffolded with Vite + TypeScript, builds to `dist/`, dist committed.
- SQLite schema + `app/db.py` bootstrap: creates `admin`/`admin` with
  `must_change_password=true` if the `users` table is empty.
- **Acceptance:** `./run.sh` serves a page, `/healthz` is green, deployable as-is under
  server-watcher.

## M1 — Accounts & admin

- Session-cookie login, forced password change flow for `must_change_password` accounts.
- Admin dashboard: list users, create user (username + temp password), no signup route.
- `scripts/create_user.py` CLI mirroring the same account creation for terminal use.
- **Acceptance:** fresh deploy → log in as `admin`/`admin` → forced to set a new password
  → can create a second admin/non-admin user.

## M2 — Rooms & join flow

- Admin: create room (name, optional game definition, optional password) →
  `/room/{slug}`.
- Guest join page: display name entry (+ password prompt if the room has one) → issued a
  room-scoped guest token, stored in `localStorage` for reconnects.
- Signaling WS endpoint (`app/signaling.py`): `hello`/`welcome`/presence only for now
  (no WebRTC yet) — enough to show a live participant list.
- **Acceptance:** two browsers can join the same room by link and see each other in a
  participant list; a wrong room password is rejected.

## M3 — Generic object sandbox (no game definition needed)

This is the core deliverable: a shared table that plays *any* tabletop game badly-but-
functionally before a single game-specific line of config exists.

- PixiJS canvas: pan/zoom, a table surface.
- **Card**: import a set of card images/text, move/rotate/flip/**hide** freely (a hidden
  card shows its front only to whoever hid it, plus their private eye-icon reminder —
  see [ARCHITECTURE.md](ARCHITECTURE.md) "Hiding a card"); overlapping cards merge into a
  **Stack** (shuffle/draw/deal/cut/peek).
- **Piece**: import a board/tile image, move/rotate/place freely; optional connector
  snapping; never merges into a stack.
- **Token**: small markers with a couple of named states, ride on top of a Card/Piece.
- **Die**: define a custom face set, roll a manual-size pool, see the result.
- State-sync protocol from [NETWORKING.md](NETWORKING.md) *tunneled through the
  signaling WS* for this milestone (skip real WebRTC — same message shapes, so swapping
  the transport in M6 doesn't change the protocol).
- **Acceptance:** with zero game definition, two browsers can jointly set up and play a
  simple card game (e.g. War, or a custom deck) end to end — shuffle, deal, draw, flip,
  discard — entirely through this sandbox.

## M4 — Declarative game definitions: Tracks, macros, chat rolls

- Ruleset loader per [GAME_DEFINITION.md](GAME_DEFINITION.md): `tracks`, `dice`, `cards`,
  `pieces`, `macros`.
- Chat panel wired into the sync channel; `/roll`/`/r` parser implementing the roll
  grammar (literal pools, track-refs via `resolve_as`/`pool_die`, keep/drop, count).
- Character sheet UI generated from a room's tracks; players claim an Actor, slide their
  own tracks.
- Ship `game-defs/generic-freeform.yaml` and `game-defs/dnd5e-srd.yaml`.
- **Acceptance:** `/roll 1d20 + dex` resolves against the roller's sheet; a macro button
  produces the same result as typing its roll string; a Betrayal-style track (`might`
  with `pool_die: pip`) correctly turns a bare stat reference into a dice-pool roll,
  proving the same grammar covers both games.

## M5 — Cards & private hands: Poker and Mafia/Werewolf

- Ship `game-defs/poker-5-card-draw.yaml`: a standard 52-card deck, a private
  `owner-only` hand Zone per player (5 cards each), a discard-and-redraw-once action, and
  a chip-count Track per player. No auto-adjudicated showdown — players look at their own
  hand and each other's revealed cards and settle it themselves, same philosophy as
  everything else in this design (see GAME_DEFINITION.md "Why no rules layer?").
- Ship `game-defs/mafia-werewolf.yaml`: a generic hidden-role party game (this project's
  own role names/text — Villager/Mafia/Detective, or Werewolf/Villager/Seer, not any
  commercial edition's) — content only: a shuffled stack of role Cards, one dealt face
  down to each player. No phases, no vote automation, no win-condition check — night/day,
  voting, and ending the game are the group's own convention, exactly like the physical
  party game, using nothing but Hide (to keep your own role secret) and ordinary chat.
- **Acceptance:** each player's client renders its own 5 poker cards / one role card
  face-up and everyone else's as face-down backs only (verify the front-face payload for
  another player's hand never reaches a non-owning peer at all — not just hidden in the
  UI); a poker discard-and-redraw round trips correctly through the deck/discard Stacks.

**Why Poker and Mafia/Werewolf, and not bundled Betrayal/Avalon definitions:** both of
those games' actual rules text, card content, and (for Avalon) character names/art are
copyrighted — useful as design-validation references in
[GAME_DEFINITION.md](GAME_DEFINITION.md) (a few quoted lines, for design commentary), but
not something to ship as real game data in this repo. Standard playing cards and the
generic Mafia/Werewolf party-game format are public domain and need no reproduced text or
art, while still exercising exactly what those two stress tests showed the engine
needed: private hands via Card/Hide, nothing more — see GAME_DEFINITION.md's "Design-
validation references" for the full walkthrough of why neither game needed an automated
rules layer to be fully playable.

**Known gap, deferred rather than solved with an unwanted game:** none of the bundled
examples currently exercise Piece + connector + draw-pile board-building (Betrayal's
room tiles; Dominoes would have covered it but was rejected as the pick). That mechanic
still works per [GAME_DEFINITION.md](GAME_DEFINITION.md) "Pieces," it's just not proven
by a bundled example yet — worth revisiting whenever a suitable public-domain
tile-placement game (or an original one) is wanted.

## M6 — Real WebRTC + asset transfer + host migration

- Swap the M3–M5 relay transport for actual `RTCPeerConnection` data channels, using the
  signaling WS purely for offer/answer/ICE exchange (protocol already designed for this
  in NETWORKING.md — this milestone is transport-only, no message-shape changes).
- Real chunked custom-package transfer per NETWORKING.md "Asset distribution" (earlier
  milestones can get away with assets small enough to inline, or just ship
  game-def-bundled packages with few/no images) — since a package's images are already
  embedded as data: URIs (D14) rather than separate files, this chunks the whole
  package's JSON and rides the same link as table-sync traffic rather than a dedicated
  second data channel; see DECISIONS.md D17 for why.
- Keep the WS-relay path as the automatic fallback when P2P setup fails/times out.
- Host migration on host disconnect, backed by the periodic snapshot upload — the
  promoted host already has the full game package from its own join, per M2/step 4 in
  ARCHITECTURE.md "Room lifecycle."
- **Acceptance:** a session with 3+ tabs runs with real WebRTC (verify via
  `chrome://webrtc-internals`); killing the host tab promotes another peer and play
  continues from the last snapshot; forcing an ICE failure falls back to relay
  transparently.

## Later / explicitly out of scope for v1

## M7 — Presentation, feel, and resilience

This milestone turns the reliable sandbox into a game table that feels responsive and
alive, while protecting the host-authoritative model from stale or contradictory state.

- Add monotonic snapshot revisions and client-side stale-snapshot rejection.
- Add interpolation for remote object movement and rotation, with authoritative
  correction on drop.
- Add lightweight flip particle bursts, selection highlights, drag trails, and other
  opt-in client-only effects that never enter the sync protocol.
- Add reduced-motion and low-power rendering preferences for effects.
- Add protocol/schema validation, host-only mutation tests, and multi-browser E2E tests
  covering guest startup, hidden cards, stack operations, and reconnects.
- Update deployment/cache diagnostics and keep the implementation log aligned with the
  actual transport and persistence choices.

## M8 — Completeness and game-authoring depth

- Implement piece draw-pile mode and connector snapping.
- Add Actor claiming and generated character-sheet UI.
- Ship original poker and hidden-role sample packages.
- Decide and implement a single persistence strategy for packages and saved tables.
- Improve mobile/touch accessibility, keyboard focus handling, and bundled visual assets.

- Any rules/flow layer at all — turns, phases, roles, win conditions, triggers. Explicit
  non-goal, not a deferred feature (see GAME_DEFINITION.md "Why no rules layer?").
- Fog of war, dynamic lighting, hex/square grid movement costs.
- Persistent campaigns across multiple sessions (rooms are currently per-session; a
  "save table state to resume later" flow is a natural follow-up once the snapshot
  format has settled).
- Host-side roll/action re-validation for adversarial play (see NETWORKING.md "Trust
  model" — explicitly assumed away).
- Mobile/touch-specific canvas UX polish.
