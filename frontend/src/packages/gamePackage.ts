// The pure data model for a game package — see docs/GAME_DEFINITION.md. Content only:
// tracks, dice, and the two families of table objects (Card sets, Piece sets). No
// PixiJS/DOM/storage dependency at all, so every rule about what makes a package valid
// lives here and is directly testable, independent of how it's edited or persisted.
//
// v1 packages are a single JSON document with images embedded as data: URIs, not the
// folder-of-files format sketched in GAME_DEFINITION.md ("Game packages") — simpler to
// implement first; a multi-file/zip export is a natural follow-up, not a breaking
// change to this shape.

export interface CardFaceContent {
  title: string;
  text?: string;
  /** Either a plain color (matches engine/card.ts's placeholder rendering) or an
   * uploaded image as a data: URI — never both. */
  color?: number;
  image?: string;
}

export interface CardEntry {
  id: string;
  front: CardFaceContent;
}

export interface CardSet {
  key: string;
  back?: CardFaceContent;
  entries: CardEntry[];
}

export interface PieceEntry {
  id: string;
  /** A piece's face is one of: an uploaded image, or a symbol (an emoji or a short
   * unicode/text glyph) — see the explicit request in GAME_DEFINITION.md-adjacent
   * discussion: "pieces can be emoji or unicode symbols, or uploaded images." */
  image?: string;
  symbol?: string;
  connectors?: string[];
}

export interface PieceSet {
  key: string;
  entries: PieceEntry[];
}

export interface TrackDef {
  key: string;
  label: string;
  /** The sequence of values this track can slide through, e.g. [8,9,...,20]. */
  values: number[];
  resolveAs?: string;
  poolDie?: string;
}

export interface DiceDef {
  key: string;
  /** Either a plain d-N shorthand or an explicit custom face list — never both. */
  sides?: number;
  faces?: number[];
}

export interface MacroDef {
  label: string;
  roll: string;
}

export interface GamePackage {
  name: string;
  tracks: TrackDef[];
  dice: DiceDef[];
  cardSets: CardSet[];
  pieceSets: PieceSet[];
  macros: MacroDef[];
}

export function createEmptyPackage(name: string): GamePackage {
  return { name, tracks: [], dice: [], cardSets: [], pieceSets: [], macros: [] };
}

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Every reason (if any) this package isn't usable, in a stable, predictable order —
 * checked exhaustively rather than stopping at the first problem, since an editor wants
 * to show a user everything wrong with their package at once, not one error per save
 * attempt. */
export function validatePackage(pkg: GamePackage): string[] {
  const errors: string[] = [];

  if (!pkg.name.trim()) errors.push("Package needs a name.");

  const trackKeys = new Set<string>();
  for (const track of pkg.tracks) {
    if (!KEY_PATTERN.test(track.key)) {
      errors.push(`Track key "${track.key}" must start with a lowercase letter and contain only lowercase letters, digits, "_", or "-".`);
    } else if (trackKeys.has(track.key)) {
      errors.push(`Duplicate track key "${track.key}".`);
    }
    trackKeys.add(track.key);
    if (track.values.length === 0) errors.push(`Track "${track.key}" needs at least one value.`);
    if (track.poolDie && !pkg.dice.some((d) => d.key === track.poolDie)) {
      errors.push(`Track "${track.key}" references pool_die "${track.poolDie}", which isn't one of this package's dice.`);
    }
  }

  const diceKeys = new Set<string>();
  for (const die of pkg.dice) {
    if (!KEY_PATTERN.test(die.key)) errors.push(`Die key "${die.key}" is not a valid key.`);
    else if (diceKeys.has(die.key)) errors.push(`Duplicate die key "${die.key}".`);
    diceKeys.add(die.key);

    const hasSides = die.sides !== undefined;
    const hasFaces = die.faces !== undefined && die.faces.length > 0;
    if (hasSides === hasFaces) {
      errors.push(`Die "${die.key}" must have exactly one of sides or faces (not both, not neither).`);
    }
    if (hasSides && die.sides! < 2) errors.push(`Die "${die.key}" needs at least 2 sides.`);
  }

  const cardSetKeys = new Set<string>();
  for (const set of pkg.cardSets) {
    if (cardSetKeys.has(set.key)) errors.push(`Duplicate card set key "${set.key}".`);
    cardSetKeys.add(set.key);
    if (set.entries.length === 0) errors.push(`Card set "${set.key}" has no cards.`);
    for (const entry of set.entries) {
      if (!entry.front.title.trim() && !entry.front.image) {
        errors.push(`A card in set "${set.key}" (id "${entry.id}") needs at least a title or an image.`);
      }
    }
  }

  const pieceSetKeys = new Set<string>();
  for (const set of pkg.pieceSets) {
    if (pieceSetKeys.has(set.key)) errors.push(`Duplicate piece set key "${set.key}".`);
    pieceSetKeys.add(set.key);
    for (const entry of set.entries) {
      if (!entry.image && !entry.symbol) {
        errors.push(`A piece in set "${set.key}" (id "${entry.id}") needs either an image or a symbol.`);
      }
      if (entry.image && entry.symbol) {
        errors.push(`A piece in set "${set.key}" (id "${entry.id}") has both an image and a symbol — pick one.`);
      }
    }
  }

  for (const macro of pkg.macros) {
    if (!macro.label.trim()) errors.push("A macro is missing its label.");
    if (!macro.roll.trim()) errors.push(`Macro "${macro.label}" is missing its roll expression.`);
  }

  return errors;
}

export function isValidPackage(pkg: GamePackage): boolean {
  return validatePackage(pkg).length === 0;
}
