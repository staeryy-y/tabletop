// The /roll grammar — see docs/GAME_DEFINITION.md "Roll grammar". Parsing is
// deliberately separate from evaluation: parseRoll() never needs a game package or an
// RNG, so its syntax rules are testable on their own; evaluateRoll() takes an explicit
// context (dice face sets, track definitions + a *current value* per track) so it never
// needs to know where that context came from — there's no character-sheet/actor system
// built yet, so callers currently have to supply track values themselves.
//
// One deliberate departure from the grammar sketch in the docs: a literal dice pool
// here always requires its count digits (`1d20`, not `d20`). The docs show `[count]` as
// optional, but making it mandatory is what keeps parsing context-free — without a
// required leading digit, a bare `dex` (a stat reference) would be syntactically
// indistinguishable from `d` + die-key `ex`. A bare stat-ref can still *become* a pool at
// evaluation time via that Track's own pool_die — see Tracks in GAME_DEFINITION.md —
// so nothing is actually lost by requiring the count on a literal pool.
import { evaluateFormula } from "./formula";

export class RollParseError extends Error {}
export class RollEvalError extends Error {}

export type Comparator = ">=" | ">" | "<=" | "<" | "==";

export type Aggregator =
  | { kind: "sum" }
  | { kind: "count"; comparator: Comparator; value: number }
  | { kind: "highest"; n: number }
  | { kind: "lowest"; n: number };

export interface DicePoolTerm {
  kind: "pool";
  count: number;
  dieKey: string;
  aggregator: Aggregator;
}
export interface NumberTerm {
  kind: "number";
  value: number;
}
export interface StatTerm {
  kind: "stat";
  name: string;
  raw: boolean;
}
export type Term = DicePoolTerm | NumberTerm | StatTerm;

export interface RollExpr {
  terms: { sign: 1 | -1; term: Term }[];
}

const DICE_TERM = /^(\d+)d([a-zA-Z0-9_]+)(?::(.+))?$/;
const STAT_TERM = /^([a-zA-Z_][a-zA-Z0-9_]*)(\.raw)?$/;
const NUMBER_TERM = /^\d+(\.\d+)?$/;

function parseAggregator(text: string): Aggregator {
  if (text === "sum") return { kind: "sum" };
  let m = text.match(/^highest(\d+)$/);
  if (m) return { kind: "highest", n: Number(m[1]) };
  m = text.match(/^lowest(\d+)$/);
  if (m) return { kind: "lowest", n: Number(m[1]) };
  m = text.match(/^count(>=|<=|==|>|<)(\d+)$/);
  if (m) return { kind: "count", comparator: m[1] as Comparator, value: Number(m[2]) };
  throw new RollParseError(`unrecognized aggregator ${JSON.stringify(text)}`);
}

function parseTerm(text: string): Term {
  let m = text.match(DICE_TERM);
  if (m) {
    const [, count, dieKey, aggText] = m;
    return { kind: "pool", count: Number(count), dieKey, aggregator: aggText ? parseAggregator(aggText) : { kind: "sum" } };
  }
  if (NUMBER_TERM.test(text)) {
    return { kind: "number", value: Number(text) };
  }
  m = text.match(STAT_TERM);
  if (m) {
    return { kind: "stat", name: m[1], raw: m[2] !== undefined };
  }
  throw new RollParseError(`invalid term ${JSON.stringify(text)}`);
}

/** Split "1d20 + dex - 2" into signed term strings without needing real tokenization —
 * the grammar has no parentheses and no term-level unary minus, so scanning for
 * top-level +/- (all whitespace already stripped) is sufficient and unambiguous;
 * "count>=4" and "count>4" style aggregator text never contains a bare "+"/"-". */
function splitTerms(compact: string): { sign: 1 | -1; text: string }[] {
  const pieces: { sign: 1 | -1; text: string }[] = [];
  let sign: 1 | -1 = 1;
  let current = "";
  for (const ch of compact) {
    if (ch === "+" || ch === "-") {
      if (current === "") throw new RollParseError(`unexpected "${ch}" in roll expression`);
      pieces.push({ sign, text: current });
      current = "";
      sign = ch === "+" ? 1 : -1;
    } else {
      current += ch;
    }
  }
  if (current === "") throw new RollParseError("expected a term after the last operator");
  pieces.push({ sign, text: current });
  return pieces;
}

export function parseRoll(input: string): RollExpr {
  const compact = input.replace(/\s+/g, "");
  if (compact === "") throw new RollParseError("empty roll expression");
  return { terms: splitTerms(compact).map(({ sign, text }) => ({ sign, term: parseTerm(text) })) };
}

// --- Evaluation ---

export interface DiceContext {
  [dieKey: string]: number[]; // the die's face values, already expanded from sides or an explicit face list
}

export interface TrackContext {
  resolveAs?: string;
  poolDie?: string;
  /** This track's current value/score for whichever character is rolling — supplied by
   * the caller; roll.ts has no notion of characters/actors of its own. */
  currentValue: number;
}

