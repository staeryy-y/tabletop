// The shared table: pan/zoom, and PixiJS rendering/pointer-event handling over the pure
// game logic in pileModel.ts. This file deliberately holds *no* game rules of its own —
// merge distance aside, everything about what a drag/flip/hide/shuffle/draw actually
// does lives in TableModel, which is unit-tested directly (pileModel.test.ts) without
// needing PixiJS, a canvas, or WebGL at all.
//
// This is the M3 milestone (docs/PLAN.md): the sandbox works entirely locally in this
// tab for now. Syncing it P2P over WebRTC (and the WS-relay fallback) is M6 and isn't
// wired up here yet — see net/signaling.ts.
import { Application, Container, FederatedPointerEvent, Graphics, Text, TextureStyle } from "pixi.js";
import { CameraInput, NO_CAMERA_INPUT, stepCamera } from "./camera";
import { CARD_HEIGHT, CARD_WIDTH, CardDef, renderCard } from "./card";
import { TableSyncClient, TableView } from "../net/roomConnection";
import { TableEvent } from "../net/syncProtocol";
import { PileState, TableModel } from "./pileModel";
import { computeSeatPositions } from "./seating";

// Pixel-art visual theme (docs/ARCHITECTURE.md "Visual style", D12): every texture
// PixiJS creates from here on (card art loaded by engine/card.ts included) scales with
// nearest-neighbor sampling instead of the default bilinear blur — crisp upscaling for
// small/pixel-art-native images. A module-level side effect rather than something set
// per-Application, since it's a library-wide default this app always wants; harmless if
// this module is imported more than once (setting it again is a no-op in effect). A
// user-uploaded photo/painted-illustration card still displays fine either way — this
// is a rendering default, not a requirement on content.
TextureStyle.defaultOptions.scaleMode = "nearest";

const MERGE_RADIUS = CARD_WIDTH * 0.6;
const ROTATE_HANDLE_OFFSET = CARD_HEIGHT / 2 + 16;
const CAMERA_PAN_SPEED = 400; // world units/second
const CAMERA_ROTATE_SPEED = Math.PI / 2; // radians/second
const PLAYER_TOKEN_RADIUS = 16;
const PLAYER_SEAT_RADIUS = 260;
/** A plain dark canvas gave players no sense of scale or where "the middle" is — a
 * small center marker plus concentric square rings, both centered on world (0, 0),
 * fixes that with nothing more than static Graphics (no textures, no per-frame cost).
 * Not a movement grid or a snapping aid, just a point of reference. */
const TABLE_BACKGROUND_CENTER_RADIUS = 8;
const TABLE_BACKGROUND_RING_SPACING = 150;
const TABLE_BACKGROUND_RING_COUNT = 6;
/** How often a synced drag or rotate sends a "drag-hint"/"rotate-hint"
 * (net/syncProtocol.ts) while it's in progress, so other players see roughly what's
 * happening instead of it teleporting only when the gesture ends — coarse on purpose (a
 * cosmetic preview, not the authoritative position/angle, which is still only ever the
 * final drop/set-rotation), so there's no need for per-frame updates. */
const HINT_INTERVAL_MS = 120;
/** How transparent a pile looks on someone else's screen while a drag-hint says it's
 * being moved — mirrors the alpha a local drag already uses (see beginDrag), reset back
 * to 1 the moment the real, authoritative drop event arrives. */
const REMOTE_DRAG_ALPHA = 0.85;
const CURSOR_RADIUS = 6;
/** Below this many screen pixels of movement, a background pointerdown-then-up is
 * treated as a plain click (clearing the selection) rather than a completed box-select
 * drag — otherwise every ordinary click-to-deselect would also require holding
 * perfectly still. */
const BOX_SELECT_THRESHOLD = 4;
const SELECTION_OUTLINE_COLOR = 0x4fa8ff;
const GROUP_HANDLE_RADIUS = 12;
const GROUP_HANDLE_COLOR = 0xffd24f;

/** Rotate the vector (x, y) by `radians`, using the same rotation convention as
 * PixiJS's own Container.rotation (and this file's existing atan2(dx, -dy) reading of
 * the pointer around a pivot — see makeRotateHandle/onPointerMove) — used to keep a
 * multi-select group rigid while it rotates together around its centroid. */
