// TableModel is the pure Card/Stack game logic (see pileModel.ts's header comment for
// why it's split out of table.ts) — this is the module the "unit testing needs to be
// extra tough" instruction is really about: it's the one place actual game rules live,
// and it's exhaustively testable precisely because it has no PixiJS/DOM/network
// dependency at all.
import { describe, expect, it } from "vitest";
import { CardDef } from "./card";
import { TableModel } from "./pileModel";

const DEF_A: CardDef = { id: "a", front: { title: "A", color: 0 }, back: { title: "", color: 0 } };
const DEF_B: CardDef = { id: "b", front: { title: "B", color: 0 }, back: { title: "", color: 0 } };
const DEF_C: CardDef = { id: "c", front: { title: "C", color: 0 }, back: { title: "", color: 0 } };

describe("spawnCard", () => {
  it("creates a standalone pile of exactly one card, face-down and not hidden", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 10, 20);

    expect(pile.cards).toEqual([{ def: DEF_A, faceUp: false, hiddenBy: null }]);
    expect(pile.x).toBe(10);
    expect(pile.y).toBe(20);
    expect(pile.rotation).toBe(0);
    expect(model.getPile(pile.id)).toBe(pile);
  });

  it("gives every spawned pile a distinct id", () => {
    const model = new TableModel();
    const ids = new Set(Array.from({ length: 50 }, () => model.spawnCard(DEF_A, 0, 0).id));
    expect(ids.size).toBe(50);
  });

  it("tracks every spawned pile in allPiles()", () => {
    const model = new TableModel();
    model.spawnCard(DEF_A, 0, 0);
    model.spawnCard(DEF_B, 1, 1);
    expect(model.allPiles()).toHaveLength(2);
  });
});

describe("pickUpTop", () => {
  it("returns undefined for a pile that doesn't exist", () => {
    const model = new TableModel();
    expect(model.pickUpTop("nope")).toBeUndefined();
  });

  it("picking up a single-card pile removes it from the model entirely and returns it, same id", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 5, 5);

    const floating = model.pickUpTop(pile.id)!;

    expect(floating.id).toBe(pile.id);
    expect(floating.cards).toEqual([{ def: DEF_A, faceUp: false, hiddenBy: null }]);
    expect(model.getPile(pile.id)).toBeUndefined();
  });

  it("picking up the top of a multi-card pile leaves the remainder in place under the same id", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null }); // B is now on top

    const floating = model.pickUpTop(pile.id)!;

    expect(floating.cards.map((c) => c.def.id)).toEqual(["b"]);
    expect(floating.id).not.toBe(pile.id); // a brand-new pile, not the source
    const remainder = model.getPile(pile.id)!;
    expect(remainder.cards.map((c) => c.def.id)).toEqual(["a"]);
  });

  it("the remainder pile keeps its original position when only the top card is taken", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 42, 99);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    model.pickUpTop(pile.id);

    const remainder = model.getPile(pile.id)!;
    expect(remainder.x).toBe(42);
    expect(remainder.y).toBe(99);
  });

  it("the floating pile from a multi-card source starts at the source's position", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 42, 99);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    const floating = model.pickUpTop(pile.id)!;

    expect(floating.x).toBe(42);
    expect(floating.y).toBe(99);
  });
});

