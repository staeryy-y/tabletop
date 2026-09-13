import { describe, expect, it } from "vitest";
import { RollContext, RollError, RollEvalError, RollParseError, evaluateRoll, formatRollResult, parseRoll, roll } from "./roll";

function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

// Numeric die keys ("20" from "1d20", "6" from "8d6") never need registering — see
// roll.ts's resolveFaces() — so the only entry the test context needs is the one
// non-numeric custom die.
const PIP = [0, 0, 0, 1, 1, 2]; // the custom die from docs/GAME_DEFINITION.md's Betrayal example

function ctx(overrides: Partial<RollContext> = {}): RollContext {
  return {
    dice: { pip: PIP },
    tracks: {
      dex: { resolveAs: "floor((value-10)/2)", currentValue: 16 }, // modifier +3
      str: { resolveAs: "floor((value-10)/2)", currentValue: 8 }, // modifier -1
      level: { currentValue: 5 },
      proficiency: { resolveAs: "ceil(level.raw / 4) + 1", currentValue: NaN },
      might: { poolDie: "pip", currentValue: 3 },
    },
    ...overrides,
  };
}

describe("parseRoll — literal dice pools", () => {
  it("parses a plain d20", () => {
    expect(parseRoll("1d20")).toEqual({ terms: [{ sign: 1, term: { kind: "pool", count: 1, dieKey: "20", aggregator: { kind: "sum" } } }] });
  });

  it("parses a multi-die pool", () => {
    const expr = parseRoll("8d6");
    expect(expr.terms[0].term).toEqual({ kind: "pool", count: 8, dieKey: "6", aggregator: { kind: "sum" } });
  });

  it("parses a custom die key", () => {
    const expr = parseRoll("3dpip");
    expect(expr.terms[0].term).toMatchObject({ kind: "pool", count: 3, dieKey: "pip" });
  });

  it("parses the highest aggregator (advantage)", () => {
    const expr = parseRoll("2d20:highest1");
    expect(expr.terms[0].term).toEqual({ kind: "pool", count: 2, dieKey: "20", aggregator: { kind: "highest", n: 1 } });
  });

  it("parses the lowest aggregator (drop-lowest ability score roll)", () => {
    const expr = parseRoll("4d6:lowest1");
    expect(expr.terms[0].term).toEqual({ kind: "pool", count: 4, dieKey: "6", aggregator: { kind: "lowest", n: 1 } });
  });

  it("parses the count aggregator with each comparator", () => {
    expect(parseRoll("1d6:count>=4").terms[0].term).toMatchObject({ aggregator: { kind: "count", comparator: ">=", value: 4 } });
    expect(parseRoll("1d6:count>4").terms[0].term).toMatchObject({ aggregator: { kind: "count", comparator: ">", value: 4 } });
    expect(parseRoll("1d6:count==6").terms[0].term).toMatchObject({ aggregator: { kind: "count", comparator: "==", value: 6 } });
  });

  it("an explicit :sum is equivalent to omitting the aggregator", () => {
    expect(parseRoll("1d20:sum")).toEqual(parseRoll("1d20"));
  });

  it("rejects an unrecognized aggregator", () => {
    expect(() => parseRoll("1d20:bogus")).toThrow(RollParseError);
  });
});

describe("parseRoll — stat references", () => {
  it("parses a bare identifier as a stat, not dice, even without any digits", () => {
    expect(parseRoll("dex")).toEqual({ terms: [{ sign: 1, term: { kind: "stat", name: "dex", raw: false } }] });
  });

  it("a stat name starting with the letter 'd' is still a stat, not dice — the whole point of requiring a leading digit for dice", () => {
    expect(parseRoll("dex").terms[0].term).toEqual({ kind: "stat", name: "dex", raw: false });
  });

  it("parses the .raw accessor", () => {
    expect(parseRoll("dex.raw").terms[0].term).toEqual({ kind: "stat", name: "dex", raw: true });
  });

  it("a bare pool_die stat name (e.g. Betrayal's might) parses as an ordinary stat term", () => {
    expect(parseRoll("might").terms[0].term).toEqual({ kind: "stat", name: "might", raw: false });
  });
});

