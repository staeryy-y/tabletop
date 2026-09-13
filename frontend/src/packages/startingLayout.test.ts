import { describe, expect, it } from "vitest";
import { defaultCardSetPosition, defaultPieceSetPosition, pieceEntryOffset } from "./startingLayout";

describe("defaultCardSetPosition", () => {
  it("centers a single set on the table", () => {
    expect(defaultCardSetPosition(0, 1)).toEqual({ x: 0, y: -150 });
  });

  it("spreads multiple sets evenly around x = 0", () => {
    const positions = [0, 1, 2].map((i) => defaultCardSetPosition(i, 3));
    expect(positions[1].x).toBe(0); // the middle one is centered
    expect(positions[0].x).toBeLessThan(0);
    expect(positions[2].x).toBeGreaterThan(0);
    expect(positions[2].x - positions[1].x).toBe(positions[1].x - positions[0].x); // evenly spaced
  });

  it("every set lands on the same y", () => {
    for (let i = 0; i < 4; i++) expect(defaultCardSetPosition(i, 4).y).toBe(-150);
  });
});

describe("defaultPieceSetPosition", () => {
  it("centers a single set on the table, on the opposite side from card sets", () => {
    const pos = defaultPieceSetPosition(0, 1);
    expect(pos).toEqual({ x: 0, y: 150 });
    expect(pos.y).not.toBe(defaultCardSetPosition(0, 1).y);
  });

  it("spreads multiple sets evenly around x = 0", () => {
    const positions = [0, 1, 2].map((i) => defaultPieceSetPosition(i, 3));
    expect(positions[1].x).toBe(0);
    expect(positions[0].x).toBeLessThan(0);
    expect(positions[2].x).toBeGreaterThan(0);
    expect(positions[2].x - positions[1].x).toBe(positions[1].x - positions[0].x);
  });

  it("every set lands on the same y", () => {
    for (let i = 0; i < 4; i++) expect(defaultPieceSetPosition(i, 4).y).toBe(150);
  });
});

describe("pieceEntryOffset", () => {
  it("the first entry sits right at the anchor (zero offset)", () => {
    expect(pieceEntryOffset(0)).toEqual({ x: 0, y: 0 });
  });

  it("fans out left-to-right within a row before wrapping to the next row", () => {
    const first = pieceEntryOffset(0);
    const second = pieceEntryOffset(1);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBe(first.y);
  });

  it("wraps to a new row (y increases, x resets) after enough entries", () => {
    const wrapped = pieceEntryOffset(4);
    expect(wrapped.x).toBe(pieceEntryOffset(0).x);
    expect(wrapped.y).toBeGreaterThan(pieceEntryOffset(0).y);
  });

  it("every offset is distinct for the first 20 entries — no two pieces land on top of each other", () => {
    const offsets = Array.from({ length: 20 }, (_, i) => pieceEntryOffset(i));
    const keys = new Set(offsets.map((o) => `${o.x},${o.y}`));
    expect(keys.size).toBe(20);
  });
});
