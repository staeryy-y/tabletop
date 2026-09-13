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
module's own test file. 378 frontend + 105 backend tests passing as of the last commit
that touched this log.

## Implemented, beyond the milestone checklist

- Live per-player presence: color (random default, user-changeable swatch picker),
  eyes-closed flag — both synced via `set-presence`/`presence-changed` over signaling,
  shown in the player list, on the in-canvas player token, and enforced locally as a
  full-screen blank-out on the closed-eyed player's own client (see "Fixed" below).
- Default per-player colored token, auto-seated in a polygon around the table
  (`seating.ts`) sized to player count.
- WASD camera pan, Q/E camera rotate.
- Live drag-hint: a coarse, throttled (~120ms) preview of another player's in-progress
  drag, dimmed like a local drag, corrected the moment the real drop lands. Card-drag
  only, not the rotate-handle gesture.
- Game-package editor (`GamePackageEditor.tsx`): tracks, dice, card sets (text or
  uploaded-image faces), piece sets (emoji/symbol or uploaded-image faces), macros,
  image upload with a 2MB cap, IndexedDB-backed storage (`packageStore.ts`).
- Chat, synced across every connected player (`net/chatSync.ts`, `ChatDistributor`),
  riding the same host-authoritative link as everything else via
  `RoomConnection.SideChannel` (now generalized to support more than one channel — see
  `net/packageTransfer.ts`, the first consumer). History (capped at 200 messages) is
  requested from the host on join/host-changed and kept alive by every client that's
  ever seen it, so a later-promoted host can still serve it onward. Presented as a
  toggleable dropdown from the bottom HUD toolbar rather than an always-visible panel.
- A game-HUD layout replacing the old sidebar: the table canvas fills the whole
  viewport, with a floating player-list window pinned top-left, a floating pill-shaped
  action bar pinned bottom-center (spawn, eyes-closed toggle, color swatches, chat
  toggle, back-to-dashboard), and the chat dropdown floating just above the toolbar.
  Not the full pixel-art pass (still a separate open item below) — this is layout/
  chrome, not a visual-asset overhaul.

## Known gaps / open feedback

Newest first. Fixed items move to "Implemented" above with a note here of what changed.

- **(Fixed)** UI visual design, eyes-closed's effect, and chat sync — see "Implemented"
  above for what actually landed for each.
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
- **(Minor, new) The old sidebar's instructional hints (how to right-click/drag/rotate,
  what's actually synced) were dropped, not relocated**, when the sidebar was replaced
  by the floating HUD — there's currently no in-room help text at all. A `?`/help toggle
  in the HUD toolbar would be the natural place to put it back.

## Explicitly out of scope for v1 (see PLAN.md, unchanged)

No rules/flow layer (turns, phases, roles, win conditions, triggers), fog of war/dynamic
lighting/hex-grid movement costs, persistent campaigns across sessions, host-side
roll/action re-validation for adversarial play.
