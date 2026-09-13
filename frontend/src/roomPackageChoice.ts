// Remembers which local custom package (see packages/packageStore.ts) a GM picked for
// a room they created. Necessary because the server only ever records "custom" for
// game_def_ref (see docs/DECISIONS.md D14) — never which one — so the only place that
// mapping can live is the browser that made the choice. Only meaningful for whoever
// created the room; a different peer opening a "custom" room has no way to know which
// package was meant (that's the P2P package transfer M6 is for) and falls back to the
// empty placeholder in gameDefinitionLoader.ts.
function key(slug: string): string {
  return `rpg-tabletop:room-package:${slug}`;
}

export function rememberRoomPackageId(slug: string, packageId: string): void {
  window.localStorage.setItem(key(slug), packageId);
}

export function getRememberedRoomPackageId(slug: string): string | null {
  return window.localStorage.getItem(key(slug));
}
