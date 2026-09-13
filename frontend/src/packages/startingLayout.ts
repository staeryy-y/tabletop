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
