// The shared table: pan/zoom, and the Card/Stack object model from
// docs/ARCHITECTURE.md "Object model" / docs/GAME_DEFINITION.md "Cards are the
// workhorse". A "Pile" here is the implementation of both a standalone Card (a pile of
// one) and a Stack (a pile of more than one) — per the docs, a Stack isn't an authored
// type, it's what a pile of Cards becomes, so one data structure covers both.
//
// This is the M3 milestone (docs/PLAN.md): the sandbox works entirely locally in this
// tab for now. Syncing it P2P over WebRTC (and the WS-relay fallback) is M6 and isn't
// wired up here yet — see net/signaling.ts.
import { Application, Container, FederatedPointerEvent } from "pixi.js";
import { CARD_HEIGHT, CARD_WIDTH, CardDef, renderCard } from "./card";

interface CardInstance {
  def: CardDef;
  faceUp: boolean;
  hidden: boolean;
}

interface Pile {
  id: string;
  view: Container;
  cards: CardInstance[]; // last element is the top of the pile
}

const MERGE_RADIUS = CARD_WIDTH * 0.6;
let nextId = 1;

export class TableApp {
  private app = new Application();
  private world = new Container();
  private piles = new Map<string, Pile>();
  private dragging: { pile: Pile; pointerId: number } | null = null;
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

  get canvasParent(): HTMLElement {
    return this.app.canvas.parentElement!;
  }

  destroy(): void {
    this.closeMenu();
    this.app.destroy(true, { children: true });
  }

  /** Spawn a brand-new standalone pile (a GM-only action per the object model — see
   * docs/ARCHITECTURE.md "Roles: GM vs. players"; this demo doesn't gate it yet). */
  spawnCard(def: CardDef, worldX: number, worldY: number): void {
    const pile: Pile = { id: `pile-${nextId++}`, view: new Container(), cards: [{ def, faceUp: false, hidden: false }] };
    pile.view.position.set(worldX, worldY);
    this.setUpPileInteraction(pile);
    this.world.addChild(pile.view);
    this.piles.set(pile.id, pile);
    this.redraw(pile);
  }

  private setUpPileInteraction(pile: Pile): void {
    pile.view.eventMode = "static";
    pile.view.cursor = "grab";
    pile.view.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (e.button === 2) return; // handled by rightclick below
      this.beginDrag(pile, e);
    });
    pile.view.on("rightclick", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.openMenu(pile, e.globalX, e.globalY);
    });
    pile.view.on("dblclick", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.flip(pile);
    });
  }

  private redraw(pile: Pile): void {
    const top = pile.cards[pile.cards.length - 1];
    renderCard(pile.view, top.def, top.faceUp, top.hidden, pile.cards.length);
  }

  // --- Dragging: pick up just the top card as its own pile; dropping near another
  // pile merges into it (the Stack behavior), otherwise it becomes a new standalone
  // pile wherever it was dropped. ---

  private beginDrag(sourcePile: Pile, e: FederatedPointerEvent): void {
    if (this.dragging) return;
    const top = sourcePile.cards.pop()!;
    let dragPile: Pile;
    if (sourcePile.cards.length === 0) {
      this.piles.delete(sourcePile.id);
      dragPile = sourcePile;
      dragPile.cards = [top];
    } else {
      this.redraw(sourcePile);
      dragPile = { id: `pile-${nextId++}`, view: new Container(), cards: [top] };
      dragPile.view.position.copyFrom(sourcePile.view.position);
      this.setUpPileInteraction(dragPile);
      this.world.addChild(dragPile.view);
    }
    this.redraw(dragPile);
    dragPile.view.alpha = 0.85;
    dragPile.view.zIndex = 1000;
    this.dragging = { pile: dragPile, pointerId: e.pointerId };
  }

  private onBackgroundPointerDown(e: FederatedPointerEvent): void {
    if (e.target === this.app.stage) this.panning = true;
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (this.dragging) {
      const local = this.world.toLocal(e.global);
      this.dragging.pile.view.position.set(local.x, local.y);
    } else if (this.panning) {
      this.world.position.x += e.movementX;
      this.world.position.y += e.movementY;
    }
  }

  private onPointerUp(): void {
    this.panning = false;
    if (!this.dragging) return;
    const dragPile = this.dragging.pile;
    this.dragging = null;
    dragPile.view.alpha = 1;

    const target = this.findMergeTarget(dragPile);
    if (target) {
      target.cards.push(...dragPile.cards);
      this.world.removeChild(dragPile.view);
      this.redraw(target);
    } else {
      this.piles.set(dragPile.id, dragPile);
    }
  }

  private findMergeTarget(dragPile: Pile): Pile | null {
    let best: Pile | null = null;
    let bestDist = MERGE_RADIUS;
    for (const pile of this.piles.values()) {
      if (pile === dragPile) continue;
      const dx = pile.view.position.x - dragPile.view.position.x;
      const dy = pile.view.position.y - dragPile.view.position.y;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        best = pile;
        bestDist = dist;
      }
    }
    return best;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(3, Math.max(0.3, this.world.scale.x * factor));
    this.world.scale.set(newScale);
  }

  // --- Per-card/pile actions, available from the right-click menu. See
  // docs/NETWORKING.md "Trust model": any player can do any of these to any pile —
  // there's no ownership lock, matching a physical table. ---

  private flip(pile: Pile): void {
    const top = pile.cards[pile.cards.length - 1];
    top.faceUp = !top.faceUp;
    this.redraw(pile);
  }

  private toggleHide(pile: Pile): void {
    const top = pile.cards[pile.cards.length - 1];
    top.hidden = !top.hidden;
    this.redraw(pile);
  }

  private rotate90(pile: Pile): void {
    pile.view.rotation += Math.PI / 2;
  }

  private shuffle(pile: Pile): void {
    // Resolved locally for now; once P2P lands (M6) this becomes a host-resolved
    // operation so every peer agrees on the same resulting order — see
    // docs/GAME_DEFINITION.md "Stack operations".
    for (let i = pile.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
    }
    this.redraw(pile);
  }

  private draw(pile: Pile): void {
    if (pile.cards.length <= 1) return;
    const card = pile.cards.pop()!;
    this.redraw(pile);
    const drawn: Pile = { id: `pile-${nextId++}`, view: new Container(), cards: [card] };
    drawn.view.position.set(pile.view.position.x + CARD_WIDTH * 0.7, pile.view.position.y);
    this.setUpPileInteraction(drawn);
    this.world.addChild(drawn.view);
    this.piles.set(drawn.id, drawn);
    this.redraw(drawn);
  }

  // --- A minimal right-click menu, plain DOM overlay (not part of the PixiJS scene). ---

  private openMenu(pile: Pile, screenX: number, screenY: number): void {
    this.closeMenu();
    const top = pile.cards[pile.cards.length - 1];
    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;

    const items: [string, () => void][] = [
      ["Flip", () => this.flip(pile)],
      [top.hidden ? "Unhide" : "Hide", () => this.toggleHide(pile)],
      ["Rotate 90°", () => this.rotate90(pile)],
    ];
    if (pile.cards.length > 1) {
      items.push(["Shuffle", () => this.shuffle(pile)]);
      items.push(["Draw top card", () => this.draw(pile)]);
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
