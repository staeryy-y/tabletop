import { describe, expect, it } from "vitest";
import { CardDef, resolveDisplay } from "./card";

const DEF: CardDef = {
  id: "x",
  front: { title: "Front", color: 1 },
  back: { title: "Back", color: 2 },
};

const ME = "peer-me";
const OTHER = "peer-other";

describe("resolveDisplay — not hidden", () => {
  it("shows the back when face-down", () => {
    expect(resolveDisplay(DEF, false, null, ME)).toEqual({ face: DEF.back, eyeBadge: false });
  });

  it("shows the front when face-up", () => {
    expect(resolveDisplay(DEF, true, null, ME)).toEqual({ face: DEF.front, eyeBadge: false });
  });
});

describe("resolveDisplay — hidden", () => {
  it("the hider sees the front plus the eye badge, even when face-down", () => {
    expect(resolveDisplay(DEF, false, ME, ME)).toEqual({ face: DEF.front, eyeBadge: true });
  });

  it("hidden takes precedence over faceUp for the hider — the branch that matters most, since it's the one that keeps a secret", () => {
    expect(resolveDisplay(DEF, true, ME, ME)).toEqual({ face: DEF.front, eyeBadge: true });
    expect(resolveDisplay(DEF, false, ME, ME)).toEqual(resolveDisplay(DEF, true, ME, ME));
  });

  it("any other viewer sees only the back, regardless of faceUp", () => {
    expect(resolveDisplay(DEF, false, ME, OTHER)).toEqual({ face: DEF.back, eyeBadge: false });
    expect(resolveDisplay(DEF, true, ME, OTHER)).toEqual({ face: DEF.back, eyeBadge: false });
  });

  it("a non-owner viewer never gets the eye badge", () => {
    expect(resolveDisplay(DEF, false, ME, OTHER).eyeBadge).toBe(false);
  });
});
