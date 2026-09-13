// The shared table: pan/zoom, and PixiJS rendering/pointer-event handling over the pure
// game logic in pileModel.ts. This file deliberately holds *no* game rules of its own —
// merge distance aside, everything about what a drag/flip/hide/shuffle/draw actually
// does lives in TableModel, which is unit-tested directly (pileModel.test.ts) without
// needing PixiJS, a canvas, or WebGL at all.
//
// This is the M3 milestone (docs/PLAN.md): the sandbox works entirely locally in this
// tab for now. Syncing it P2P over WebRTC (and the WS-relay fallback) is M6 and isn't
// wired up here yet — see net/signaling.ts.
import { Application, Container, FederatedPointerEvent } from "pixi.js";
import { CARD_WIDTH, CardDef, renderCard } from "./card";
import { PileState, TableModel } from "./pileModel";

const MERGE_RADIUS = CARD_WIDTH * 0.6;

export class TableApp {
  private app = new Application();
  private world = new Container();
  private model = new TableModel();
  private views = new Map<string, Container>();
  private dragging: { pile: PileState; view: Container } | null = null;
  private panning = false;
  private menuEl: HTMLDivElement | null = null;

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
  }

  destroy(): void {
    this.closeMenu();
    this.app.destroy(true, { children: true });
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
    this.world.addChild(view);
    this.views.set(pile.id, view);
    this.redraw(pile.id);
    return view;
  }

  private redraw(pileId: string): void {
    const pile = this.model.getPile(pileId);
    const view = this.views.get(pileId);
    if (!pile || !view) return;
    const top = pile.cards[pile.cards.length - 1];
    renderCard(view, top.def, top.faceUp, top.hidden, pile.cards.length);
  }

  private removeView(pileId: string): void {
    const view = this.views.get(pileId);
    if (view) {
      this.world.removeChild(view);
      this.views.delete(pileId);
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
    if (this.dragging) {
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
