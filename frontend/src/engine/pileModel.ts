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
  /** The peerId of whoever hid this card, or null if it isn't hidden. Tracking *who*
   * (not just a boolean) is what makes Hide correct once state is actually synced
   * across peers (M6): the host needs to know who to send the true front content to —
   * see docs/ARCHITECTURE.md "Hiding a card" and net/syncProtocol.ts's redaction. */
  hiddenBy: string | null;
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
    const pile: PileState = { id: this.newId(), x, y, rotation: 0, cards: [{ def, faceUp: false, hiddenBy: null }] };
    this.piles.set(pile.id, pile);
    return pile;
  }

  /** Spawn several cards as one already-stacked pile — e.g. a game package's card set
   * ("a stack of all the role cards" per GAME_DEFINITION.md-adjacent discussion)
   * starting life as a single shufflable stack instead of N separate individual piles.
   * `defs` order becomes bottom-to-top. A no-op-returning-undefined for an empty list —
   * there's no such thing as a pile of zero cards (see PileState's own invariant). */
  spawnStack(defs: CardDef[], x: number, y: number): PileState | undefined {
    if (defs.length === 0) return undefined;
    const pile: PileState = { id: this.newId(), x, y, rotation: 0, cards: defs.map((def) => ({ def, faceUp: false, hiddenBy: null })) };
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

  /** Insert or overwrite a pile *by the id it already carries*, without allocating a
   * new one — this is how a peer mirrors a pile the host broadcast (see
   * net/syncProtocol.ts): only the host's TableModel ever calls the id-allocating
   * methods above (spawnCard, pickUpTop, drawTop); every other peer's local mirror only
   * ever receives complete PileState objects through this method, so ids never collide
   * across peers. */
  setPile(pile: PileState): void {
    this.piles.set(pile.id, pile);
  }

  /** Replace this model's entire contents — used to apply a full snapshot, e.g. when a
   * newly-promoted host resumes from the last one uploaded (see
   * docs/NETWORKING.md "Host migration") or a joining peer receives the current table
   * state. */
  loadSnapshot(piles: PileState[]): void {
    this.piles.clear();
    for (const pile of piles) this.piles.set(pile.id, pile);
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

  /** Toggle hiding the top card. Consistent with the no-ownership-lock trust model
   * (see docs/NETWORKING.md "Trust model"), anyone can call this on anyone's hidden
   * card — hiding it if it's currently visible (as themselves), or un-hiding it if it's
   * currently hidden by anyone at all, not just by the caller. */
  toggleHide(pileId: string, peerId: string): void {
    const top = this.topCard(pileId);
    if (top) top.hiddenBy = top.hiddenBy === null ? peerId : null;
  }

  /** Rotate by an arbitrary angle (radians, either sign) — the general case, e.g. for
   * dragging a rotation handle continuously so players seated around the table (see
   * seating.ts) can orient their own cards to face themselves. Always normalized into
   * [0, 2π) so rotation never grows unboundedly across many small drag updates. */
  rotateBy(pileId: string, deltaRadians: number): void {
    const pile = this.piles.get(pileId);
    if (!pile) return;
    const twoPi = 2 * Math.PI;
    pile.rotation = ((pile.rotation + deltaRadians) % twoPi + twoPi) % twoPi;
  }

  setRotation(pileId: string, radians: number): void {
    const pile = this.piles.get(pileId);
    if (!pile) return;
    const twoPi = 2 * Math.PI;
    pile.rotation = ((radians % twoPi) + twoPi) % twoPi;
  }

  /** A 90° step is just the common case of rotateBy — kept as its own method since
   * it's still the right-click menu's default action. */
  rotate90(pileId: string): void {
    this.rotateBy(pileId, Math.PI / 2);
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
