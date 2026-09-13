// Pure layout math shared between the editor's starting-layout preview
// (GamePackageEditor.tsx's StartingLayoutPreview) and the actual runtime spawn logic
// (ui/RoomTable.tsx) — so wherever a GM drags a stack to in the editor is exactly where
// it lands when the room actually starts, and so what shows for a *not yet* repositioned
// set is one, agreed-on answer instead of two implementations drifting apart. No
// PixiJS/DOM dependency at all, so this is directly unit-testable.

/** Where a card set's stack lands when nothing has explicitly repositioned it (see
 * CardSet.startX/startY) — an even horizontal spread centered on the table, matching
 * this project's original hardcoded default from before per-set positions existed at
 * all, so a package authored before this field existed still lays out the same way. */
export function defaultCardSetPosition(index: number, total: number): { x: number; y: number } {
  const spacing = 110;
  return { x: (index - (total - 1) / 2) * spacing, y: -150 };
}

/** Where a piece set's *anchor* point sits when nothing has explicitly repositioned it
 * (see PieceSet.startX/startY) — on the opposite side of the table from
 * defaultCardSetPosition's row, so freshly-spawned pieces and cards don't start on top
 * of each other. Unlike a card set, a piece set has no single stack position of its
 * own — see pieceEntryOffset for why individual entries still need their own distinct
 * spot fanned out from this anchor. */
export function defaultPieceSetPosition(index: number, total: number): { x: number; y: number } {
  const spacing = 130;
  return { x: (index - (total - 1) / 2) * spacing, y: 150 };
}

/** Individual pieces within a set fan out from the set's anchor point in a simple
 * grid — pieces never merge into one shared stack the way a card set's entries do (see
 * docs/GAME_DEFINITION.md "Pieces"), so each entry needs a distinct position of its
 * own, not just one shared position. */
export function pieceEntryOffset(entryIndex: number): { x: number; y: number } {
  const columns = 4;
  const spacing = 46;
  return { x: (entryIndex % columns) * spacing, y: Math.floor(entryIndex / columns) * spacing };
}

/** Where a mat set's anchor point sits when nothing has explicitly repositioned it —
 * same idea as defaultPieceSetPosition, centered on the table's origin rather than
 * offset above/below it like the card/piece rows: a Mat always renders beneath every
 * Card/Piece (docs/DECISIONS.md D26), so starting it dead center, right where
 * everything else already tends to land, is what actually makes it read as "a surface
 * things get placed on" instead of an out-of-the-way decoration. */
export function defaultMatSetPosition(index: number, total: number): { x: number; y: number } {
  const spacing = 260;
  return { x: (index - (total - 1) / 2) * spacing, y: 0 };
}

/** Individual mats within a set fan out horizontally from the set's anchor — mats
 * never merge into a shared stack any more than pieces do. A single row (unlike
 * pieceEntryOffset's grid) since a mat set is typically just a couple of large
 * surfaces (e.g. two players' battle mats), not dozens of small tokens. */
export function matEntryOffset(entryIndex: number): { x: number; y: number } {
  const spacing = 240;
  return { x: entryIndex * spacing, y: 0 };
}
