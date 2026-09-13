import { describe, expect, it } from "vitest";
import { computeSeatPositions } from "./seating";

describe("computeSeatPositions", () => {
  it("returns no seats for a count of zero or fewer", () => {
    expect(computeSeatPositions(0, 100)).toEqual([]);
    expect(computeSeatPositions(-3, 100)).toEqual([]);
  });

  it("returns exactly `count` seats", () => {
    expect(computeSeatPositions(5, 100)).toHaveLength(5);
  });

  it("every seat sits exactly `radius` from the center", () => {
    for (const seat of computeSeatPositions(7, 50)) {
      expect(Math.hypot(seat.x, seat.y)).toBeCloseTo(50, 10);
    }
  });

  it("a single seat sits due north (straight up) at angle 0", () => {
    const [seat] = computeSeatPositions(1, 100);
    expect(seat.angle).toBe(0);
    expect(seat.x).toBeCloseTo(0);
    expect(seat.y).toBeCloseTo(-100);
  });

  it("3 players form a triangle: 120 degrees apart", () => {
    const seats = computeSeatPositions(3, 100);
    const step = (2 * Math.PI) / 3;
    expect(seats[0].angle).toBeCloseTo(0);
    expect(seats[1].angle).toBeCloseTo(step);
    expect(seats[2].angle).toBeCloseTo(2 * step);
  });

  it("5 players form a pentagon: 72 degrees apart", () => {
    const seats = computeSeatPositions(5, 100);
    const step = (2 * Math.PI) / 5;
    seats.forEach((seat, i) => expect(seat.angle).toBeCloseTo(i * step));
  });

  it("4 players form a square: seats at north/east/south/west", () => {
    const [n, e, s, w] = computeSeatPositions(4, 10);
    expect([n.x, n.y]).toEqual([0, -10].map((v) => expect.closeTo(v)));
    expect(e.x).toBeCloseTo(10);
    expect(e.y).toBeCloseTo(0);
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(10);
    expect(w.x).toBeCloseTo(-10);
    expect(w.y).toBeCloseTo(0);
  });

  it("a radius of 0 collapses every seat to the center without throwing", () => {
    for (const seat of computeSeatPositions(6, 0)) {
      expect(seat.x).toBeCloseTo(0);
      expect(seat.y).toBeCloseTo(0);
    }
  });

  it("treats a negative radius as zero rather than throwing or flipping seats", () => {
    const seats = computeSeatPositions(4, -50);
    for (const seat of seats) {
      expect(Math.hypot(seat.x, seat.y)).toBeCloseTo(0);
    }
  });
});
