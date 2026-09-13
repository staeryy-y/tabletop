import { describe, expect, it } from "vitest";
import { CardDef, resolveDisplay } from "./card";

const DEF: CardDef = {
  id: "x",
  front: { title: "Front", color: 1 },
  back: { title: "Back", color: 2 },
};

describe("resolveDisplay", () => {
  it("shows the back when face-down and not hidden", () => {
    expect(resolveDisplay(DEF, false, false)).toEqual({ face: DEF.back, eyeBadge: false });
  });

  it("shows the front when face-up and not hidden", () => {
    expect(resolveDisplay(DEF, true, false)).toEqual({ face: DEF.front, eyeBadge: false });
  });

  it("hidden always shows the front plus the eye badge, even when face-down", () => {
    expect(resolveDisplay(DEF, false, true)).toEqual({ face: DEF.front, eyeBadge: true });
  });

  it("hidden takes precedence over faceUp — the branch that matters most, since it's the one that keeps a secret", () => {
    expect(resolveDisplay(DEF, true, true)).toEqual({ face: DEF.front, eyeBadge: true });
    expect(resolveDisplay(DEF, false, true)).toEqual(resolveDisplay(DEF, true, true));
  });
});
