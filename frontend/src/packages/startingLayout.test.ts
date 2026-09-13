import { describe, expect, it } from "vitest";
import { defaultCardSetPosition } from "./startingLayout";

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
