// The pure Card/Stack object model — no PixiJS, no DOM, no canvas. This is deliberately
// separated from table.ts (which is just a thin PixiJS rendering/pointer-event adapter
// over this) so the actual game logic can be unit-tested directly: per the project's
// own docs, integration-testing a P2P, canvas-rendered, many-browsers game is hard, so
// the logic that decides *what happens* needs to be exhaustively testable on its own,
// independent of rendering. See docs/GAME_DEFINITION.md "Cards are the workhorse" for
// the rules this encodes: a Pile of one card *is* a Card; a Pile of more is a Stack;
// there is no separate authored "deck" type.
import { CardDef } from "./card";

export interface CardInstance {
  def: CardDef;
  faceUp: boolean;
  hidden: boolean;
}

export interface PileState {
  readonly id: string;
  x: number;
  y: number;
  rotation: number;
  cards: CardInstance[]; // last element is the top of the pile
}

export type DropResult = { kind: "merged"; targetId: string } | { kind: "placed"; pile: PileState };

export class TableModel {
  private piles = new Map<string, PileState>();
  private nextId = 1;

  private newId(): string {
    return `pile-${this.nextId++}`;
  }

  spawnCard(def: CardDef, x: number, y: number): PileState {
    const pile: PileState = { id: this.newId(), x, y, rotation: 0, cards: [{ def, faceUp: false, hidden: false }] };
    this.piles.set(pile.id, pile);
    return pile;
  }

  getPile(id: string): PileState | undefined {
    return this.piles.get(id);
  }

  allPiles(): PileState[] {
    return [...this.piles.values()];
  }

  removePile(id: string): void {
    this.piles.delete(id);
  }

  topCard(id: string): CardInstance | undefined {
    const pile = this.piles.get(id);
    return pile && pile.cards[pile.cards.length - 1];
  }

  /** Pick up the top card of a pile, turning it into its own free-floating pile (not
   * tracked in this model until dropPile() places or merges it) — this is what
   * "dragging a card off a stack" means. If the source pile had more than one card, the
   * remainder stays right where it was, under its existing id; if it only had the one
   * card, the whole pile (its id included) becomes the floating pile. Returns undefined
   * if the pile doesn't exist or is somehow already empty. */
  pickUpTop(pileId: string): PileState | undefined {
    const source = this.piles.get(pileId);
    if (!source || source.cards.length === 0) return undefined;

    const top = source.cards.pop()!;
    if (source.cards.length === 0) {
      this.piles.delete(source.id);
      source.cards = [top];
      return source;
    }
    return { id: this.newId(), x: source.x, y: source.y, rotation: 0, cards: [top] };
  }

  /** The nearest pile (other than `excludeId`) within `radius` of (x, y), or null. */
  findMergeTarget(x: number, y: number, radius: number, excludeId?: string): PileState | null {
    let best: PileState | null = null;
    let bestDist = radius;
    for (const pile of this.piles.values()) {
      if (pile.id === excludeId) continue;
      const dist = Math.hypot(pile.x - x, pile.y - y);
      if (dist < bestDist) {
        best = pile;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Drop a pile previously returned by pickUpTop() at (x, y): merges into whatever
   * existing pile is within `radius` (its cards appended on top, target position
   * unchanged — this is the Stack-forming behavior), or places it as a new standalone
   * pile at (x, y) if nothing is close enough. */
  dropPile(floating: PileState, x: number, y: number, radius: number): DropResult {
    const target = this.findMergeTarget(x, y, radius, floating.id);
    if (target) {
      target.cards.push(...floating.cards);
      return { kind: "merged", targetId: target.id };
    }
    floating.x = x;
    floating.y = y;
    this.piles.set(floating.id, floating);
    return { kind: "placed", pile: floating };
  }

  flip(pileId: string): void {
    const top = this.topCard(pileId);
    if (top) top.faceUp = !top.faceUp;
  }

  toggleHide(pileId: string): void {
    const top = this.topCard(pileId);
    if (top) top.hidden = !top.hidden;
  }

  rotate90(pileId: string): void {
    const pile = this.piles.get(pileId);
    if (pile) pile.rotation = (pile.rotation + Math.PI / 2) % (2 * Math.PI);
  }

  /** Fisher-Yates, with an injectable RNG (defaulting to Math.random) purely so tests
   * can make this deterministic. Note this decides an order locally; once P2P sync
   * lands (M6) a shuffle needs to be resolved once by the host so every peer agrees —
   * see docs/GAME_DEFINITION.md "Stack operations". */
  shuffle(pileId: string, rng: () => number = Math.random): void {
    const pile = this.piles.get(pileId);
    if (!pile) return;
    for (let i = pile.cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pile.cards[i], pile.cards[j]] = [pile.cards[j], pile.cards[i]];
    }
  }

  /** Pop the top card off a multi-card pile into a brand-new standalone pile placed at
   * an offset from the source. No-ops (returns undefined) on a pile of 0 or 1 cards —
   * "drawing" a lone card is meaningless; use pickUpTop to just move it. */
  drawTop(pileId: string, offsetX: number, offsetY: number): PileState | undefined {
    const pile = this.piles.get(pileId);
    if (!pile || pile.cards.length <= 1) return undefined;
    const card = pile.cards.pop()!;
    const drawn: PileState = { id: this.newId(), x: pile.x + offsetX, y: pile.y + offsetY, rotation: 0, cards: [card] };
    this.piles.set(drawn.id, drawn);
    return drawn;
  }
}
