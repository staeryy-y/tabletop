// The shared table: pan/zoom, and PixiJS rendering/pointer-event handling over the pure
// game logic in pileModel.ts. This file deliberately holds *no* game rules of its own —
// merge distance aside, everything about what a drag/flip/hide/shuffle/draw actually
// does lives in TableModel, which is unit-tested directly (pileModel.test.ts) without
// needing PixiJS, a canvas, or WebGL at all.
//
// This is the M3 milestone (docs/PLAN.md): the sandbox works entirely locally in this
// tab for now. Syncing it P2P over WebRTC (and the WS-relay fallback) is M6 and isn't
// wired up here yet — see net/signaling.ts.
import { Application, Container, FederatedPointerEvent, Graphics, Text } from "pixi.js";
import { CameraInput, NO_CAMERA_INPUT, stepCamera } from "./camera";
import { CARD_HEIGHT, CARD_WIDTH, CardDef, renderCard } from "./card";
import { PileState, TableModel } from "./pileModel";
import { computeSeatPositions } from "./seating";

const MERGE_RADIUS = CARD_WIDTH * 0.6;
const ROTATE_HANDLE_OFFSET = CARD_HEIGHT / 2 + 16;
const CAMERA_PAN_SPEED = 400; // world units/second
const CAMERA_ROTATE_SPEED = Math.PI / 2; // radians/second
const PLAYER_TOKEN_RADIUS = 16;
const PLAYER_SEAT_RADIUS = 260;

const KEY_TO_INPUT: Record<string, keyof CameraInput> = {
  w: "up", s: "down", a: "left", d: "right", q: "rotateCCW", e: "rotateCW",
};

interface PlayerInfo {
  peerId: string;
  name: string;
  color: string;
}

export class TableApp {
  private app = new Application();
  private world = new Container();
  private model = new TableModel();
  private views = new Map<string, Container>();
  private faceLayers = new Map<string, Container>();
  private dragging: { pile: PileState; view: Container } | null = null;
  private rotating: { pileId: string; view: Container } | null = null;
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
    const label = new Text({
      text: player.name.slice(0, 1).toUpperCase(),
      style: { fontFamily: "monospace", fontSize: 14, fill: 0x1a1a1a, fontWeight: "bold" },
    });
    label.anchor.set(0.5);
    view.addChild(label);
  }

  /** Spawn a brand-new standalone pile (a GM-only action per the object model — see
   * docs/ARCHITECTURE.md "Roles: GM vs. players"; this demo doesn't gate it yet). */
  spawnCard(def: CardDef, worldX: number, worldY: number): void {
    const pile = this.model.spawnCard(def, worldX, worldY);
    this.mountView(pile);
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
      this.model.flip(pile.id);
      this.redraw(pile.id);
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
      if (view) this.rotating = { pileId, view };
    });
    return handle;
  }

  private redraw(pileId: string): void {
    const pile = this.model.getPile(pileId);
    const faceLayer = this.faceLayers.get(pileId);
    if (!pile || !faceLayer) return;
    const top = pile.cards[pile.cards.length - 1];
    renderCard(faceLayer, top.def, top.faceUp, top.hidden, pile.cards.length);
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
    const floating = this.model.pickUpTop(pileId);
    if (!floating) return;

    const sourceView = this.views.get(pileId);
    if (floating.id === pileId) {
      // The whole pile was picked up (it only had one card) — reuse its existing view.
      this.dragging = { pile: floating, view: sourceView! };
    } else {
      // Only the top card came off; the remainder pile stays put under its own view.
      if (sourceView) this.redraw(pileId);
      const view = this.mountView(floating);
      this.dragging = { pile: floating, view };
    }
    this.dragging.view.alpha = 0.85;
    this.dragging.view.zIndex = 1000;
  }

  private onBackgroundPointerDown(e: FederatedPointerEvent): void {
    if (e.target === this.app.stage) this.panning = true;
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (this.rotating) {
      const local = this.world.toLocal(e.global);
      const angle = Math.atan2(local.x - this.rotating.view.position.x, -(local.y - this.rotating.view.position.y));
      this.model.setRotation(this.rotating.pileId, angle);
      this.rotating.view.rotation = angle;
    } else if (this.dragging) {
      const local = this.world.toLocal(e.global);
      this.dragging.pile.x = local.x;
      this.dragging.pile.y = local.y;
      this.dragging.view.position.set(local.x, local.y);
    } else if (this.panning) {
      this.world.position.x += e.movementX;
      this.world.position.y += e.movementY;
    }
  }

  private onPointerUp(): void {
    this.panning = false;
    this.rotating = null;
    if (!this.dragging) return;
    const { pile, view } = this.dragging;
    this.dragging = null;
    view.alpha = 1;

    const result = this.model.dropPile(pile, pile.x, pile.y, MERGE_RADIUS);
    if (result.kind === "merged") {
      this.removeView(pile.id);
      this.redraw(result.targetId);
    } else {
      this.views.set(pile.id, view);
      this.redraw(pile.id);
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

  private rotate90(pileId: string): void {
    this.model.rotate90(pileId);
    const pile = this.model.getPile(pileId);
    const view = this.views.get(pileId);
    if (pile && view) view.rotation = pile.rotation;
  }

  private shuffle(pileId: string): void {
    this.model.shuffle(pileId);
    this.redraw(pileId);
  }

  private drawTopCard(pileId: string): void {
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
      ["Flip", () => { this.model.flip(pileId); this.redraw(pileId); }],
      [top.hidden ? "Unhide" : "Hide", () => { this.model.toggleHide(pileId); this.redraw(pileId); }],
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
