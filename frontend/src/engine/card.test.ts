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
    expect(resolveDisplay(DEF, false, null, ME)).toEqual({ face: DEF.back, hiddenByPeerId: null });
  });

  it("shows the front when face-up", () => {
    expect(resolveDisplay(DEF, true, null, ME)).toEqual({ face: DEF.front, hiddenByPeerId: null });
  });
});

describe("resolveDisplay — hidden", () => {
  it("the hider sees the front, even when face-down", () => {
    expect(resolveDisplay(DEF, false, ME, ME)).toEqual({ face: DEF.front, hiddenByPeerId: ME });
  });

  it("hidden takes precedence over faceUp for the hider — the branch that matters most, since it's the one that keeps a secret", () => {
    expect(resolveDisplay(DEF, true, ME, ME)).toEqual({ face: DEF.front, hiddenByPeerId: ME });
    expect(resolveDisplay(DEF, false, ME, ME)).toEqual(resolveDisplay(DEF, true, ME, ME));
  });

  it("any other viewer sees only the back, regardless of faceUp", () => {
    expect(resolveDisplay(DEF, false, ME, OTHER)).toEqual({ face: DEF.back, hiddenByPeerId: ME });
    expect(resolveDisplay(DEF, true, ME, OTHER)).toEqual({ face: DEF.back, hiddenByPeerId: ME });
  });

  it("a non-owner viewer still learns *who* hid it (D25: visible eye, colored per-player) even though the content stays hidden", () => {
    expect(resolveDisplay(DEF, false, ME, OTHER).hiddenByPeerId).toBe(ME);
    expect(resolveDisplay(DEF, false, ME, OTHER).face).toEqual(DEF.back);
  });
});
