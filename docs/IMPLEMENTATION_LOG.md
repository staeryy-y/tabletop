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
module's own test file. 494 frontend tests passing as of the last commit that touched
this log. The backend suite remains listed at 105 from its last verified run.

## Implemented, beyond the milestone checklist

- Card clicks no longer enter the pickup/drop mutation path unless the pointer actually
  moves. This prevents hidden-card reader popups from racing a drag and losing their
  face; a click is now strictly read-only, while a real drag still splits/moves cards.

- Guest catch-up is now retried briefly after link negotiation, ensuring a guest joining
  an already-populated room receives the host's current snapshot even if the first
  request crossed the WebRTC/relay transition at an unlucky time.

- Card entry editing is now popup-based: the editor shows only rendered card previews
  and a compact action, while clicking a preview opens the full card editor dialog.
  Mat creation exposes the rule-sheet fields directly in its Add Mat dialog.

- Card art now renders in a non-stretched trading-card layout with a fixed aspect-ratio
  art window, translucent title/rules bands, and per-image contain/crop-to-fill choice.
  Clicking a card opens a large readable card viewer; dragging does not accidentally
  open it. Room entry shows an explicit loading screen until presence and package data
  are ready.

- Live player tokens now carry a presence-synced table position instead of each browser
  treating a drag as local-only. A player may move their own token and the server-
  attested GM may arrange anyone's; each token also renders the player’s full name
  below its marker. Mats can now act as rule sheets: each entry supports a background
  color or image, configurable dimensions, and wrapped text.

- Feedback batch 2: older saved/imported packages are normalized before editing or
  starting a room (so missing newer arrays such as `matSets` no longer make Edit Game
  render blank); room creation now uses a settings modal; joining opens a color-choice
  prompt; package starter content is normalized and seeded at its configured Layout
  position; card/deck drags preserve the pointer's grab offset and show a detached card
  while the source stack remains visible; and Card entries now have a validated
  `count`/Copies field which expands into that many cards in the starting stack.

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
  image upload with a 2MB cap, localStorage-backed storage (`packageStore.ts`).
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
- Table state now actually survives a host reloading or closing their tab. Two layers,
  see D18:
  - The real fix: `net/tableStore.ts` persists the host's table snapshot to that
    browser's own IndexedDB, and `you-are-host` prefers it over whatever the server last
    saw. A first attempt at this fixed the wrong layer (making the *server's* in-memory
    snapshot durable via SQLite) before landing here — reverted; the server round trip,
    upload-interval staleness, and dependence on the process not having restarted were
    never the point for a same-browser reload, which needs none of that.
  - Left in place underneath it, for the case local storage can't cover (a *different*
    peer promoted to host): `app/signaling.py`'s in-memory recovery snapshot no longer
    gets wiped the instant a room's peer count hits zero (`_handle_disconnect`), and a
    best-effort final upload fires on `pagehide` to shrink the staleness window. Still
    in-memory only server-side (per D14) — a full server *process* restart resets a room
    unless some peer's own browser still has it locally.
- The main menu (`AdminDashboard.tsx`) is back to just rooms + users; the game-package
  manager is its own page (`#/packages`, `GamePackages.tsx`), reached via a nav link.
- Card sets spawn as one labeled, shufflable stack instead of N separate individual
  piles (`TableModel.spawnStack`, a new `"spawn-stack"` sync-protocol request) — "a
  stack of all the role cards," per the explicit Avalon example. `CardSet` gained
  `label`/`startX`/`startY`; a set with no explicit position falls back to the same
  auto-spread layout the runtime always used (`packages/startingLayout.ts`, shared
  between the runtime and the editor's new preview below so they never disagree).
- The game-package editor's card/piece lists are now a visual thumbnail grid
  (`.entry-grid`/`.entry-tile`) — each card/piece shows its actual image, color, or
  symbol up front, not just text in a row — plus a draggable "starting layout" preview
  (`StartingLayoutPreview` in `GamePackageEditor.tsx`) for positioning each card set's
  stack, addressing the explicit request to configure this "visually." Piece placement
  isn't part of this preview yet, since pieces aren't spawned onto the table at all (see
  the pre-existing, still-open gap below).
- Room deletion (`DELETE /api/rooms/{slug}`, admin-only + ownership-checked, dashboard
  gets a "Delete" button per room).
- Anonymous rooms (D19): `#/new` (linked from the login page) creates a room with no
  account at all, via a new public `POST /api/rooms/anonymous` — held entirely in
  `app/rooms.py`'s in-memory `_anonymous_rooms`, never a SQLite row. Such a room has no
  GM ever (there's no account to attest one from — `is_gm` is explicitly guarded
  against `owner_user_id is None` so a not-logged-in guest can't accidentally read as
  GM), so D13's host-follows-GM re-election never triggers; whoever joins first just
  stays host. Its client never uploads a recovery snapshot to the server at all
  (`roomInfo.isAnonymous`) — moot anyway, since `app/signaling.py`'s
  `_handle_disconnect` now discards an anonymous room's entire in-memory state (and its
  `_anonymous_rooms` entry) the instant it goes empty, rather than keeping it the way
  an accounted room's snapshot is kept. A custom game package still works identically —
  it was always client-side, regardless of who owns the room.
