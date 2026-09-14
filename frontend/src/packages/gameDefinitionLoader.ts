// Turns a room's game_def_ref (see app/rooms.py) into the one runtime GamePackage
// shape everything else uses — regardless of whether it came from a bundled YAML file
// (docs/GAME_DEFINITION.md's schema: snake_case, top-level `cards`/`pieces`) or a
// custom package built in the editor (gamePackage.ts's schema: camelCase,
// `cardSets`/`pieceSets`). Nothing downstream needs to know which source it came from.
import yaml from "js-yaml";
import { CardEntry, CardSet, DiceDef, GamePackage, MacroDef, MatEntry, MatSet, PieceEntry, PieceSet, TrackDef, createEmptyPackage } from "./gamePackage";

export class GameDefinitionError extends Error {}

/** A Track's `values` field accepts either a literal array or the quoted range
 * shorthand `"start..end"` (inclusive) — see docs/GAME_DEFINITION.md's Tracks section
 * for why this has to be a string: plain YAML/JSON has no native range syntax, so
 * unquoted `[8..20]` would silently parse as a one-element array containing the literal
 * string "8..20", not an actual range. Only the YAML-authoring path needs this; the
 * in-app editor (GamePackageEditor.tsx) always produces a plain array directly. */
export function expandTrackValues(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  if (typeof raw === "string") {
    const m = raw.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (!m) throw new GameDefinitionError(`invalid track values ${JSON.stringify(raw)} — expected an array or "start..end"`);
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const out: number[] = [];
    for (let v = lo; v <= hi; v++) out.push(v);
    return a <= b ? out : out.reverse();
  }
  throw new GameDefinitionError(`invalid track values ${JSON.stringify(raw)} — expected an array or a "start..end" string`);
}

interface YamlFace {
  title?: string;
  text?: string;
  color?: number;
  image?: string;
  image_fit?: "contain" | "cover";
}
interface YamlCardEntry {
  id: string;
  front: YamlFace;
  count?: number;
}
interface YamlCardSet {
  set: string;
  back?: YamlFace;
  entries: YamlCardEntry[];
}
interface YamlPieceEntry {
  id: string;
  front?: YamlFace; // docs show pieces nesting under `front` like cards; either that or a bare image/symbol is accepted
  image?: string;
  symbol?: string;
  connectors?: string[];
}
interface YamlPieceSet {
  set: string;
  entries: YamlPieceEntry[];
}
interface YamlMatEntry {
  id: string;
  front?: YamlFace;
  image?: string;
  symbol?: string;
  locked?: boolean;
  text?: string;
  background?: number;
  width?: number;
  height?: number;
}
interface YamlMatSet {
  set: string;
  entries: YamlMatEntry[];
}
interface YamlTrack {
  key: string;
  label?: string;
  values?: unknown;
  resolve_as?: string;
  pool_die?: string;
  formula?: string;
}
interface YamlDocument {
  name: string;
  tracks?: YamlTrack[];
  dice?: { key: string; sides?: number; faces?: number[] }[];
  cards?: YamlCardSet[];
  pieces?: YamlPieceSet[];
  mats?: YamlMatSet[];
  macros?: MacroDef[];
}

function mapTrack(t: YamlTrack): TrackDef {
  // A derived (non-slidable) track — see the dnd5e-srd proficiency example — has a
  // `formula` and no `values` of its own; give it an empty range rather than crashing,
  // since nothing slides it directly.
  return {
    key: t.key,
    label: t.label ?? t.key,
    values: t.values !== undefined ? expandTrackValues(t.values) : [],
    resolveAs: t.resolve_as ?? t.formula,
    poolDie: t.pool_die,
  };
}

function mapDie(d: { key: string; sides?: number; faces?: number[] }): DiceDef {
  return { key: d.key, sides: d.sides, faces: d.faces };
}

function mapCardEntry(e: YamlCardEntry): CardEntry {
  return { id: e.id, front: { title: e.front.title ?? "", text: e.front.text, color: e.front.color, image: e.front.image, ...(e.front.image_fit ? { imageFit: e.front.image_fit } : {}) }, count: e.count };
}

function mapCardSet(s: YamlCardSet): CardSet {
  return { key: s.set, back: s.back && { title: s.back.title ?? "", text: s.back.text, color: s.back.color, image: s.back.image }, entries: s.entries.map(mapCardEntry) };
}

function mapPieceEntry(e: YamlPieceEntry): PieceEntry {
  return { id: e.id, image: e.image ?? e.front?.image, symbol: e.symbol, connectors: e.connectors };
}

function mapPieceSet(s: YamlPieceSet): PieceSet {
  return { key: s.set, entries: s.entries.map(mapPieceEntry) };
}

function mapMatEntry(e: YamlMatEntry): MatEntry {
  return { id: e.id, image: e.image ?? e.front?.image, symbol: e.symbol, locked: e.locked, text: e.text, background: e.background, width: e.width, height: e.height };
}

function mapMatSet(s: YamlMatSet): MatSet {
  return { key: s.set, entries: s.entries.map(mapMatEntry) };
}

/** Parse a bundled game definition's YAML text (docs/GAME_DEFINITION.md's schema) into
 * the same GamePackage shape a custom, editor-built package already uses. */
export function parseBundledYaml(text: string): GamePackage {
  let doc: YamlDocument;
  try {
    doc = yaml.load(text) as YamlDocument;
  } catch (err) {
    throw new GameDefinitionError(`failed to parse YAML: ${err instanceof Error ? err.message : err}`);
  }
  if (!doc || typeof doc !== "object" || typeof doc.name !== "string") {
    throw new GameDefinitionError("a game definition must be a YAML document with at least a `name` field");
  }
  return {
    name: doc.name,
    tracks: (doc.tracks ?? []).map(mapTrack),
    dice: (doc.dice ?? []).map(mapDie),
    cardSets: (doc.cards ?? []).map(mapCardSet),
    pieceSets: (doc.pieces ?? []).map(mapPieceSet),
    matSets: (doc.mats ?? []).map(mapMatSet),
    macros: doc.macros ?? [],
  };
}

export async function fetchBundledPackage(name: string): Promise<GamePackage> {
  const res = await fetch(`/game-defs/${name}.yaml`);
  if (!res.ok) throw new GameDefinitionError(`no bundled game definition named "${name}"`);
  return parseBundledYaml(await res.text());
}

/** Resolve a room's game_def_ref (app/rooms.py: "bundled:<name>" or "custom") into a
 * usable package. For "custom", the actual content only exists in whichever browser
 * has it (see docs/DECISIONS.md D14) — the caller supplies it (e.g. from its own
 * packageStore.ts) since this module has no notion of "which custom package". Returns
 * an empty freeform package if a custom room has no local package available yet (the
 * honest state for a peer other than the one who authored it, ahead of M6's P2P
 * package transfer). */
export async function loadPackageForRoom(gameDefRef: string, customPackage?: GamePackage): Promise<GamePackage> {
  if (gameDefRef.startsWith("bundled:")) {
    return fetchBundledPackage(gameDefRef.slice("bundled:".length));
  }
  return customPackage ?? createEmptyPackage("(custom package not available in this browser)");
}
