import { describe, expect, it } from "vitest";
import { CardSet, DiceDef, GamePackage, PieceSet, TrackDef, createEmptyPackage, isValidPackage, validatePackage } from "./gamePackage";

function pkg(overrides: Partial<GamePackage> = {}): GamePackage {
  return { ...createEmptyPackage("Test Package"), ...overrides };
}

describe("createEmptyPackage", () => {
  it("has the given name and no content", () => {
    const p = createEmptyPackage("My Game");
    expect(p.name).toBe("My Game");
    expect(p.tracks).toEqual([]);
    expect(p.dice).toEqual([]);
    expect(p.cardSets).toEqual([]);
    expect(p.pieceSets).toEqual([]);
    expect(p.macros).toEqual([]);
  });

  it("is valid on its own — an empty package is a legitimate freeform-sandbox package", () => {
    expect(isValidPackage(createEmptyPackage("Empty"))).toBe(true);
  });
});

describe("validatePackage — name", () => {
  it("requires a non-empty name", () => {
    expect(validatePackage(pkg({ name: "" }))).toContain("Package needs a name.");
  });

  it("rejects a whitespace-only name", () => {
    expect(validatePackage(pkg({ name: "   " }))).toContain("Package needs a name.");
  });
});

describe("validatePackage — tracks", () => {
  const track = (overrides: Partial<TrackDef> = {}): TrackDef => ({
    key: "str",
    label: "Strength",
    values: [8, 9, 10],
    ...overrides,
  });

  it("accepts a well-formed track", () => {
    expect(validatePackage(pkg({ tracks: [track()] }))).toEqual([]);
  });

  it("rejects a key with uppercase letters", () => {
    const errors = validatePackage(pkg({ tracks: [track({ key: "STR" })] }));
    expect(errors.some((e) => e.includes('"STR"'))).toBe(true);
  });

  it("rejects a key starting with a digit", () => {
    const errors = validatePackage(pkg({ tracks: [track({ key: "1str" })] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts keys with digits, underscores, and hyphens after the first letter", () => {
    expect(validatePackage(pkg({ tracks: [track({ key: "hp-2" })] }))).toEqual([]);
    expect(validatePackage(pkg({ tracks: [track({ key: "ability_1" })] }))).toEqual([]);
  });

  it("flags duplicate track keys", () => {
    const errors = validatePackage(pkg({ tracks: [track(), track()] }));
    expect(errors).toContain('Duplicate track key "str".');
  });

  it("requires at least one value", () => {
    const errors = validatePackage(pkg({ tracks: [track({ values: [] })] }));
    expect(errors.some((e) => e.includes("needs at least one value"))).toBe(true);
  });

  it("rejects a poolDie that doesn't reference a die in the same package", () => {
    const errors = validatePackage(pkg({ tracks: [track({ poolDie: "pip" })], dice: [] }));
    expect(errors.some((e) => e.includes('pool_die "pip"'))).toBe(true);
  });

  it("accepts a poolDie that does reference a real die", () => {
    const errors = validatePackage(
      pkg({ tracks: [track({ poolDie: "pip" })], dice: [{ key: "pip", faces: [0, 0, 1, 1, 2, 2] }] }),
    );
    expect(errors).toEqual([]);
  });
});

describe("validatePackage — dice", () => {
  it("accepts a die with sides", () => {
    expect(validatePackage(pkg({ dice: [{ key: "d20", sides: 20 }] }))).toEqual([]);
  });

  it("accepts a die with custom faces", () => {
    expect(validatePackage(pkg({ dice: [{ key: "pip", faces: [0, 0, 1, 1, 2] }] }))).toEqual([]);
  });

  it("rejects a die with neither sides nor faces", () => {
    const errors = validatePackage(pkg({ dice: [{ key: "broken" } as DiceDef] }));
    expect(errors.some((e) => e.includes("exactly one of sides or faces"))).toBe(true);
  });

  it("rejects a die with both sides and faces", () => {
    const errors = validatePackage(pkg({ dice: [{ key: "broken", sides: 6, faces: [1, 2, 3] }] }));
    expect(errors.some((e) => e.includes("exactly one of sides or faces"))).toBe(true);
  });

  it("rejects a die with an empty faces array (falls through to the neither case)", () => {
    const errors = validatePackage(pkg({ dice: [{ key: "broken", faces: [] }] }));
    expect(errors.some((e) => e.includes("exactly one of sides or faces"))).toBe(true);
  });

  it("rejects fewer than 2 sides", () => {
    const errors = validatePackage(pkg({ dice: [{ key: "d1", sides: 1 }] }));
    expect(errors.some((e) => e.includes("at least 2 sides"))).toBe(true);
  });

  it("flags duplicate die keys", () => {
    const errors = validatePackage(pkg({ dice: [{ key: "d6", sides: 6 }, { key: "d6", sides: 8 }] }));
    expect(errors).toContain('Duplicate die key "d6".');
  });
});

describe("validatePackage — card sets", () => {
  const set = (overrides: Partial<CardSet> = {}): CardSet => ({
    key: "event",
    entries: [{ id: "e1", front: { title: "Event One" } }],
    ...overrides,
  });

  it("accepts a well-formed card set with a text-only card", () => {
    expect(validatePackage(pkg({ cardSets: [set()] }))).toEqual([]);
  });

  it("accepts a card with only an image and no title", () => {
    const errors = validatePackage(
      pkg({ cardSets: [set({ entries: [{ id: "e1", front: { title: "", image: "data:image/png;base64,x" } }] })] }),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a card with neither a title nor an image", () => {
    const errors = validatePackage(pkg({ cardSets: [set({ entries: [{ id: "e1", front: { title: "" } }] })] }));
    expect(errors.some((e) => e.includes('needs at least a title or an image'))).toBe(true);
  });

  it("rejects an empty card set", () => {
    const errors = validatePackage(pkg({ cardSets: [set({ entries: [] })] }));
    expect(errors.some((e) => e.includes("has no cards"))).toBe(true);
  });

  it("flags duplicate card set keys", () => {
    const errors = validatePackage(pkg({ cardSets: [set(), set()] }));
    expect(errors).toContain('Duplicate card set key "event".');
  });
});

describe("validatePackage — piece sets", () => {
  const set = (overrides: Partial<PieceSet> = {}): PieceSet => ({
    key: "tokens",
    entries: [{ id: "p1", symbol: "⚔️" }],
    ...overrides,
  });

  it("accepts a piece with only a symbol", () => {
    expect(validatePackage(pkg({ pieceSets: [set()] }))).toEqual([]);
  });

  it("accepts a piece with only an image", () => {
    const errors = validatePackage(
      pkg({ pieceSets: [set({ entries: [{ id: "p1", image: "data:image/png;base64,x" }] })] }),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a piece with neither an image nor a symbol", () => {
    const errors = validatePackage(pkg({ pieceSets: [set({ entries: [{ id: "p1" }] })] }));
    expect(errors.some((e) => e.includes("needs either an image or a symbol"))).toBe(true);
  });

  it("rejects a piece with both an image and a symbol", () => {
    const errors = validatePackage(
      pkg({ pieceSets: [set({ entries: [{ id: "p1", image: "data:image/png;base64,x", symbol: "X" }] })] }),
    );
    expect(errors.some((e) => e.includes("pick one"))).toBe(true);
  });

  it("flags duplicate piece set keys", () => {
    const errors = validatePackage(pkg({ pieceSets: [set(), set()] }));
    expect(errors).toContain('Duplicate piece set key "tokens".');
  });
});

describe("validatePackage — macros", () => {
  it("accepts a well-formed macro", () => {
    expect(validatePackage(pkg({ macros: [{ label: "Initiative", roll: "1d20 + dex" }] }))).toEqual([]);
  });

  it("rejects a macro with no label", () => {
    const errors = validatePackage(pkg({ macros: [{ label: "", roll: "1d20" }] }));
    expect(errors).toContain("A macro is missing its label.");
  });

  it("rejects a macro with no roll expression", () => {
    const errors = validatePackage(pkg({ macros: [{ label: "Initiative", roll: "" }] }));
    expect(errors.some((e) => e.includes("missing its roll expression"))).toBe(true);
  });
});

describe("validatePackage — reports every problem at once, not just the first", () => {
  it("collects independent errors from multiple sections in one call", () => {
    const broken = pkg({
      name: "",
      tracks: [{ key: "BAD", label: "x", values: [] }],
      dice: [{ key: "d1", sides: 1 }],
    });
    const errors = validatePackage(broken);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("isValidPackage", () => {
  it("is true iff validatePackage returns no errors", () => {
    expect(isValidPackage(pkg())).toBe(true);
    expect(isValidPackage(pkg({ name: "" }))).toBe(false);
  });
});