- Multi-select (D20): drag a box over empty table (screen-space rectangle, so it reads
  correctly even with the camera rotated) to select several piles at once — outlined in
  `engine/table.ts`. A selected group can be dragged together (`TableModel.movePile`, a
  new sync request simpler than `pick-up-and-drop`: no splitting, no merge-on-drop),
  rotated together around its centroid via a diamond-shaped group handle (client-side
  vector math, committed as one `move-pile` + `set-rotation` per pile — no new protocol
  needed for this part), or, from the group's right-click menu: flipped/hidden all at
  once (existing single-pile `flip`/`toggle-hide`, once per pile) or collapsed into one
  new stack (`TableModel.collapseIntoStack`, a new sync request, landing at the group's
  centroid under a fresh id). Replaces the old click-drag-to-pan gesture — WASD/Q/E
  already cover camera movement.
- Pieces are spawned and rendered on the table (D21), closing a long-standing gap.
  Modeled as their own `PieceState` (`engine/pileModel.ts`), deliberately separate from
  Pile/Card — no flip, no hide, no stack/merge-on-drop, matching
  docs/GAME_DEFINITION.md "Pieces": a pawn overlapping a tile is just a visual overlap,
  never a combined object. New sync-protocol requests/events
  (`spawn-piece`/`move-piece`/`rotate-piece-by`/`set-piece-rotation`/`remove-piece`,
  `piece-upserted`/`piece-removed`) and rendering (`engine/piece.ts`, an image or a
  short emoji/text symbol, round rather than a card's rounded-rect so the two families
  read as visually distinct). A room's own piece sets spawn automatically when it
  starts, one standalone piece per entry (never grouped into a stack the way a card
  set's entries are), fanned out from a settable anchor point
  (`PieceSet.startX/startY`, falling back to an auto-spread default —
  `packages/startingLayout.ts`). Right-click a piece to rotate it 90° or remove it; drag
  its own handle to rotate it freely, same as a card. Host-reload persistence
  (`net/tableStore.ts`) and host-migration recovery (`net/roomConnection.ts`) both
  carry pieces alongside piles now (`TableSnapshot`); an older browser's saved
  pre-pieces snapshot (a bare piles array) is transparently upgraded on load rather than
  discarded. Not covered by this: `draw_pile`/connector-snapping (see D21), multi-select
  (Cards only, per that feature's own explicit request), and a visual
  drag-to-position editor control for a piece set's anchor (card sets already have one;
  see the "Layout tab" gap below).

- All UI copy centralized into `frontend/src/uiText.ts` (D22) — every JSX/DOM string
  across `ui/*.tsx` and `engine/table.ts`'s right-click menus is now a reference into
  one `UI_TEXT` object, nested by component, rather than a literal inline in component
  code. Purely a refactor (no wording changed): the point is to make every piece of
  copy reachable and rewritable from one file.
- "+ Add card"/"+ Add piece" open an in-page modal to fill in the new entry's details
  before it's created, instead of dropping a blank tile into the grid to edit
  afterward (D23) — `GamePackageEditor.tsx`'s `Modal`/`NewCardModal`/`NewPieceModal`.
  Editing an *existing* tile is unchanged (still inline in the grid); only the
  creation step moved into a dialog, per the explicit request.
- WASD panning direction bug fixed (D24) — W was moving the camera backward and A the
  wrong way, on both axes; `engine/camera.ts`'s `stepCamera` had all four pan
  directions inverted relative to how `engine/table.ts` actually applies the result.
- Hidden cards now show a colored eye badge to *every* player, not just the hider
  (D25) — the badge is tinted with the hider's own presence color, so the table can
  tell someone's secretly viewing a card, and who, without ever seeing its content.
  `net/syncProtocol.ts`'s `redactPileFor` still swaps front for back for anyone but
  the hider; it just no longer scrubs `hiddenBy` itself.
- A guest joining now gets its own real, randomly-assigned color immediately, instead
  of a hardcoded gray placeholder — `app/signaling.py`'s `welcome` message gained a
  `self` field carrying the joiner's own presence (a peer was never told about itself
  via `peer-joined`, which excludes the peer it's about, so this was the only gap).
  This also fixes player tokens appearing to be missing — a gray token blends into the
  table's own gray/dark palette closely enough to be easy to miss entirely.
- Live cursor markers now ease toward their latest position each frame
  (`engine/table.ts`'s `smoothCursors`) instead of snapping straight to it on every
  throttled cursor-hint (~120ms apart) — "the player cursor is fine, but add some
  artificial smoothing."
- A second grip handle below every pile drags the *entire* stack as one unit
  (`TableModel.movePile`, no split/merge — D28), leaving the existing card-body drag's
  default behavior (pull just the top card off a multi-card stack) unchanged, per the
  explicit "add an additional drag-only handler" request.
- Mats: a new Piece-shaped object family that always renders beneath every Card/Piece
  and can be locked so only the GM can move/rotate/remove it (D26). Full stack: model
  (`TableModel`'s mat methods), sync protocol (`spawn-mat`/`move-mat`/`rotate-mat-by`/
  `set-mat-rotation`/`set-mat-locked`/`remove-mat`, GM-gated host-side via a new
  `getGmPeerId` callback threaded through `RoomConnection`/`ui/RoomTable.tsx`),
  rendering (`engine/mat.ts`, `engine/table.ts`'s dedicated `matsLayer`), package data
  model (`MatSet`/`MatEntry`, including the bundled-YAML `mats:` schema), and a full
  editor section (`MatSetsEditor`/`MatEntriesEditor`/`NewMatModal`, matching Pieces'
  D23 modal-on-create treatment plus a "starts locked" checkbox).
- The game-package editor is now tabbed — one tab per element (tracks, dice, cards,
  pieces, mats, macros) plus a shared "Layout" tab covering all three set families in
  one draggable canvas, replacing the old single continuously-scrolling editor and its
  card-sets-only starting-layout preview (D27) — the long-standing, explicitly
  repeated "each editor element gets its own tab, plus a Layout tab" request.

## Known gaps / open feedback

Newest first. Fixed items move to "Implemented" above with a note here of what changed.

- **(Fixed)** The game-package editor is now genuinely tabbed, with a shared "Layout"
  tab (D27) — see "Implemented" above and the pieces-gap entry below it (that entry's
  own "Layout tab" blocker is what this closes).

- **(Fixed)** Mats: a new lockable, always-on-bottom object family (D26) — see
  "Implemented" above.

- **(Fixed)** A second grip handle drags a whole stack as one unit, leaving the
  existing default (drag pulls one card off) unchanged (D28) — see "Implemented"
  above.

- **(Fixed)** Hidden cards now show *who* is hiding them, via a colored eye badge
  visible to everyone (D25) — a deliberate narrowing of the earlier "no trace at all"
  privacy guarantee — see "Implemented" above.

- **(Fixed)** A joining guest's own player color was a hardcoded gray placeholder
  (easy to mistake for "no token at all," since it blends into the table's own
  gray/dark palette) instead of the server's real randomly-assigned color — see
  "Implemented" above.

- **(Fixed)** Live cursor markers now ease toward their target each frame instead of
  snapping on every throttled update — see "Implemented" above.

- **(Fixed)** WASD pan was backwards on both axes (D24) — caught by a user "by feel,"
  not by reading the code; see "Implemented" above.

- **(Fixed)** "+ Add card"/"+ Add piece" now open a modal to fill in the new entry
  before it's created (D23) — see "Implemented" above.

- **(Fixed)** Pieces are now spawned and rendered on the table (D21) — a dedicated
  object family, not a variant of Pile/Card (no flip, no hide, no merge-on-drop) — see
  "Implemented" above. **Still not covered** by this fix: a package's `draw_pile: true`
  face-down-pile piece mode and connector-snapping (both in docs/GAME_DEFINITION.md
  "Pieces" but not yet in `PieceSet`/`PieceEntry`'s actual fields). The
  no-drag-to-position-control gap this note used to flag is now closed by the Layout
  tab (D27) — see "Implemented" above.

- **(Fixed)** Multi-select — box-select several piles, then move/rotate-around-centroid/
  flip/hide/collapse-into-a-deck them together (D20) — see "Implemented" above.

- **(Fixed)** Room deletion (`DELETE /api/rooms/{slug}`, admin-only + ownership-checked)
  and anonymous rooms (D19) — see "Implemented" above for the latter's actual shape
  (no account needed, genuinely zero server footprint, not just "an account-less
  version of the same thing").

- **(Fixed)** Client cursors are now always visible, not just mid-drag — a new
  "cursor-hint" (`net/syncProtocol.ts`, alongside drag-hint/rotate-hint: cosmetic,
  peer→host→everyone-except-sender, never touches the model) fires on every pointer
  move over the canvas at the same ~120ms throttle, rendered as a small colored dot per
  peer (`engine/table.ts`'s `cursors` map) using their current presence color.

- **(Fixed)** A batch of smaller room-UI feedback:
  - The demo deck was still spawning alongside a real game package's cards — a real
    ordering bug: the host used to seed the demo deck immediately (package loading is
    async and usually hadn't resolved yet), then separately seed the package's cards
    once it *did* load, so both ended up on the table. `seedStarterContentIfHost` now
    makes this one decision, once, only after the package is actually known.
  - The table was a plain dark void with no sense of scale or center — `engine/table.ts`
    now draws a small center marker and concentric square rings (static Graphics, no
    per-frame cost, not a movement grid) once at init.
  - The "+ Card" spawn button is now host-only (still not the actual player who can spawn
    on the wire — anyone's request would still work — see the button's own comment).
  - An "Invite link" button in the player-list panel copies the room's guest join URL
    to the clipboard, so sharing it doesn't require going back to the dashboard.
  - The 8 always-visible color swatches ("the colors take too much out of the UI") are
    now behind a dropdown opened from a single swatch-preview button, matching the
    chat/help dropdown pattern.

- **(Fixed)** The dashboard and game-package manager pages were stuck at 360px wide on
  any normal-width screen. Cause: `.panel` (the small, deliberately-360px-capped shape
  meant for the login/account-setup/room-join dialogs) was also being reused, wrongly,
  for the dashboard's room/user sections and the whole game-package manager — genuinely
  wide content stuck in a narrow box. Split into `.panel` (still 360px, for the small
  dialogs) and a new `.dashboard-section` (fills its container) for everything else;
  `AdminDashboard.tsx`/`GamePackages.tsx` switched to the new class. The heading-overflow
  fix earlier in this log was a real, separate bug — this narrow-panel one predates this
  session entirely and just became far more noticeable once the package editor grew an
  actual grid layout worth seeing at full width.

- **(Fixed)** feedback1.md's batch: table-state persistence (see "Implemented" —
  client-side IndexedDB, not server round trips), the dashboard heading-overflow bug,
  the game-package manager splitting into its own `#/packages` page, card sets spawning
  as one labeled stack instead of N individual piles, and the card/piece editor
  switching from a plain list to a visual thumbnail grid (`.entry-grid`/`.entry-tile` in
  style.css) with a draggable starting-layout preview for where each stack starts (see
  "Implemented" for the last two). **Not done from that batch**: pixel-art theming for
  the editor specifically beyond what the global CSS pass already gives it for free
  (headings/buttons already pick up the bitmap font and blockier chrome — no
  editor-specific pixel-art work was needed beyond the new tile-grid CSS above).
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
- **(Fixed)** The game-package editor is now genuinely tabbed — one tab per element
  (tracks, dice, cards, pieces, mats, macros) plus a shared "Layout" tab covering every
  set family's starting position in one draggable canvas (D27) — see "Implemented"
  above. This was requested and re-requested across several turns before landing.

## Explicitly out of scope for v1 (see PLAN.md, unchanged)

No rules/flow layer (turns, phases, roles, win conditions, triggers), fog of war/dynamic
lighting/hex-grid movement costs, persistent campaigns across sessions, host-side
roll/action re-validation for adversarial play.
