// Pure geometry for arranging players evenly around the table — e.g. a triangle for 3
// players, a pentagon for 5 — used both to place each player's default colored Token
// (see docs/GAME_DEFINITION.md's "player tokens" request) and, in principle, to give a
// newly-joined player's camera a sensible starting facing (a seat's outward angle).
// Deliberately has no PixiJS/DOM dependency so the math is testable on its own.

export interface SeatPosition {
  x: number;
  y: number;
  /** Radians, pointing from the table's center outward through this seat — "upright"
   * for a player sitting there would mean rotating their camera by this much. */
  angle: number;
}

/** `count` positions evenly spaced around a circle of the given `radius`, starting
 * straight up (angle 0 = -Y, i.e. "north") and going clockwise — so 3 players form a
 * triangle, 4 a square, 5 a pentagon, etc. `count` of 0 returns no seats; a negative
 * radius is treated as 0 (everyone sits at the center, harmlessly degenerate rather
 * than an error). */
export function computeSeatPositions(count: number, radius: number): SeatPosition[] {
  if (count <= 0) return [];
  const r = Math.max(0, radius);
  const seats: SeatPosition[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI;
    seats.push({ x: r * Math.sin(angle), y: -r * Math.cos(angle), angle });
  }
  return seats;
}
