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
- **Card**: import a set of card images/text, move/rotate/flip freely; overlapping cards
  merge into a **Stack** (shuffle/draw/deal/cut/peek).
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

## M5 — Zones, phases, triggers

- **Zone** visibility (`public`/`owner-only`/`owner+host`), delivered as targeted
  messages per NETWORKING.md, not broadcast.
- **Phase**/turn-order switching and the fixed trigger action vocabulary (`draw`, `roll`,
  `contest`, `move-token`, `set-track`, `switch-phase`, `assign-role`, `reveal-zone`).
- Ship enough of `game-defs/betrayal-house-on-the-hill.yaml` to prove the model: custom
  pip dice, sliding traits, three tagged card sets, a tile draw pile with connectors and
  `prevent_disconnection`, a haunt-roll trigger that switches phase and reveals a secret
  zone to one assigned role.
- **Acceptance:** playing through the Betrayal definition to a haunt trigger correctly
  hands one browser a secret zone the others never receive, and turn order changes for
  the rest of the session.

## M6 — Real WebRTC + host migration

- Swap the M3–M5 relay transport for actual `RTCPeerConnection` data channels, using the
  signaling WS purely for offer/answer/ICE exchange (protocol already designed for this
  in NETWORKING.md — this milestone is transport-only, no message-shape changes).
- Keep the WS-relay path as the automatic fallback when P2P setup fails/times out.
- Host migration on host disconnect, backed by the periodic snapshot upload.
- **Acceptance:** a session with 3+ tabs runs with real WebRTC (verify via
  `chrome://webrtc-internals`); killing the host tab promotes another peer and play
  continues from the last snapshot; forcing an ICE failure falls back to relay
  transparently.

## Later / explicitly out of scope for v1

- A general scripting layer beyond the fixed trigger-action vocabulary (see
  GAME_DEFINITION.md "Why not just script it?").
- Fog of war, dynamic lighting, hex/square grid movement costs.
- Persistent campaigns across multiple sessions (rooms are currently per-session; a
  "save table state to resume later" flow is a natural follow-up once the snapshot
  format has settled).
- Host-side roll/action re-validation for adversarial play (see NETWORKING.md "Trust
  model" — explicitly assumed away).
- Mobile/touch-specific canvas UX polish.
