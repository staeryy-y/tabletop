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
  /** Last time (performance.now()) this client sent a drag-hint — see
   * HINT_INTERVAL_MS. Reset to 0 at the start of each synced drag so the very
   * first move sends immediately rather than waiting out the throttle. */
  private lastDragHintAt = 0;
  /** Same idea as lastDragHintAt, for rotate-hint. */
  private lastRotateHintAt = 0;
  private panning = false;
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

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: container, background: "#2b2a33", antialias: false });
    container.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.position.set(container.clientWidth / 2, container.clientHeight / 2);

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
    }
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
      this.beginDrag(pile.id, e);
    });
    view.on("rightclick", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.openMenu(pile.id, e.globalX, e.globalY);
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
  }

  // --- Dragging ---

  private beginDrag(pileId: string, e: FederatedPointerEvent): void {
    if (this.dragging) return;

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

  private onBackgroundPointerDown(e: FederatedPointerEvent): void {
    if (e.target === this.app.stage) this.panning = true;
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (this.rotating) {
      const local = this.world.toLocal(e.global);
      const angle = Math.atan2(local.x - this.rotating.view.position.x, -(local.y - this.rotating.view.position.y));
      this.rotating.radians = angle;
      this.rotating.view.rotation = angle;
      if (!this.syncClient) this.model.setRotation(this.rotating.pileId, angle);
      else this.maybeSendRotateHint(this.rotating.pileId, angle);
    } else if (this.dragging) {
      const local = this.world.toLocal(e.global);
      this.dragging.x = local.x;
      this.dragging.y = local.y;
      this.dragging.view.position.set(local.x, local.y);
      if (this.dragging.localFloating) {
        this.dragging.localFloating.x = local.x;
        this.dragging.localFloating.y = local.y;
      } else {
        this.maybeSendDragHint(this.dragging.pileId, local.x, local.y);
      }
    } else if (this.panning) {
      this.world.position.x += e.movementX;
      this.world.position.y += e.movementY;
    }
  }

  private onPointerUp(): void {
    this.panning = false;

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

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}
