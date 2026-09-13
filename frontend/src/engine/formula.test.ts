import { describe, expect, it } from "vitest";
import { FormulaError, evaluateFormula } from "./formula";

const noVars = () => {
  throw new Error("no variables expected");
};

describe("evaluateFormula — arithmetic", () => {
  it("evaluates a plain number", () => {
    expect(evaluateFormula("42", noVars)).toBe(42);
  });

  it("adds and subtracts, left to right", () => {
    expect(evaluateFormula("1 + 2 - 3", noVars)).toBe(0);
  });

  it("multiplies and divides, left to right", () => {
    expect(evaluateFormula("2 * 3 / 4", noVars)).toBeCloseTo(1.5);
  });

  it("respects standard precedence: * before +", () => {
    expect(evaluateFormula("2 + 3 * 4", noVars)).toBe(14);
  });

  it("parentheses override precedence", () => {
    expect(evaluateFormula("(2 + 3) * 4", noVars)).toBe(20);
  });

  it("handles nested parentheses", () => {
    expect(evaluateFormula("((1 + 2) * (3 + 4))", noVars)).toBe(21);
  });

  it("unary minus", () => {
    expect(evaluateFormula("-5 + 3", noVars)).toBe(-2);
  });

  it("unary minus on a parenthesized expression", () => {
    expect(evaluateFormula("-(2 + 3)", noVars)).toBe(-5);
  });

  it("division by zero is a FormulaError, not Infinity/NaN", () => {
    expect(() => evaluateFormula("1 / 0", noVars)).toThrow(FormulaError);
  });

  it("ignores whitespace", () => {
    expect(evaluateFormula("  1   +    2  ", noVars)).toBe(3);
  });

  it("accepts decimal numbers", () => {
    expect(evaluateFormula("1.5 + 2.5", noVars)).toBe(4);
  });
});

describe("evaluateFormula — functions", () => {
  it("floor, ceil, round, abs", () => {
    expect(evaluateFormula("floor(1.9)", noVars)).toBe(1);
    expect(evaluateFormula("ceil(1.1)", noVars)).toBe(2);
    expect(evaluateFormula("round(1.5)", noVars)).toBe(2);
    expect(evaluateFormula("abs(-5)", noVars)).toBe(5);
  });

  it("min/max take multiple arguments", () => {
    expect(evaluateFormula("min(3, 1, 2)", noVars)).toBe(1);
    expect(evaluateFormula("max(3, 1, 2)", noVars)).toBe(3);
  });

  it("functions compose with arithmetic — the D&D modifier formula", () => {
    expect(evaluateFormula("floor((value - 10) / 2)", (name) => (name === "value" ? 16 : NaN))).toBe(3);
    expect(evaluateFormula("floor((value - 10) / 2)", (name) => (name === "value" ? 8 : NaN))).toBe(-1);
  });

  it("an unknown function name is a FormulaError", () => {
    expect(() => evaluateFormula("bogus(1)", noVars)).toThrow(FormulaError);
  });
});

describe("evaluateFormula — variable lookup", () => {
  it("resolves a bare identifier via the lookup callback", () => {
    expect(evaluateFormula("level", (name) => (name === "level" ? 7 : NaN))).toBe(7);
  });

  it("passes raw=true only for a .raw-suffixed identifier", () => {
    const calls: [string, boolean][] = [];
    evaluateFormula("level.raw", (name, raw) => {
      calls.push([name, raw]);
      return 5;
    });
    expect(calls).toEqual([["level", true]]);
  });

  it("passes raw=false for a bare identifier", () => {
    const calls: [string, boolean][] = [];
    evaluateFormula("level", (name, raw) => {
      calls.push([name, raw]);
      return 5;
    });
    expect(calls).toEqual([["level", false]]);
  });

  it("the derived-track example: ceil(level.raw / 4) + 1", () => {
    const result = evaluateFormula("ceil(level.raw / 4) + 1", (name, raw) => {
      if (name === "level" && raw) return 5;
      throw new Error("unexpected lookup");
    });
    expect(result).toBe(3); // ceil(5/4)=2, +1=3
  });

  it("an accessor other than .raw is a FormulaError", () => {
    expect(() => evaluateFormula("level.bogus", noVars)).toThrow(FormulaError);
  });
});

describe("evaluateFormula — malformed input", () => {
  it("an unexpected character is a FormulaError", () => {
    expect(() => evaluateFormula("1 & 2", noVars)).toThrow(FormulaError);
  });

  it("a missing closing paren is a FormulaError", () => {
    expect(() => evaluateFormula("(1 + 2", noVars)).toThrow(FormulaError);
  });

  it("trailing garbage after a valid expression is a FormulaError", () => {
    expect(() => evaluateFormula("1 + 2 3", noVars)).toThrow(FormulaError);
  });

  it("an empty string is a FormulaError, not 0", () => {
    expect(() => evaluateFormula("", noVars)).toThrow(FormulaError);
  });

  it("a dangling operator is a FormulaError", () => {
    expect(() => evaluateFormula("1 +", noVars)).toThrow(FormulaError);
  });
});