describe("dropPile — the Stack-forming behavior", () => {
  it("places a dropped pile as a new standalone pile when nothing is nearby", () => {
    const model = new TableModel();
    const floating = model.pickUpTop(model.spawnCard(DEF_A, 0, 0).id)!;

    const result = model.dropPile(floating, 500, 500, 10);

    expect(result).toEqual({ kind: "placed", pile: floating });
    expect(model.getPile(floating.id)).toBe(floating);
    expect(floating.x).toBe(500);
    expect(floating.y).toBe(500);
  });

  it("merges into an existing pile within the radius, appending on top and leaving the target's position unchanged", () => {
    const model = new TableModel();
    const target = model.spawnCard(DEF_A, 100, 100);
    const floating = model.pickUpTop(model.spawnCard(DEF_B, 0, 0).id)!;

    const result = model.dropPile(floating, 105, 103, 20); // within radius of target

    expect(result).toEqual({ kind: "merged", targetId: target.id });
    expect(target.cards.map((c) => c.def.id)).toEqual(["a", "b"]);
    expect(target.x).toBe(100); // target does not jump to the drop point
    expect(target.y).toBe(100);
    expect(model.getPile(floating.id)).toBeUndefined(); // the floating pile is consumed
  });

  it("does not merge when the nearest pile is outside the radius", () => {
    const model = new TableModel();
    const target = model.spawnCard(DEF_A, 0, 0);
    const floating = model.pickUpTop(model.spawnCard(DEF_B, 500, 500).id)!;

    const result = model.dropPile(floating, 100, 0, 20); // 100 units away, radius 20

    expect(result.kind).toBe("placed");
    expect(target.cards).toHaveLength(1); // untouched
  });

  it("merges with an exact card count regardless of how many cards the floating pile carries", () => {
    const model = new TableModel();
    const target = model.spawnCard(DEF_A, 0, 0);
    const floating = model.pickUpTop(model.spawnCard(DEF_B, 900, 900).id)!;
    floating.cards.push({ def: DEF_C, faceUp: false, hiddenBy: null }); // pretend it carried 2

    model.dropPile(floating, 0, 0, 20);

    expect(target.cards.map((c) => c.def.id)).toEqual(["a", "b", "c"]);
  });

  it("picks the nearest of several candidates within radius, not just any", () => {
    const model = new TableModel();
    const far = model.spawnCard(DEF_A, 0, 15);
    const near = model.spawnCard(DEF_B, 0, 5);
    const floating = model.pickUpTop(model.spawnCard(DEF_C, 900, 900).id)!;

    const result = model.dropPile(floating, 0, 0, 20);

    expect(result).toEqual({ kind: "merged", targetId: near.id });
    expect(far.cards).toHaveLength(1);
  });

  it("a full pick-up-and-drop-on-itself round trip is a no-op merge target (never merges with itself)", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    const floating = model.pickUpTop(pile.id)!; // same id, since it was a 1-card pile

    const result = model.dropPile(floating, 0, 0, 50);

    // there's nothing else on the table, so it must be placed, not merged with itself
    expect(result).toEqual({ kind: "placed", pile: floating });
  });
});

describe("flip / toggleHide / rotate90 — act on the top card or whole pile only", () => {
  it("flip toggles the top card's faceUp and leaves cards below it alone", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    model.flip(pile.id);

    expect(pile.cards[1].faceUp).toBe(true); // B, the top card
    expect(pile.cards[0].faceUp).toBe(false); // A, untouched
    model.flip(pile.id);
    expect(pile.cards[1].faceUp).toBe(false); // flips back
  });

  it("flip on a nonexistent pile does not throw", () => {
    const model = new TableModel();
    expect(() => model.flip("ghost")).not.toThrow();
  });

  it("toggleHide sets hiddenBy to the calling peer", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "peer-1");
    expect(model.topCard(pile.id)!.hiddenBy).toBe("peer-1");
  });

  it("toggleHide un-hides a card already hidden by anyone, not just the caller", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "peer-1");
    model.toggleHide(pile.id, "peer-2"); // a different peer un-hides it — no ownership lock
    expect(model.topCard(pile.id)!.hiddenBy).toBeNull();
  });

  it("toggleHide on a nonexistent pile does not throw", () => {
    const model = new TableModel();
    expect(() => model.toggleHide("ghost", "peer-1")).not.toThrow();
  });

  it("rotate90 accumulates by 90 degrees (in radians) and wraps at a full turn", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    const step = Math.PI / 2;

    model.rotate90(pile.id);
    expect(pile.rotation).toBeCloseTo(step);
    model.rotate90(pile.id);
    model.rotate90(pile.id);
    model.rotate90(pile.id);
    expect(pile.rotation).toBeCloseTo(0, 10); // 4 * 90° = full turn, wrapped
  });

  it("rotateBy accepts an arbitrary continuous angle, for dragging a rotation handle", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.rotateBy(pile.id, 0.3);
    expect(pile.rotation).toBeCloseTo(0.3);
    model.rotateBy(pile.id, 0.1);
    expect(pile.rotation).toBeCloseTo(0.4);
  });

  it("rotateBy accepts negative deltas and still normalizes into [0, 2π)", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.rotateBy(pile.id, -0.5);
    expect(pile.rotation).toBeGreaterThanOrEqual(0);
    expect(pile.rotation).toBeCloseTo(2 * Math.PI - 0.5);
  });

  it("rotateBy on a nonexistent pile does not throw", () => {
    const model = new TableModel();
    expect(() => model.rotateBy("ghost", 1)).not.toThrow();
  });

  it("setRotation sets an absolute angle regardless of the current one", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.rotateBy(pile.id, 5);
    model.setRotation(pile.id, 1.234);
    expect(pile.rotation).toBeCloseTo(1.234);
  });

  it("setRotation normalizes a value outside [0, 2π)", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.setRotation(pile.id, -Math.PI / 2);
    expect(pile.rotation).toBeCloseTo((3 * Math.PI) / 2);
  });
});