describe("parseRoll — combining terms with +/-", () => {
  it("adds a stat modifier to a dice pool", () => {
    const expr = parseRoll("1d20 + dex");
    expect(expr.terms).toHaveLength(2);
    expect(expr.terms[0]).toMatchObject({ sign: 1, term: { kind: "pool" } });
    expect(expr.terms[1]).toMatchObject({ sign: 1, term: { kind: "stat", name: "dex" } });
  });

  it("handles subtraction", () => {
    const expr = parseRoll("1d20 - 2");
    expect(expr.terms[1]).toEqual({ sign: -1, term: { kind: "number", value: 2 } });
  });

  it("handles more than two terms", () => {
    const expr = parseRoll("1d20 + str + proficiency");
    expect(expr.terms.map((t) => t.term.kind)).toEqual(["pool", "stat", "stat"]);
  });

  it("ignores whitespace anywhere", () => {
    expect(parseRoll("1d20+dex")).toEqual(parseRoll(" 1d20  +   dex "));
  });
});

describe("parseRoll — malformed input", () => {
  it("rejects an empty string", () => {
    expect(() => parseRoll("")).toThrow(RollParseError);
  });

  it("rejects a leading operator", () => {
    expect(() => parseRoll("+1d20")).toThrow(RollParseError);
  });

  it("rejects a trailing operator", () => {
    expect(() => parseRoll("1d20+")).toThrow(RollParseError);
  });

  it("rejects a term that isn't dice, a number, or an identifier", () => {
    expect(() => parseRoll("1d20 + @@@")).toThrow(RollParseError);
  });
});

describe("evaluateRoll — literal pools", () => {
  it("sums a single die roll", () => {
    const result = evaluateRoll(parseRoll("1d20"), ctx({ rng: sequenceRng([0.5]) })); // index 10 -> face 11
    expect(result.total).toBe(11);
  });

  it("sums a multi-die pool", () => {
    // rng sequence -> face values 1,1,1,1,1,1,1,1 for 8d6 (rng=0 => index 0 => face 1)
    const result = evaluateRoll(parseRoll("8d6"), ctx({ rng: sequenceRng([0]) }));
    expect(result.total).toBe(8);
  });

  it("highest-N keeps only the top N dice", () => {
    // two d20 rolls: 5 and 20 (rng values chosen to land on those faces)
    const rng = sequenceRng([4 / 20, 19 / 20]);
    const result = evaluateRoll(parseRoll("2d20:highest1"), ctx({ rng }));
    expect(result.total).toBe(20);
  });

  it("lowest-N keeps only the bottom N dice", () => {
    const rng = sequenceRng([3 / 6, 0 / 6, 5 / 6, 1 / 6]); // faces: 4,1,6,2
    const result = evaluateRoll(parseRoll("4d6:lowest1"), ctx({ rng }));
    expect(result.total).toBe(1);
  });

  it("count aggregator counts successes, not a sum", () => {
    // 4 d6 rolls: faces 4,6,2,5 -> count>=4 should count 4,6,5 = 3 successes
    const rng = sequenceRng([3 / 6, 5 / 6, 1 / 6, 4 / 6]);
    const result = evaluateRoll(parseRoll("4d6:count>=4"), ctx({ rng }));
    expect(result.total).toBe(3);
  });

  it("a numeric die-key never needs registering — it's always an implicit standard die", () => {
    // faces 1..100 synthesized on the fly; must not throw even though "100" was never
    // added to ctx.dice
    expect(() => evaluateRoll(parseRoll("1d100"), ctx())).not.toThrow();
  });

  it("rolling an unregistered non-numeric die is a RollEvalError", () => {
    expect(() => evaluateRoll(parseRoll("1dbogus"), ctx())).toThrow(RollEvalError);
  });

  it("the custom Betrayal pip die can be rolled directly by key", () => {
    // rng=0 -> lowest face index -> 0 pips, three dice -> total 0
    const result = evaluateRoll(parseRoll("3dpip"), ctx({ rng: sequenceRng([0]) }));
    expect(result.total).toBe(0);
  });
});

