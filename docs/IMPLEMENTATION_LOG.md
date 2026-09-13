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
- Pixel-art visual theme (D12/ARCHITECTURE.md "Visual style"), partially — see the
  matching "known gaps" entry below for what's still missing. PixiJS textures default to
  nearest-neighbor scaling (`TextureStyle.defaultOptions.scaleMode = "nearest"`, set once
  in `engine/table.ts`) so card art (see below) scales crisply instead of blurring; the
  UI chrome — headings, buttons, the HUD toolbar/panels — uses a bitmap font ("Press
  Start 2P") and blockier low-radius shapes instead of smooth webapp rounding. Dense text
  (chat log, form inputs, the package editor) deliberately stays on the existing
  monospace stack — legibility over strict theme purity there.
- Table state now actually survives a host reloading or briefly closing their tab —
  `app/signaling.py`'s in-memory recovery snapshot used to be wiped the instant a room's
  peer count hit zero (see `_handle_disconnect`), so reopening a room you'd just been
  alone in always started blank; it's now kept until either someone reopens the room
  (resuming from it) or the **server process itself restarts** (still in-memory only,
  per D14 — no game state is written to disk, so a full server restart still resets
  everything; only the browser-level reload/close case was ever the bug). Also added a
  best-effort final snapshot upload on `pagehide` (tab close/reload/navigate-away) so
  reloading right after a move doesn't lose up to the full 5s periodic-upload window.

## Known gaps / open feedback

Newest first. Fixed items move to "Implemented" above with a note here of what changed.

- **(Fixed)** Rotate-hint: the rotate-handle gesture now sends the same kind of coarse,
  throttled live preview drag-hint already had (`net/syncProtocol.ts`'s "rotate-hint",
  mirroring "drag-hint" — both now share a `relayHint` helper on `HostTableSync`).
- **(Fixed)** In-room help: a `?` toggle in the HUD toolbar opens a dropdown (mutually
  exclusive with the chat dropdown) with the right-click/drag/rotate/WASD instructions
  that were dropped when the sidebar was replaced.
- **(Fixed)** Host reload/close no longer resets table state; UI visual design,
  eyes-closed's effect, and chat sync — see "Implemented" above for what actually landed
  for each.
- **(Fixed)** Card images now render on the canvas. `engine/card.ts`'s `drawFace` shows
  the existing color/title fallback immediately, then swaps in the decoded image (a
  `Sprite`, masked to the same rounded-rect shape as a color card, title/text suppressed
  since real art already carries its own) once it's loaded — cached by data URI so a
  card set reusing one image (e.g. a shared back) or a redrawn pile doesn't redecode it.
  Guards against a slow-loading image applying itself to a container that's since moved
  on to a different card (a flip, a merge) via a per-container render-token check.
  `RoomTable.tsx`'s `cardDefsFromPackage` was also silently dropping `entry.front.image`/
  `set.back?.image` entirely before this — now threads them through.
- **(Fixed, partially)** Pixel-art visual theme — see "Implemented" above for what
  shipped. **Still not done**, i.e. D12/ARCHITECTURE.md "Visual style" isn't fully
  satisfied yet: the "generic fallback visuals ship as low-resolution bundled sprites"
  half (a distinct pixel-art card-back/token sprite, "authored... scaled up crisply") —
  the demo deck's back and player tokens are still plain procedurally-drawn
  shapes/colors, not actual sprite assets, since nothing in this environment can author
  real pixel-art images; and the integer-zoom-snapping refinement ARCHITECTURE.md itself
  calls "a nice-to-have, not required."
- **(Not started, newly noticed while fixing card images) Pieces are never spawned or
  rendered on the table at all.** `PieceSet`/`PieceEntry` exist in the package data model
  and editor (`GamePackageEditor.tsx`), but nothing in `table.ts`/`RoomTable.tsx` ever
  turns one into an on-table object the way `cardDefsFromPackage`/`spawnCard` do for
  cards — nothing to spawn, place, or render, image or otherwise. A real gap for any
  game whose board is pieces rather than cards (tiles, tokens, a Betrayal-style board).

## Explicitly out of scope for v1 (see PLAN.md, unchanged)

No rules/flow layer (turns, phases, roles, win conditions, triggers), fog of war/dynamic
lighting/hex-grid movement costs, persistent campaigns across sessions, host-side
roll/action re-validation for adversarial play.