describe("shuffle", () => {
  it("preserves the multiset of cards (same cards, some order)", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });
    pile.cards.push({ def: DEF_C, faceUp: false, hiddenBy: null });

    model.shuffle(pile.id, () => 0); // degenerate RNG, still must not lose/duplicate cards

    expect(pile.cards.map((c) => c.def.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("is deterministic for a given RNG sequence", () => {
    const build = () => {
      const model = new TableModel();
      const pile = model.spawnCard(DEF_A, 0, 0);
      pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });
      pile.cards.push({ def: DEF_C, faceUp: false, hiddenBy: null });
      return { model, pile };
    };
    const sequence = [0.9, 0.1, 0.5];
    let i = 0;
    const rng = () => sequence[i++ % sequence.length];

    const first = build();
    first.model.shuffle(first.pile.id, rng);
    i = 0;
    const second = build();
    second.model.shuffle(second.pile.id, rng);

    expect(first.pile.cards.map((c) => c.def.id)).toEqual(second.pile.cards.map((c) => c.def.id));
  });

  it("a 1-card pile is unaffected", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    expect(() => model.shuffle(pile.id)).not.toThrow();
    expect(pile.cards).toHaveLength(1);
  });

  it("shuffling a nonexistent pile does not throw", () => {
    const model = new TableModel();
    expect(() => model.shuffle("ghost")).not.toThrow();
  });
});

describe("drawTop", () => {
  it("moves the top card into a brand-new pile offset from the source", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 100, 100);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    const drawn = model.drawTop(pile.id, 50, 0)!;

    expect(drawn.cards.map((c) => c.def.id)).toEqual(["b"]);
    expect(drawn.x).toBe(150);
    expect(drawn.y).toBe(100);
    expect(pile.cards.map((c) => c.def.id)).toEqual(["a"]);
    expect(model.getPile(drawn.id)).toBe(drawn);
  });

  it("refuses to draw from a pile of exactly one card (use pickUpTop for that)", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    expect(model.drawTop(pile.id, 10, 0)).toBeUndefined();
    expect(pile.cards).toHaveLength(1); // untouched
  });

  it("returns undefined for a nonexistent pile", () => {
    const model = new TableModel();
    expect(model.drawTop("ghost", 10, 0)).toBeUndefined();
  });

  it("repeated draws eventually reduce a pile to one card and then refuse further draws", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });
    pile.cards.push({ def: DEF_C, faceUp: false, hiddenBy: null });

    expect(model.drawTop(pile.id, 1, 0)).toBeDefined();
    expect(pile.cards).toHaveLength(2);
    expect(model.drawTop(pile.id, 1, 0)).toBeDefined();
    expect(pile.cards).toHaveLength(1);
    expect(model.drawTop(pile.id, 1, 0)).toBeUndefined();
    expect(pile.cards).toHaveLength(1);
  });
});

describe("removePile", () => {
  it("removes a pile so it no longer appears in allPiles()", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.removePile(pile.id);
    expect(model.getPile(pile.id)).toBeUndefined();
    expect(model.allPiles()).toHaveLength(0);
  });

  it("removing a nonexistent pile does not throw", () => {
    const model = new TableModel();
    expect(() => model.removePile("ghost")).not.toThrow();
  });
});

describe("a realistic end-to-end scenario: deal, peek at own hand via hide, discard, redraw", () => {
  it("behaves consistently through a full sequence of operations", () => {
    const model = new TableModel();
    const deck = model.spawnCard(DEF_A, 0, 0);
    deck.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });
    deck.cards.push({ def: DEF_C, faceUp: false, hiddenBy: null });

    // Deal one card to "my hand" by drawing it off the deck.
    const hand = model.drawTop(deck.id, 200, 0)!;
    expect(deck.cards).toHaveLength(2);

    // I look at my own card (Hide keeps the front visible only to me — see
    // docs/ARCHITECTURE.md "Hiding a card"; this model just tracks who hid it).
    model.toggleHide(hand.id, "me");
    expect(model.topCard(hand.id)!.hiddenBy).toBe("me");

    // I discard it back onto the deck (pick it up, drop it near the deck to merge).
    const floating = model.pickUpTop(hand.id)!;
    const result = model.dropPile(floating, deck.x + 1, deck.y, 50);
    expect(result).toEqual({ kind: "merged", targetId: deck.id });
    expect(deck.cards).toHaveLength(3);
    // the re-merged card keeps whatever hidden/faceUp state it had — merging doesn't
    // reset a card, only stacking position does
    expect(deck.cards[2].hiddenBy).toBe("me");
  });
});
