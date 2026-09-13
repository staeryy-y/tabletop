// A small arithmetic expression evaluator for Track `resolveAs`/`formula` fields — see
// docs/GAME_DEFINITION.md's Tracks section, e.g. `floor((value - 10) / 2)` (score to
// modifier) or `ceil(level.raw / 4) + 1` (a derived track referencing another one).
// Deliberately not `eval`/`new Function`: even though this only ever runs against a
// package its own user authored, a real parser is easy enough here and means a
// malformed formula fails as a clear parse error rather than an opaque runtime one.
//
// Grammar (standard precedence, left-associative):
//   expr   := term (("+" | "-") term)*
//   term   := factor (("*" | "/") factor)*
//   factor := NUMBER | IDENTIFIER ["." "raw"] | "(" expr ")" | "-" factor
//           | IDENTIFIER "(" expr ("," expr)* ")"   -- a function call

export class FormulaError extends Error {}

type TokenType = "number" | "ident" | "op" | "lparen" | "rparen" | "comma" | "dot" | "eof";
interface Token {
  type: TokenType;
  text: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      tokens.push({ type: "number", text: input.slice(i, j) });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      tokens.push({ type: "ident", text: input.slice(i, j) });
      i = j;
    } else if ("+-*/".includes(c)) {
      tokens.push({ type: "op", text: c });
      i++;
    } else if (c === "(") {
      tokens.push({ type: "lparen", text: c });
      i++;
    } else if (c === ")") {
      tokens.push({ type: "rparen", text: c });
      i++;
    } else if (c === ",") {
      tokens.push({ type: "comma", text: c });
      i++;
    } else if (c === ".") {
      tokens.push({ type: "dot", text: c });
      i++;
    } else {
      throw new FormulaError(`unexpected character ${JSON.stringify(c)} in formula ${JSON.stringify(input)}`);
    }
  }
  tokens.push({ type: "eof", text: "" });
  return tokens;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
};

export type VariableLookup = (name: string, raw: boolean) => number;

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private lookup: VariableLookup) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new FormulaError(`expected ${type} but got ${JSON.stringify(t.text)}`);
    return t;
  }

  atEnd(): boolean {
    return this.peek().type === "eof";
  }

  parseExpr(): number {
    let value = this.parseTerm();
    while (this.peek().type === "op" && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.next().text;
      const rhs = this.parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (this.peek().type === "op" && (this.peek().text === "*" || this.peek().text === "/")) {
      const op = this.next().text;
      const rhs = this.parseFactor();
      if (op === "/") {
        if (rhs === 0) throw new FormulaError("division by zero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  private parseFactor(): number {
    const t = this.peek();
    if (t.type === "op" && t.text === "-") {
      this.next();
      return -this.parseFactor();
    }
    if (t.type === "number") {
      this.next();
      return Number(t.text);
    }
    if (t.type === "lparen") {
      this.next();
      const value = this.parseExpr();
      this.expect("rparen");
      return value;
    }
    if (t.type === "ident") {
      this.next();
      if (this.peek().type === "lparen") {
        this.next();
        const fn = FUNCTIONS[t.text];
        if (!fn) throw new FormulaError(`unknown function "${t.text}"`);
        const args: number[] = [this.parseExpr()];
        while (this.peek().type === "comma") {
          this.next();
          args.push(this.parseExpr());
        }
        this.expect("rparen");
        return fn(...args);
      }
      let raw = false;
      if (this.peek().type === "dot") {
        this.next();
        const accessor = this.expect("ident");
        if (accessor.text !== "raw") throw new FormulaError(`unknown accessor ".${accessor.text}"`);
        raw = true;
      }
      return this.lookup(t.text, raw);
    }
    throw new FormulaError(`unexpected token ${JSON.stringify(t.text)}`);
  }
}

/** Evaluate a formula string against a variable lookup (e.g. other tracks' current
 * values). Throws FormulaError on any syntax problem or unresolved reference — a
 * malformed package should fail loudly and specifically, not silently produce NaN. */
export function evaluateFormula(input: string, lookup: VariableLookup): number {
  const parser = new Parser(tokenize(input), lookup);
  const result = parser.parseExpr();
  if (!parser.atEnd()) {
    throw new FormulaError(`unexpected trailing input in formula ${JSON.stringify(input)}`);
  }
  return result;
}