function rotateVector(x: number, y: number, radians: number): { x: number; y: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

const KEY_TO_INPUT: Record<string, keyof CameraInput> = {
  w: "up", s: "down", a: "left", d: "right", q: "rotateCCW", e: "rotateCW",
};

interface PlayerInfo {
  peerId: string;
  name: string;
  color: string;
  eyesClosed: boolean;
}

export class TableApp implements TableView {
  private app = new Application();
  private world = new Container();
  private model = new TableModel();
  /** Who's viewing this table — needed to render Hide correctly (see
   * docs/ARCHITECTURE.md "Hiding a card"): only this peer sees the true front of
   * anything it hid itself. Defaults to a local-only placeholder until the room
   * assigns a real one (net/signaling.ts's `welcome`); a single-tab sandbox with no
   * room never needs to change it. */
  private selfPeerId = "local";
  /** Routes every mutating action through the host-authoritative sync protocol
   * (net/syncProtocol.ts) once the room assigns one (net/roomConnection.ts) — host or
   * peer, TableApp doesn't need to know which; it just calls sendRequest() and waits
   * for the resulting applyEvent() call to actually update the model/view. Null only
   * in the brief window before a room connection exists (or for a bare, room-less
   * sandbox), during which actions fall back to mutating the local model directly. */
  private syncClient: TableSyncClient | null = null;
  private views = new Map<string, Container>();
  private faceLayers = new Map<string, Container>();
  /** `localFloating` is only ever set when there's no syncClient (a bare, room-less
   * sandbox): it's the actual detached PileState pickUpTop() returned, mutated in place
   * as the pointer moves and handed to dropPile() on release — exactly the pre-M6
   * behavior. Once a syncClient exists, dragging never touches the model at all (see
   * beginDrag/onPointerMove/onPointerUp below): `view` just follows the pointer, and one
   * `pick-up-and-drop` request is sent at release with wherever it ended up, since only
   * the host is allowed to allocate the pile id a stack-split would need (see
   * pileModel.ts's setPile/loadSnapshot doc comment). */
  private dragging: { pileId: string; view: Container; x: number; y: number; localFloating: PileState | null } | null = null;
  private rotating: { pileId: string; view: Container; radians: number } | null = null;
  /** Multi-select (see docs/GAME_DEFINITION.md-adjacent request: "click and drag a box
   * to select multiple cards"). `selectedPileIds` is the source of truth; each id's
   * outline Graphics lives in `selectionOutlines` as a child of that pile's own view
   * (see select()/deselect()). Dragging an empty patch of table draws `boxSelect`'s
   * rectangle in screen space (not world space) so it reads correctly even while the
   * camera is rotated (Q/E) — see the class-level note in beginGroupRotate's doc
   * comment for why screen space matters here. This replaces the old click-drag-to-pan
   * gesture (WASD already covers panning) — see docs/DECISIONS.md. */
  private selectedPileIds = new Set<string>();
  private selectionOutlines = new Map<string, Graphics>();
  private boxSelect: { startX: number; startY: number; endX: number; endY: number; rect: Graphics } | null = null;
  /** A drag that moves every selected pile together, rigidly, by the same screen-space
   * delta — started instead of a normal single-pile beginDrag() when the pile clicked
   * is already part of a 2+ selection (see beginDrag). Positions are only committed
   * (one move-pile request/model mutation per pile) on release; see onPointerUp. */
  private groupDragging: { startPositions: Map<string, { x: number; y: number }>; startLocalX: number; startLocalY: number; dx: number; dy: number } | null = null;
  /** Rotating the whole selection together around its centroid ("center of mass") —
   * see beginGroupRotate. `delta` is the running rotation since the gesture started,
   * updated every pointermove and read back on release to compute each pile's final
   * position/rotation. */
  private groupRotating: {
    centroid: { x: number; y: number };
    startAngle: number;
    delta: number;
    startStates: Map<string, { x: number; y: number; rotation: number }>;
  } | null = null;
  /** A single handle shown at the selection's centroid once 2+ piles are selected —
   * dragging it is what starts a group rotate (see makeGroupRotateHandle). Absent
   * (null) whenever fewer than 2 piles are selected; see updateGroupHandle. */
  private groupHandle: Container | null = null;
  /** Last time (performance.now()) this client sent a drag-hint — see
   * HINT_INTERVAL_MS. Reset to 0 at the start of each synced drag so the very
   * first move sends immediately rather than waiting out the throttle. */
  private lastDragHintAt = 0;
  /** Same idea as lastDragHintAt, for rotate-hint. */
  private lastRotateHintAt = 0;
  private menuEl: HTMLDivElement | null = null;

  // Camera: WASD pans, Q/E rotates — see engine/camera.ts. Each player's own view is
  // independent; nothing here is synced to other peers (that's presence/table state,
  // out of scope for a camera).
  private cameraInput: CameraInput = { ...NO_CAMERA_INPUT };
  private onKeyDown = (e: KeyboardEvent) => this.setCameraKey(e.key.toLowerCase(), true);
  private onKeyUp = (e: KeyboardEvent) => this.setCameraKey(e.key.toLowerCase(), false);

  // Default per-player colored tokens (see docs/GAME_DEFINITION.md's Tokens) — one per
  // connected peer, arranged evenly around the table (seating.ts) so e.g. 3 players form
  // a triangle and 5 a pentagon. Purely local presentation for now: each client places
  // its own copy from the presence list (net/signaling.ts), not yet a synced table
  // object (that needs M6's real P2P object sync).
  private playerTokens = new Map<string, Container>();
  /** peerId -> their current color, refreshed on every setPlayers() call — cursors
   * (below) are colored markers, and this is the only place TableApp knows anyone's
   * color at all. */
  private playerColors = new Map<string, string>();
  /** Other players' live pointer positions ("cursor-hint" — see syncProtocol.ts), kept
   * "always visible" per the explicit request, not just during a drag/rotate gesture.
   * Never includes this client's own cursor — the browser already draws that; see
   * maybeSendCursorHint/applyEvent's "cursor-hint" branch. */
  private cursors = new Map<string, Container>();
  private lastCursorHintAt = 0;

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: container, background: "#2b2a33", antialias: false });
    container.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.position.set(container.clientWidth / 2, container.clientHeight / 2);
    this.world.addChild(this.drawTableBackground()); // added first — behind every pile/token

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointerdown", (e) => this.onBackgroundPointerDown(e));
    this.app.stage.on("pointermove", (e) => this.onPointerMove(e));
    this.app.stage.on("pointerup", () => this.onPointerUp());
    this.app.stage.on("pointerupoutside", () => this.onPointerUp());

    this.app.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerdown", (e) => {
      if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.closeMenu();
    });

    // Keyboard camera controls. Attached to the window (not the canvas) so they work
    // regardless of which element currently has focus, matching how WASD behaves in
    // most browser-based tabletop/game UIs.
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.app.ticker.add((ticker) => this.tickCamera(ticker.deltaMS / 1000));
  }

  destroy(): void {
    this.closeMenu();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.app.destroy(true, { children: true });
  }

  /** Set once the room assigns this tab a real peerId (net/signaling.ts's `welcome`).
   * Re-renders everything currently on the table so any already-hidden card this peer
   * owns (or doesn't) reflects the right viewer immediately, rather than waiting for
   * its next unrelated redraw. */
  setSelfPeerId(peerId: string): void {
    this.selfPeerId = peerId;
    for (const pileId of this.views.keys()) this.redraw(pileId);
  }

  /** The underlying object model — net/roomConnection.ts needs the actual instance
   * (not a copy) so that a host's in-process mutations (via HostTableSync, applied
   * directly to this same TableModel) and TableApp's own rendering never disagree. */
  getModel(): TableModel {
    return this.model;
  }

  /** Start routing actions through the sync protocol instead of mutating the local
   * model directly — called once net/roomConnection.ts establishes this client's role
   * (host or peer). See the `syncClient` field comment for why this can be set late. */
  setSyncClient(client: TableSyncClient): void {
    this.syncClient = client;
  }

  /** TableView: net/roomConnection.ts calls this with whatever the host broadcasts
   * (including the host's own actions looped back to itself) — the *only* way the
   * model/view change once a syncClient is set. See syncProtocol.ts's TableEvent. */
  applyEvent(event: TableEvent): void {
    if (event.type === "pile-upserted") {
      this.model.setPile(event.pile);
      const view = this.views.get(event.pile.id);
      if (view) {
        view.alpha = 1; // in case a drag-hint below had dimmed it — this is the real, final position now
        view.position.set(event.pile.x, event.pile.y);
        view.rotation = event.pile.rotation;
        this.redraw(event.pile.id);
      } else {
        this.mountView(event.pile);
      }
    } else if (event.type === "pile-removed") {
      this.model.removePile(event.pileId);
      this.removeView(event.pileId);
    } else if (event.type === "snapshot") {
      for (const pileId of [...this.views.keys()]) this.removeView(pileId);
      this.clearSelection(); // ids from before a resumed/migrated snapshot may not exist any more
      this.model.loadSnapshot(event.piles);
      for (const pile of event.piles) this.mountView(pile);
    } else if (event.type === "drag-hint") {
      // Purely cosmetic (see syncProtocol.ts's TableEvent doc comment): moves the view
      // to roughly where someone else is dragging it, without touching the model at
      // all — the model still holds wherever it actually was until the real drop
      // arrives as a pile-upserted/pile-removed above, which is what corrects this.
      const view = this.views.get(event.pileId);
      if (view) {
        view.position.set(event.x, event.y);
        view.alpha = REMOTE_DRAG_ALPHA;
      }
    } else if (event.type === "rotate-hint") {
      // Same idea as drag-hint, for the rotate-handle gesture — no alpha dimming
      // here, since a local rotate doesn't dim its own view either.
      const view = this.views.get(event.pileId);
      if (view) view.rotation = event.radians;
    } else if (event.type === "cursor-hint") {
      this.updateCursor(event.byPeerId, event.x, event.y);
    }
  }

  /** Move (creating if needed) the small colored marker showing where `peerId`'s
   * pointer currently is. Redrawn with their latest known color every time, not just
   * on creation, so a color change (the swatch picker) doesn't leave a stale-colored
   * cursor behind. */
  private updateCursor(peerId: string, x: number, y: number): void {
    let marker = this.cursors.get(peerId);
    if (!marker) {
      marker = new Container();
      this.cursors.set(peerId, marker);
      this.world.addChild(marker);
    }
    marker.removeChildren();
    const g = new Graphics();
    g.circle(0, 0, CURSOR_RADIUS);
    g.fill({ color: this.playerColors.get(peerId) ?? "#888888" });
    g.stroke({ width: 1.5, color: 0x1a1a1a });
    marker.addChild(g);
    marker.position.set(x, y);
  }

  // --- Camera: WASD pan, Q/E rotate (engine/camera.ts does the actual math) ---

  private setCameraKey(key: string, pressed: boolean): void {
    const field = KEY_TO_INPUT[key];
    if (field) this.cameraInput = { ...this.cameraInput, [field]: pressed };
  }

  private tickCamera(dtSeconds: number): void {
    const next = stepCamera(
      { x: this.world.position.x, y: this.world.position.y, rotation: this.world.rotation },
      this.cameraInput,
      dtSeconds,
      CAMERA_PAN_SPEED * this.world.scale.x,
      CAMERA_ROTATE_SPEED,
    );
    this.world.position.set(next.x, next.y);
    this.world.rotation = next.rotation;
  }

  // --- Default player tokens: one colored marker per connected peer, arranged around
  // the table. Call this whenever the presence list changes (join/leave/color change). ---

  setPlayers(players: PlayerInfo[]): void {
    const seats = computeSeatPositions(players.length, PLAYER_SEAT_RADIUS);
    const seen = new Set<string>();
    this.playerColors = new Map(players.map((p) => [p.peerId, p.color]));

    players.forEach((player, i) => {
      seen.add(player.peerId);
      let view = this.playerTokens.get(player.peerId);
      if (!view) {
        view = this.mountPlayerToken(player);
        this.playerTokens.set(player.peerId, view);
      } else {
        this.redrawPlayerToken(view, player);
      }
      // Only place it at its default seat until a player first drags it somewhere else
      // (tracked via a flag on the view itself, since there's no model entry for it).
      if (!(view as Container & { moved?: boolean }).moved) {
        view.position.set(seats[i].x, seats[i].y);
      }
    });

    for (const [peerId, view] of this.playerTokens) {
      if (!seen.has(peerId)) {
        this.world.removeChild(view);
        this.playerTokens.delete(peerId);
      }
    }

    // A cursor for someone who's left has nothing more to show — drop it rather than
    // leaving a stale marker frozen at their last known position.
    for (const [peerId, view] of this.cursors) {
      if (!seen.has(peerId)) {
        this.world.removeChild(view);
        this.cursors.delete(peerId);
      }
    }
  }

  private mountPlayerToken(player: PlayerInfo): Container {
    const view = new Container();
    this.redrawPlayerToken(view, player);
    view.eventMode = "static";
    view.cursor = "grab";
    let dragging = false;
    view.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      dragging = true;
    });
    this.app.stage.on("pointermove", (e: FederatedPointerEvent) => {
      if (!dragging) return;
      const local = this.world.toLocal(e.global);
      view.position.set(local.x, local.y);
      (view as Container & { moved?: boolean }).moved = true;
    });
    this.app.stage.on("pointerup", () => (dragging = false));
    this.app.stage.on("pointerupoutside", () => (dragging = false));
    this.world.addChild(view);
    return view;
  }

  private redrawPlayerToken(view: Container, player: PlayerInfo): void {
    view.removeChildren();
    const g = new Graphics();
    g.circle(0, 0, PLAYER_TOKEN_RADIUS);
    g.fill({ color: player.color });
    g.stroke({ width: 2, color: 0x1a1a1a });
    view.addChild(g);
    // Eyes-closed replaces the initial-letter glyph with the same closed-eye emoji the
    // presence list uses, so anyone glancing at the table (not just the sidebar) can
    // tell who's not looking — the actual reveal-moment mechanic (docs/GAME_DEFINITION.md
    // adjacent: Avalon/Mafia-style team reveals) needs everyone else to be able to see
    // this, not just the player themselves.
    const label = new Text({
      text: player.eyesClosed ? "\u{1F648}" : player.name.slice(0, 1).toUpperCase(),
      style: { fontFamily: "monospace", fontSize: player.eyesClosed ? 12 : 14, fill: 0x1a1a1a, fontWeight: "bold" },
    });
    label.anchor.set(0.5);
    view.addChild(label);
  }

  /** Spawn a brand-new standalone pile (a GM-only action per the object model — see
   * docs/ARCHITECTURE.md "Roles: GM vs. players"; this demo doesn't gate it yet). Once a
   * syncClient is set, this — like every other mutating method below — sends a request
   * and waits for applyEvent() to actually create it, rather than mutating the local
   * model itself: only the host's TableModel is ever allowed to allocate a pile id
   * (see pileModel.ts's setPile/loadSnapshot doc comment), and TableApp doesn't know
   * whether it's the host. */
  spawnCard(def: CardDef, worldX: number, worldY: number): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "spawn", def, x: worldX, y: worldY });
    } else {
      this.mountView(this.model.spawnCard(def, worldX, worldY));
    }
  }

  /** Same idea as spawnCard, for a whole already-stacked pile at once (TableModel's
   * spawnStack — see its own doc comment) — a game package's card set appearing as one
   * shufflable stack instead of N separate piles. */
  spawnStack(defs: CardDef[], worldX: number, worldY: number): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "spawn-stack", defs, x: worldX, y: worldY });
    } else {
      const pile = this.model.spawnStack(defs, worldX, worldY);
      if (pile) this.mountView(pile);
    }
  }

  /** A static reference marker — see TABLE_BACKGROUND_*'s doc comment — drawn once at
   * init() and never redrawn (it doesn't represent any model state, so there's nothing
   * to keep in sync). */
  private drawTableBackground(): Graphics {
    const g = new Graphics();
    g.circle(0, 0, TABLE_BACKGROUND_CENTER_RADIUS);
    g.fill({ color: 0x3a3947 });
    for (let i = 1; i <= TABLE_BACKGROUND_RING_COUNT; i++) {
      const half = i * TABLE_BACKGROUND_RING_SPACING;
      g.rect(-half, -half, half * 2, half * 2);
      g.stroke({ width: 2, color: 0x35333f });
    }
    return g;
  }

  // --- Wiring a PileState to an on-screen Container. The view is purely a rendering
  // of whatever the model says; every handler below reads/writes the model first and
  // re-renders after, never the other way around. ---

  private mountView(pile: PileState): Container {
    const view = new Container();
    view.position.set(pile.x, pile.y);
    view.rotation = pile.rotation;
    view.eventMode = "static";
    view.cursor = "grab";
    view.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (e.button === 2) return; // handled by rightclick below
      // Clicking a pile that isn't already part of the current multi-selection acts
      // exactly like before (drag just that one pile) and drops any existing
      // selection; clicking one that *is* selected instead drags the whole group —
      // see beginDrag.
      if (!this.selectedPileIds.has(pile.id)) this.clearSelection();
      this.beginDrag(pile.id, e);
    });
    view.on("rightclick", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (this.selectedPileIds.size > 1 && this.selectedPileIds.has(pile.id)) {
        this.openGroupMenu(e.globalX, e.globalY);
      } else {
        this.openMenu(pile.id, e.globalX, e.globalY);
      }
    });
    view.on("dblclick", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.doFlip(pile.id);
    });

    // The face is drawn into its own child container, not `view` directly, so redraw()
    // (which clears and repaints it every time) never wipes out the rotate handle below.
    const faceLayer = new Container();
    view.addChild(faceLayer);
    this.faceLayers.set(pile.id, faceLayer);

    view.addChild(this.makeRotateHandle(pile.id));

    this.world.addChild(view);
    this.views.set(pile.id, view);
    this.redraw(pile.id);
    return view;
  }

  /** A small handle above the card, draggable to rotate it continuously — see
   * docs/GAME_DEFINITION.md's request: players seated around the table (seating.ts)
   * need to orient their own cards to face themselves, not just the 90°-step rotation
   * on the right-click menu. */
  private makeRotateHandle(pileId: string): Container {
    const handle = new Graphics();
    handle.circle(0, -ROTATE_HANDLE_OFFSET, 5);
    handle.fill({ color: 0xffffff, alpha: 0.6 });
    handle.stroke({ width: 1, color: 0x1a1a1a });
    handle.eventMode = "static";
    handle.cursor = "grab";
    handle.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      const view = this.views.get(pileId);
      if (view) this.rotating = { pileId, view, radians: view.rotation };
      this.lastRotateHintAt = 0; // let the very first move below send a hint immediately
    });
    return handle;
  }

  private redraw(pileId: string): void {
    const pile = this.model.getPile(pileId);
    const faceLayer = this.faceLayers.get(pileId);
    if (!pile || !faceLayer) return;
    const top = pile.cards[pile.cards.length - 1];
    renderCard(faceLayer, top.def, top.faceUp, top.hiddenBy, this.selfPeerId, pile.cards.length);
  }

  private removeView(pileId: string): void {
    const view = this.views.get(pileId);
    if (view) {
      this.world.removeChild(view);
      this.views.delete(pileId);
      this.faceLayers.delete(pileId);
    }
    // A pile that no longer exists (merged away, collapsed into a deck, removed) can't
    // stay selected — its outline lived on `view`, which is now gone too.
    this.selectionOutlines.delete(pileId);
    this.deselect(pileId);
  }

  // --- Multi-select: box-select a rectangle of piles, then move/rotate/flip/hide/
  // collapse them together. See the selectedPileIds/boxSelect/groupDragging/
  // groupRotating field comments above for the overall design. ---

  private select(pileId: string): void {
    if (this.selectedPileIds.has(pileId)) return;
    this.selectedPileIds.add(pileId);
    const view = this.views.get(pileId);
    if (view) {
      const outline = new Graphics();
      outline.rect(-CARD_WIDTH / 2 - 4, -CARD_HEIGHT / 2 - 4, CARD_WIDTH + 8, CARD_HEIGHT + 8);
      outline.stroke({ width: 3, color: SELECTION_OUTLINE_COLOR });
      // Added behind the face layer (index 0) so it reads as a border around the card
      // rather than a rectangle drawn on top of it.
      view.addChildAt(outline, 0);
      this.selectionOutlines.set(pileId, outline);
    }
    this.updateGroupHandle();
  }

  private deselect(pileId: string): void {
    if (!this.selectedPileIds.delete(pileId)) return;
    const outline = this.selectionOutlines.get(pileId);
    const view = this.views.get(pileId);
    if (outline && view) view.removeChild(outline);
    this.selectionOutlines.delete(pileId);
    this.updateGroupHandle();
  }

  private clearSelection(): void {
    for (const pileId of [...this.selectedPileIds]) this.deselect(pileId);
  }

  private selectionCentroid(): { x: number; y: number } | null {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const pileId of this.selectedPileIds) {
      const pile = this.model.getPile(pileId);
      if (!pile) continue;
      sumX += pile.x;
      sumY += pile.y;
      count++;
    }
    return count > 0 ? { x: sumX / count, y: sumY / count } : null;
  }

  /** Create/reposition/remove the group rotate handle to match the current selection —
   * called whenever selection membership changes. Left alone (not re-created) during
   * an active group drag/rotate, which reposition it directly for smoothness. */
  private updateGroupHandle(): void {
    if (this.selectedPileIds.size < 2) {
      this.removeGroupHandle();
      return;
    }
    const centroid = this.selectionCentroid();
    if (!centroid) {
      this.removeGroupHandle();
      return;
    }
    if (!this.groupHandle) {
      this.groupHandle = this.makeGroupRotateHandle();
      this.world.addChild(this.groupHandle);
    }
    this.groupHandle.position.set(centroid.x, centroid.y);
  }

  private removeGroupHandle(): void {
    if (this.groupHandle) {
      this.world.removeChild(this.groupHandle);
      this.groupHandle = null;
    }
  }

  /** A diamond-shaped handle at the selection's centroid — distinct from the small
   * circular per-pile rotate handle (makeRotateHandle) so it's clear this one rotates
   * the whole group, not just one card. */
  private makeGroupRotateHandle(): Container {
    const handle = new Graphics();
    handle.moveTo(0, -GROUP_HANDLE_RADIUS).lineTo(GROUP_HANDLE_RADIUS, 0).lineTo(0, GROUP_HANDLE_RADIUS).lineTo(-GROUP_HANDLE_RADIUS, 0).closePath();
    handle.fill({ color: GROUP_HANDLE_COLOR, alpha: 0.85 });
    handle.stroke({ width: 1.5, color: 0x1a1a1a });
    handle.eventMode = "static";
    handle.cursor = "grab";
    handle.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.beginGroupRotate(e);
    });
    return handle;
  }

  private beginGroupDrag(e: FederatedPointerEvent): void {
    const local = this.world.toLocal(e.global);
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const pileId of this.selectedPileIds) {
      const pile = this.model.getPile(pileId);
      if (pile) startPositions.set(pileId, { x: pile.x, y: pile.y });
    }
    this.groupDragging = { startPositions, startLocalX: local.x, startLocalY: local.y, dx: 0, dy: 0 };
    for (const pileId of startPositions.keys()) {
      const view = this.views.get(pileId);
      if (view) view.alpha = 0.85;
    }
  }

  /** Mirrors the per-pile rotate handle's pointerdown (makeRotateHandle), but for the
   * whole selection at once: records everyone's starting (x, y, rotation) and the
   * pointer's starting bearing around the centroid, so onPointerMove/onPointerUp only
   * need to track how much that bearing has changed. */
  private beginGroupRotate(e: FederatedPointerEvent): void {
    const centroid = this.selectionCentroid();
    if (!centroid) return;
    const local = this.world.toLocal(e.global);
    const startAngle = Math.atan2(local.x - centroid.x, -(local.y - centroid.y));
    const startStates = new Map<string, { x: number; y: number; rotation: number }>();
    for (const pileId of this.selectedPileIds) {
      const pile = this.model.getPile(pileId);
      if (pile) startStates.set(pileId, { x: pile.x, y: pile.y, rotation: pile.rotation });
    }
    this.groupRotating = { centroid, startAngle, delta: 0, startStates };
  }

  private doGroupFlip(pileIds: string[]): void {
    for (const pileId of pileIds) this.doFlip(pileId);
  }

  private doGroupToggleHide(pileIds: string[]): void {
    for (const pileId of pileIds) this.doToggleHide(pileId);
  }

  /** "Collapse into a deck" — merge the whole selection into one new pile at its
   * centroid, via TableModel.collapseIntoStack (see its own doc comment). */
  private doGroupCollapse(pileIds: string[]): void {
    const centroid = this.selectionCentroid() ?? { x: 0, y: 0 };
    this.clearSelection();
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "collapse-into-stack", pileIds, x: centroid.x, y: centroid.y });
    } else {
      const pile = this.model.collapseIntoStack(pileIds, centroid.x, centroid.y);
      for (const pileId of pileIds) this.removeView(pileId);
      if (pile) this.mountView(pile);
    }
  }

  // --- Dragging ---

  private beginDrag(pileId: string, e: FederatedPointerEvent): void {
    if (this.dragging || this.groupDragging) return;

    // Dragging a pile that's part of a 2+ selection moves the whole group together
    // instead — see beginGroupDrag and the selectedPileIds field comment.
    if (this.selectedPileIds.size > 1 && this.selectedPileIds.has(pileId)) {
      this.beginGroupDrag(e);
      return;
    }

    if (this.syncClient) {
      // Don't touch the model at all: splitting a stack allocates a new pile id, and
      // only the host is allowed to do that (see the `dragging` field's doc comment
      // above). Just grab the pile's existing view and follow the pointer with it —
      // pick-up-and-drop is a single atomic request sent once, on release.
      const view = this.views.get(pileId);
      const pile = this.model.getPile(pileId);
      if (!view || !pile) return;
      this.dragging = { pileId, view, x: pile.x, y: pile.y, localFloating: null };
      this.lastDragHintAt = 0; // let the very first move below send a hint immediately
    } else {
      // No syncClient (a bare, room-less sandbox) — the pre-M6 behavior: actually split
      // the stack locally right away, since there's no other peer's model to diverge
      // from.
      const floating = this.model.pickUpTop(pileId);
      if (!floating) return;
      const sourceView = this.views.get(pileId);
      let view: Container;
      if (floating.id === pileId) {
        // The whole pile was picked up (it only had one card) — reuse its existing view.
        view = sourceView!;
      } else {
        // Only the top card came off; the remainder pile stays put under its own view.
        if (sourceView) this.redraw(pileId);
        view = this.mountView(floating);
      }
      this.dragging = { pileId: floating.id, view, x: floating.x, y: floating.y, localFloating: floating };
    }

    this.dragging.view.alpha = 0.85;
    this.dragging.view.zIndex = 1000;
  }

  /** Send a coarse, throttled drag-hint (see HINT_INTERVAL_MS) — never touches
   * this client's own model or view, since this client is already moving the real
   * view locally; it's purely so *other* players see it too before the drop. A no-op
   * when there's no syncClient at all (a bare, room-less sandbox has no one else to
   * show it to). */
  private maybeSendDragHint(pileId: string, x: number, y: number): void {
    if (!this.syncClient) return;
    const now = performance.now();
    if (now - this.lastDragHintAt < HINT_INTERVAL_MS) return;
    this.lastDragHintAt = now;
    this.syncClient.sendRequest({ type: "drag-hint", pileId, x, y });
  }

  /** Same idea as maybeSendDragHint, for the rotate-handle gesture. */
  private maybeSendRotateHint(pileId: string, radians: number): void {
    if (!this.syncClient) return;
    const now = performance.now();
    if (now - this.lastRotateHintAt < HINT_INTERVAL_MS) return;
    this.lastRotateHintAt = now;
    this.syncClient.sendRequest({ type: "rotate-hint", pileId, radians });
  }

  /** Same idea as maybeSendDragHint/maybeSendRotateHint, for this client's own pointer
   * position — see syncProtocol.ts's "cursor-hint" doc comment for why this fires all
   * the time, not just mid-gesture. */
  private maybeSendCursorHint(x: number, y: number): void {
    if (!this.syncClient) return;
    const now = performance.now();
    if (now - this.lastCursorHintAt < HINT_INTERVAL_MS) return;
    this.lastCursorHintAt = now;
    this.syncClient.sendRequest({ type: "cursor-hint", x, y });
  }

  private onBackgroundPointerDown(e: FederatedPointerEvent): void {
    if (e.target !== this.app.stage) return;
    // Starts a box-select drag in screen space (e.global), not world space — see the
    // boxSelect field's doc comment for why (the camera can be rotated with Q/E, so an
    // axis-aligned rectangle only means "what's visually inside the box" in screen
    // space). This replaces the old click-drag-to-pan gesture; WASD still pans.
    const rect = new Graphics();
    this.app.stage.addChild(rect);
    this.boxSelect = { startX: e.global.x, startY: e.global.y, endX: e.global.x, endY: e.global.y, rect };
  }

  private redrawBoxSelectRect(): void {
    const { startX, startY, endX, endY, rect } = this.boxSelect!;
    rect.clear();
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);
    rect.rect(x, y, w, h);
    rect.fill({ color: SELECTION_OUTLINE_COLOR, alpha: 0.12 });
    rect.stroke({ width: 1, color: SELECTION_OUTLINE_COLOR });
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    // Sent regardless of what else is going on (dragging, rotating, panning, or just
    // hovering) — "client cursors should also show up always... to make it feel more
    // alive," not only mid-gesture like drag/rotate-hint.
    const local = this.world.toLocal(e.global);
    this.maybeSendCursorHint(local.x, local.y);

    if (this.boxSelect) {
      this.boxSelect.endX = e.global.x;
      this.boxSelect.endY = e.global.y;
      this.redrawBoxSelectRect();
    } else if (this.groupRotating) {
      const { centroid, startAngle, startStates } = this.groupRotating;
      const angle = Math.atan2(local.x - centroid.x, -(local.y - centroid.y));
      this.groupRotating.delta = angle - startAngle;
      for (const [pileId, start] of startStates) {
        const view = this.views.get(pileId);
        if (!view) continue;
        const offset = rotateVector(start.x - centroid.x, start.y - centroid.y, this.groupRotating.delta);
        view.position.set(centroid.x + offset.x, centroid.y + offset.y);
        view.rotation = start.rotation + this.groupRotating.delta;
      }
    } else if (this.groupDragging) {
      const g = this.groupDragging;
      g.dx = local.x - g.startLocalX;
      g.dy = local.y - g.startLocalY;
      for (const [pileId, start] of g.startPositions) {
        const view = this.views.get(pileId);
        if (view) view.position.set(start.x + g.dx, start.y + g.dy);
      }
      if (this.groupHandle) {
        const centroid = this.selectionCentroid();
        if (centroid) this.groupHandle.position.set(centroid.x + g.dx, centroid.y + g.dy);
      }
    } else if (this.rotating) {
      const angle = Math.atan2(local.x - this.rotating.view.position.x, -(local.y - this.rotating.view.position.y));
      this.rotating.radians = angle;
      this.rotating.view.rotation = angle;
      if (!this.syncClient) this.model.setRotation(this.rotating.pileId, angle);
      else this.maybeSendRotateHint(this.rotating.pileId, angle);
    } else if (this.dragging) {
      this.dragging.x = local.x;
      this.dragging.y = local.y;
      this.dragging.view.position.set(local.x, local.y);
      if (this.dragging.localFloating) {
        this.dragging.localFloating.x = local.x;
        this.dragging.localFloating.y = local.y;
      } else {
        this.maybeSendDragHint(this.dragging.pileId, local.x, local.y);
      }
    }
  }

  private onPointerUp(): void {
    if (this.boxSelect) {
      const { startX, startY, endX, endY, rect } = this.boxSelect;
      this.boxSelect = null;
      this.app.stage.removeChild(rect);

      if (Math.abs(endX - startX) < BOX_SELECT_THRESHOLD && Math.abs(endY - startY) < BOX_SELECT_THRESHOLD) {
        // Too small a drag to be a real box — treat it as a plain click on empty
        // table, which clears whatever was selected.
        this.clearSelection();
      } else {
        const minX = Math.min(startX, endX);
        const maxX = Math.max(startX, endX);
        const minY = Math.min(startY, endY);
        const maxY = Math.max(startY, endY);
        const inBox: string[] = [];
        for (const [pileId, view] of this.views) {
          const global = view.getGlobalPosition();
          if (global.x >= minX && global.x <= maxX && global.y >= minY && global.y <= maxY) inBox.push(pileId);
        }
        this.clearSelection();
        for (const pileId of inBox) this.select(pileId);
      }
    }

    if (this.groupRotating) {
      const { centroid, delta, startStates } = this.groupRotating;
      this.groupRotating = null;
      for (const [pileId, start] of startStates) {
        const offset = rotateVector(start.x - centroid.x, start.y - centroid.y, delta);
        const x = centroid.x + offset.x;
        const y = centroid.y + offset.y;
        const rotation = start.rotation + delta;
        if (this.syncClient) {
          this.syncClient.sendRequest({ type: "move-pile", pileId, x, y });
          this.syncClient.sendRequest({ type: "set-rotation", pileId, radians: rotation });
        } else {
          this.model.movePile(pileId, x, y);
          this.model.setRotation(pileId, rotation);
          const view = this.views.get(pileId);
          if (view) {
            view.position.set(x, y);
            view.rotation = rotation;
          }
        }
      }
      this.updateGroupHandle();
    }

    if (this.groupDragging) {
      const { startPositions, dx, dy } = this.groupDragging;
      this.groupDragging = null;
      for (const [pileId, start] of startPositions) {
        const x = start.x + dx;
        const y = start.y + dy;
        const view = this.views.get(pileId);
        if (view) view.alpha = 1;
        if (this.syncClient) {
          this.syncClient.sendRequest({ type: "move-pile", pileId, x, y });
        } else {
          this.model.movePile(pileId, x, y);
          if (view) view.position.set(x, y);
        }
      }
      this.updateGroupHandle();
    }

    if (this.rotating) {
      const { pileId, radians } = this.rotating;
      this.rotating = null;
      if (this.syncClient) this.syncClient.sendRequest({ type: "set-rotation", pileId, radians });
      // else: onPointerMove already applied it directly to the model as it moved.
    }

    if (!this.dragging) return;
    const { pileId, view, x, y, localFloating } = this.dragging;
    this.dragging = null;
    view.alpha = 1;

    if (this.syncClient) {
      // One request for the whole gesture — see the `dragging` field's doc comment.
      // Whatever actually happens (placed, merged, or a stack-split leaving a
      // remainder behind) comes back through applyEvent(), which is the only thing
      // allowed to move this view now.
      this.syncClient.sendRequest({ type: "pick-up-and-drop", pileId, x, y, mergeRadius: MERGE_RADIUS });
      return;
    }

    const result = this.model.dropPile(localFloating!, x, y, MERGE_RADIUS);
    if (result.kind === "merged") {
      this.removeView(pileId);
      this.redraw(result.targetId);
    } else {
      this.views.set(pileId, view);
      this.redraw(pileId);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(3, Math.max(0.3, this.world.scale.x * factor));
    this.world.scale.set(newScale);
  }

  // --- Per-pile actions, available from the right-click menu. See
  // docs/NETWORKING.md "Trust model": any player can do any of these to any pile —
  // there's no ownership lock, matching a physical table. ---

  private doFlip(pileId: string): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "flip", pileId });
      return;
    }
    this.model.flip(pileId);
    this.redraw(pileId);
  }

  private doToggleHide(pileId: string): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "toggle-hide", pileId });
      return;
    }
    this.model.toggleHide(pileId, this.selfPeerId);
    this.redraw(pileId);
  }

  private rotate90(pileId: string): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "rotate-by", pileId, deltaRadians: Math.PI / 2 });
      return;
    }
    this.model.rotate90(pileId);
    const pile = this.model.getPile(pileId);
    const view = this.views.get(pileId);
    if (pile && view) view.rotation = pile.rotation;
  }

  private shuffle(pileId: string): void {
    if (this.syncClient) {
      // Resolved once by the host so every peer agrees — see syncProtocol.ts.
      this.syncClient.sendRequest({ type: "shuffle", pileId });
      return;
    }
    this.model.shuffle(pileId);
    this.redraw(pileId);
  }

  private drawTopCard(pileId: string): void {
    if (this.syncClient) {
      this.syncClient.sendRequest({ type: "draw-top", pileId, offsetX: CARD_WIDTH * 0.7, offsetY: 0 });
      return;
    }
    const drawn = this.model.drawTop(pileId, CARD_WIDTH * 0.7, 0);
    if (!drawn) return;
    this.redraw(pileId);
    this.mountView(drawn);
  }

  // --- A minimal right-click menu, plain DOM overlay (not part of the PixiJS scene). ---

  private openMenu(pileId: string, screenX: number, screenY: number): void {
    this.closeMenu();
    const top = this.model.topCard(pileId);
    if (!top) return;
    const pile = this.model.getPile(pileId)!;

    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;

    const items: [string, () => void][] = [
      ["Flip", () => this.doFlip(pileId)],
      [top.hiddenBy !== null ? "Unhide" : "Hide", () => this.doToggleHide(pileId)],
      ["Rotate 90°", () => this.rotate90(pileId)],
    ];
    if (pile.cards.length > 1) {
      items.push(["Shuffle", () => this.shuffle(pileId)]);
      items.push(["Draw top card", () => this.drawTopCard(pileId)]);
    }

    for (const [label, action] of items) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.onclick = () => {
        action();
        this.closeMenu();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    this.menuEl = menu;
  }

  /** The right-click menu for a multi-selected pile — flip/hide/collapse the whole
   * selection at once, rather than the single-pile menu's per-card actions. */
  private openGroupMenu(screenX: number, screenY: number): void {
    this.closeMenu();
    const pileIds = [...this.selectedPileIds];

    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;

    const items: [string, () => void][] = [
      [`Flip all (${pileIds.length})`, () => this.doGroupFlip(pileIds)],
      [`Hide/unhide all (${pileIds.length})`, () => this.doGroupToggleHide(pileIds)],
      ["Collapse into a deck", () => this.doGroupCollapse(pileIds)],
    ];

    for (const [label, action] of items) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.onclick = () => {
        action();
        this.closeMenu();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    this.menuEl = menu;
  }

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}