export interface RollContext {
  dice: DiceContext;
  tracks: Record<string, TrackContext>;
  /** Injectable for deterministic tests; defaults to Math.random. */
  rng?: () => number;
}

interface PoolBreakdown {
  kind: "pool";
  dieKey: string;
  rolls: number[];
  kept: number[];
  value: number;
}
interface NumberBreakdown {
  kind: "number";
  value: number;
}
interface StatBreakdown {
  kind: "stat";
  name: string;
  value: number;
  /** Present when the stat expanded into a pool roll (a pool_die track referenced bare). */
  pool?: PoolBreakdown;
}
export type TermBreakdown = PoolBreakdown | NumberBreakdown | StatBreakdown;

export interface RollResult {
  total: number;
  breakdown: { sign: 1 | -1; term: TermBreakdown }[];
}

/** A numeric die-key (the common case: "20" from "1d20", "6" from "8d6") is always an
 * implicit standard die — faces 1..N — with no registry lookup needed at all, matching
 * how dice notation works everywhere else; a package's `dice:` section only needs to
 * register non-numeric keys (Betrayal's "pip", a "fate" die, ...) or ones with a
 * non-default face distribution. */
function resolveFaces(dieKey: string, ctx: RollContext): number[] {
  if (/^\d+$/.test(dieKey)) {
    const sides = Number(dieKey);
    return Array.from({ length: sides }, (_, i) => i + 1);
  }
  const faces = ctx.dice[dieKey];
  if (!faces) throw new RollEvalError(`unknown die "${dieKey}"`);
  return faces;
}

function rollPool(dieKey: string, count: number, aggregator: Aggregator, ctx: RollContext): PoolBreakdown {
  const faces = resolveFaces(dieKey, ctx);
  const rng = ctx.rng ?? Math.random;
  const rolls = Array.from({ length: count }, () => faces[Math.floor(rng() * faces.length)]);

  let kept = rolls;
  let value: number;
  switch (aggregator.kind) {
    case "sum":
      value = rolls.reduce((a, b) => a + b, 0);
      break;
    case "highest": {
      kept = [...rolls].sort((a, b) => b - a).slice(0, aggregator.n);
      value = kept.reduce((a, b) => a + b, 0);
      break;
    }
    case "lowest": {
      kept = [...rolls].sort((a, b) => a - b).slice(0, aggregator.n);
      value = kept.reduce((a, b) => a + b, 0);
      break;
    }
    case "count": {
      const cmp = comparatorFn(aggregator.comparator);
      kept = rolls.filter((r) => cmp(r, aggregator.value));
      value = kept.length;
      break;
    }
  }
  return { kind: "pool", dieKey, rolls, kept, value };
}

function comparatorFn(c: Comparator): (a: number, b: number) => boolean {
  switch (c) {
    case ">=":
      return (a, b) => a >= b;
    case ">":
      return (a, b) => a > b;
    case "<=":
      return (a, b) => a <= b;
    case "<":
      return (a, b) => a < b;
    case "==":
      return (a, b) => a === b;
  }
}

/** A track's resolved *number* — used both inside formulas (cross-track references)
 * and for a bare stat-ref that isn't a pool_die track. `raw` always short-circuits to
 * the track's plain current value, bypassing resolve_as entirely. */
function resolveTrackNumber(name: string, raw: boolean, ctx: RollContext): number {
  const track = ctx.tracks[name];
  if (!track) throw new RollEvalError(`unknown stat "${name}"`);
  if (raw || !track.resolveAs) return track.currentValue;
  return evaluateFormula(track.resolveAs, (varName, varRaw) =>
    varName === "value" ? track.currentValue : resolveTrackNumber(varName, varRaw, ctx),
  );
}

function evaluateTerm(term: Term, ctx: RollContext): TermBreakdown {
  if (term.kind === "number") return { kind: "number", value: term.value };
  if (term.kind === "pool") return rollPool(term.dieKey, term.count, term.aggregator, ctx);

  // stat
  const track = ctx.tracks[term.name];
  if (!track) throw new RollEvalError(`unknown stat "${term.name}"`);
  if (!term.raw && track.poolDie) {
    const pool = rollPool(track.poolDie, track.currentValue, { kind: "sum" }, ctx);
    return { kind: "stat", name: term.name, value: pool.value, pool };
  }
  return { kind: "stat", name: term.name, value: resolveTrackNumber(term.name, term.raw, ctx) };
}

export function evaluateRoll(expr: RollExpr, ctx: RollContext): RollResult {
  const breakdown = expr.terms.map(({ sign, term }) => ({ sign, term: evaluateTerm(term, ctx) }));
  const total = breakdown.reduce((sum, { sign, term }) => sum + sign * term.value, 0);
  return { total, breakdown };
}

/** Parse and evaluate in one call — what `/roll <expr>` actually does. */
export function roll(input: string, ctx: RollContext): RollResult {
  return evaluateRoll(parseRoll(input), ctx);
}
