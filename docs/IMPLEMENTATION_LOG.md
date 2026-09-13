# Implementation log

A running, honest account of what actually exists versus [PLAN.md](PLAN.md)'s
milestones — not what's designed or intended, what's *built and tested*. Update this
whenever something moves from "not done" to "done," or a real gap is found (like the
feedback batch below) — don't let it drift from reality. Newest feedback goes at the top
of "Known gaps / open feedback"; move an item out of there and into "Implemented" once
it's actually fixed, with a one-line note on what changed.

## Status by milestone (see PLAN.md for what each means)

- **M0 — Skeleton & deploy compliance:** done. `run.sh`, `/healthz`, SQLite bootstrap,
  `frontend/dist/` committed and served statically (see D2 — **must be rebuilt via
  `npm run build` and committed after every frontend source change**; this bit us once
  already, see the "P2P doesn't work" incident where the served bundle was several
  commits stale).
- **M1 — Accounts & admin:** done. Session login, forced password+username change on
  first login (`AccountSetup.tsx`), admin dashboard user management, `scripts/create_user.py`.
- **M2 — Rooms & join flow:** done. Room creation, guest join + token, signaling WS with
  presence.
- **M3 — Generic object sandbox:** done. Card/Stack/Piece object model (`pileModel.ts`),
  pan/zoom/rotate camera, drag/flip/hide/rotate/shuffle/draw, right-click menu.
- **M4 — Declarative game definitions:** done. YAML game-def loader, roll grammar
  (`roll.ts`/`formula.ts`), chat-driven `/roll`, macros, per-track "quick sheet."
- **M5 — Cards & private hands:** done. Per-card Hide primitive, `poker-5-card-draw.yaml`
  and a Mafia/Werewolf-style hidden-role setup are playable with what exists.
- **M6 — Real WebRTC + asset transfer + host migration:** done. Real
  `RTCPeerConnection` data channels (`webrtcPeerLink.ts`) with automatic relay fallback
  (`peerLinkWithFallback.ts`), host-authoritative sync protocol (`syncProtocol.ts`) fully
  wired into `TableApp`/`RoomTable.tsx`, host migration backed by periodic snapshot
  upload, P2P custom-package transfer (`packageTransfer.ts`). D13 was also revised
  mid-stream: the GM is always host when connected, not merely preferred on migration.

All of the above have backend (pytest) and/or frontend (Vitest) test coverage; see each
module's own test file. 360 frontend + 105 backend tests passing as of the last commit
before this log was created.

## Implemented, beyond the milestone checklist

- Live per-player presence: color (random default, user-changeable swatch picker),
  eyes-closed flag — both synced via `set-presence`/`presence-changed` over signaling,
  shown in the player list. (Eyes-closed's *effect* is incomplete — see gaps below.)
- Default per-player colored token, auto-seated in a polygon around the table
  (`seating.ts`) sized to player count.
- WASD camera pan, Q/E camera rotate.
- Live drag-hint: a coarse, throttled (~120ms) preview of another player's in-progress
  drag, dimmed like a local drag, corrected the moment the real drop lands. Card-drag
  only, not the rotate-handle gesture.
- Game-package editor (`GamePackageEditor.tsx`): tracks, dice, card sets (text or
  uploaded-image faces), piece sets (emoji/symbol or uploaded-image faces), macros,
  image upload with a 2MB cap, IndexedDB-backed storage (`packageStore.ts`).

## Known gaps / open feedback

Newest first.

- **(Not started) UI visual design doesn't read as a game.** Current layout is a
  conventional webapp: a persistent left sidebar holding room name, presence, color
  picker, chat, and hints, plus a top toolbar. Requested instead: floating HUD-style
  elements over the table like a retro RPG — a floating action bar/toolbar anchored to
  the bottom of the screen instead of the sidebar, and the player list as its own
  floating window pinned to the top-left rather than embedded in a sidebar. No sidebar
  chrome at all in the target design. Affects `RoomTable.tsx` and its CSS most directly;
  likely touches Chat's presentation too (see below).
- **(Not started) Eyes-closed does nothing to your own view.** `presence-changed`
  already broadcasts the flag correctly and the player *list* already shows a closed-eye
  indicator for whoever has it set — but toggling your own eyes closed doesn't actually
  blank/obscure your own screen (the stated purpose: a reveal moment in Avalon/Mafia
  where players close their eyes and shouldn't see the table). Also missing: the
  in-canvas player *token* (`mountPlayerToken`/`redrawPlayerToken` in `table.ts`) doesn't
  reflect eyes-closed at all — only the sidebar list does.
- **(Not started) Chat isn't synced across players at all.** `Chat.tsx`'s own doc
  comment already admits this ("Local to this tab only for now... needs the P2P layer,
  M6"), and M6 is now done but chat was never wired to it — a real functional gap, not
  just cosmetic. Also requested: present it as a dropdown with history rather than an
  always-visible inline panel. Likely needs its own request/event pair in
  `syncProtocol.ts` (or a simpler host-relayed broadcast, since chat history doesn't
  need to be part of the table snapshot/model) plus a `RoomTable.tsx`/`RoomConnection`
  wiring pass similar to what package transfer got.
- **(Not started) Card images don't render on the canvas.** An image-based card front
  (built in the package editor) falls back to a plain color in PixiJS — see
  `card.ts`/`RoomTable.tsx`'s `cardDefsFromPackage` doc comments. Flagged repeatedly,
  not yet picked up.
- **(Not started) Pixel-art visual theme.** Explicit early request ("don't forget the
  pixel art theme" x2), still purely aspirational — see D12 in DECISIONS.md for the
  design decision, no implementation.
- **(Minor, not started) Rotate-handle drags have no live hint.** The drag-hint feature
  only covers card dragging (matching the specific request that added it); rotating via
  the handle still only updates other clients on release.

## Explicitly out of scope for v1 (see PLAN.md, unchanged)

No rules/flow layer (turns, phases, roles, win conditions, triggers), fog of war/dynamic
lighting/hex-grid movement costs, persistent campaigns across sessions, host-side
roll/action re-validation for adversarial play.