describe("evaluateRoll — stat references", () => {
  it("resolves a score_modifier-style track (D&D dex) to its modifier, not the raw score", () => {
    const result = evaluateRoll(parseRoll("dex"), ctx());
    expect(result.total).toBe(3); // (16-10)/2 = 3
  });

  it(".raw bypasses resolve_as and returns the underlying score", () => {
    const result = evaluateRoll(parseRoll("dex.raw"), ctx());
    expect(result.total).toBe(16);
  });

  it("a plain number track with no resolve_as/pool_die resolves to its current value", () => {
    const result = evaluateRoll(parseRoll("level"), ctx());
    expect(result.total).toBe(5);
  });

  it("a derived track's formula can reference another track's .raw value", () => {
    const result = evaluateRoll(parseRoll("proficiency"), ctx());
    expect(result.total).toBe(3); // ceil(5/4)+1 = 2+1 = 3
  });

  it("a bare pool_die stat (Betrayal's Might) expands into a dice pool sized by its current value", () => {
    // might.currentValue = 3, pool_die = pip; rng picks index 3 each time -> face value 1 each -> total 3
    const result = evaluateRoll(parseRoll("might"), ctx({ rng: sequenceRng([3 / 6]) }));
    expect(result.total).toBe(3);
    const stat = result.breakdown[0].term;
    expect(stat.kind).toBe("stat");
    if (stat.kind === "stat") {
      expect(stat.pool?.rolls).toHaveLength(3);
    }
  });

  it("a pool_die stat's .raw accessor returns the plain current value instead of rolling", () => {
    const result = evaluateRoll(parseRoll("might.raw"), ctx());
    expect(result.total).toBe(3);
    expect(result.breakdown[0].term).toEqual({ kind: "stat", name: "might", value: 3 });
  });

  it("referencing an unknown stat is a RollEvalError", () => {
    expect(() => evaluateRoll(parseRoll("charisma"), ctx())).toThrow(RollEvalError);
  });
});

describe("evaluateRoll — combining terms", () => {
  it("a D&D-style attack roll: 1d20 + str + proficiency", () => {
    const result = evaluateRoll(parseRoll("1d20 + str + proficiency"), ctx({ rng: sequenceRng([0.5] /* face 11 */) }));
    // 11 + (-1) + 3 = 13
    expect(result.total).toBe(13);
  });

  it("subtraction reduces the total", () => {
    const result = evaluateRoll(parseRoll("1d20 - 2"), ctx({ rng: sequenceRng([0.5]) }));
    expect(result.total).toBe(9);
  });

  it("the breakdown lists one entry per term with its own sign", () => {
    const result = evaluateRoll(parseRoll("1d20 + dex - 1"), ctx({ rng: sequenceRng([0.5]) }));
    expect(result.breakdown).toHaveLength(3);
    expect(result.breakdown.map((b) => b.sign)).toEqual([1, 1, -1]);
  });
});

describe("roll() — parse and evaluate together", () => {
  it("matches calling parseRoll then evaluateRoll separately", () => {
    const rng = sequenceRng([0.5]);
    const viaHelper = roll("1d20 + dex", ctx({ rng: sequenceRng([0.5]) }));
    const viaSeparate = evaluateRoll(parseRoll("1d20 + dex"), ctx({ rng }));
    expect(viaHelper.total).toBe(viaSeparate.total);
  });

  it("propagates a parse error", () => {
    expect(() => roll("1d20 +", ctx())).toThrow(RollParseError);
  });
});

describe("RollError hierarchy", () => {
  it("both RollParseError and RollEvalError are catchable as the common RollError", () => {
    expect(new RollParseError("x")).toBeInstanceOf(RollError);
    expect(new RollEvalError("x")).toBeInstanceOf(RollError);
  });
});

describe("formatRollResult", () => {
  it("shows the individual dice for a single pool", () => {
    const result = evaluateRoll(parseRoll("1d20"), ctx({ rng: sequenceRng([0.5]) }));
    expect(formatRollResult(result)).toBe("[11] = 11");
  });

  it("shows a plain number term as-is", () => {
    const result = evaluateRoll(parseRoll("5"), ctx());
    expect(formatRollResult(result)).toBe("5 = 5");
  });

  it("shows a resolved stat with its computed value in parens", () => {
    const result = evaluateRoll(parseRoll("dex"), ctx());
    expect(formatRollResult(result)).toBe("dex(3) = 3");
  });

  it("shows a pool_die stat's individual dice, not just its total", () => {
    const result = evaluateRoll(parseRoll("might"), ctx({ rng: sequenceRng([3 / 6]) }));
    expect(formatRollResult(result)).toBe("might[1,1,1] = 3");
  });

  it("combines multiple terms with their signs", () => {
    const result = evaluateRoll(parseRoll("1d20 + dex - 1"), ctx({ rng: sequenceRng([0.5]) }));
    expect(formatRollResult(result)).toBe("[11] + dex(3) - 1 = 13");
  });

  it("a negative-total roll still formats the leading sign correctly (no leading '+ ')", () => {
    const result = evaluateRoll(parseRoll("str"), ctx()); // -1
    expect(formatRollResult(result)).toBe("str(-1) = -1");
  });
});
