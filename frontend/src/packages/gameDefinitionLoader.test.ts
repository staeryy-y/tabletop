import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPackage } from "./gamePackage";
import {
  GameDefinitionError,
  expandTrackValues,
  fetchBundledPackage,
  loadPackageForRoom,
  parseBundledYaml,
} from "./gameDefinitionLoader";

describe("expandTrackValues", () => {
  it("passes an explicit array through, coercing to numbers", () => {
    expect(expandTrackValues([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("expands an inclusive ascending range string", () => {
    expect(expandTrackValues("8..12")).toEqual([8, 9, 10, 11, 12]);
  });

  it("expands a single-value range", () => {
    expect(expandTrackValues("5..5")).toEqual([5]);
  });

  it("expands a descending range in the written (descending) order", () => {
    expect(expandTrackValues("5..1")).toEqual([5, 4, 3, 2, 1]);
  });

  it("handles negative bounds", () => {
    expect(expandTrackValues("-2..2")).toEqual([-2, -1, 0, 1, 2]);
  });

  it("rejects a malformed range string", () => {
    expect(() => expandTrackValues("8-12")).toThrow(GameDefinitionError);
    expect(() => expandTrackValues("abc")).toThrow(GameDefinitionError);
  });

  it("rejects anything that's neither an array nor a string", () => {
    expect(() => expandTrackValues(42)).toThrow(GameDefinitionError);
    expect(() => expandTrackValues(null)).toThrow(GameDefinitionError);
  });
});

describe("parseBundledYaml", () => {
  it("parses the actual generic-freeform.yaml shape", () => {
    const pkg = parseBundledYaml(`
name: "Generic Freeform"
tracks:
  - { key: bonus1, label: "Bonus 1", values: [0, 1, 2, 3, 4, 5] }
`);
    expect(pkg.name).toBe("Generic Freeform");
    expect(pkg.tracks).toEqual([{ key: "bonus1", label: "Bonus 1", values: [0, 1, 2, 3, 4, 5], resolveAs: undefined, poolDie: undefined }]);
    expect(pkg.dice).toEqual([]);
    expect(pkg.cardSets).toEqual([]);
  });

  it("parses the actual dnd5e-srd.yaml shape, including resolve_as, a range string, and a derived formula track", () => {
    const pkg = parseBundledYaml(`
name: "D&D 5e (SRD)"
tracks:
  - { key: dex, label: Dexterity, values: [8, 9, 10], resolve_as: "floor((value-10)/2)" }
  - key: level
    label: Level
    values: "1..20"
  - key: proficiency
    label: "Proficiency Bonus"
    formula: "ceil(level.raw / 4) + 1"
  - { key: hp, label: "Hit Points", values: "0..40" }
macros:
  - { label: "Initiative", roll: "1d20 + dex" }
`);
    expect(pkg.tracks.find((t) => t.key === "dex")).toEqual({
      key: "dex",
      label: "Dexterity",
      values: [8, 9, 10],
      resolveAs: "floor((value-10)/2)",
      poolDie: undefined,
    });
    expect(pkg.tracks.find((t) => t.key === "level")!.values).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const proficiency = pkg.tracks.find((t) => t.key === "proficiency")!;
    expect(proficiency.resolveAs).toBe("ceil(level.raw / 4) + 1");
    expect(proficiency.values).toEqual([]); // a derived track has no slidable range of its own
    expect(pkg.tracks.find((t) => t.key === "hp")!.values).toHaveLength(41);
    expect(pkg.macros).toEqual([{ label: "Initiative", roll: "1d20 + dex" }]);
  });

  it("maps snake_case pool_die to poolDie", () => {
    const pkg = parseBundledYaml(`
name: "Betrayal-ish"
dice:
  - { key: pip, faces: [0, 0, 0, 1, 1, 2] }
tracks:
  - { key: might, label: Might, values: [1, 2, 3, 4, 5], pool_die: pip }
`);
    expect(pkg.tracks[0].poolDie).toBe("pip");
    expect(pkg.dice[0]).toEqual({ key: "pip", sides: undefined, faces: [0, 0, 0, 1, 1, 2] });
  });

  it("maps cards: to cardSets with the front/back shape gamePackage.ts expects", () => {
    const pkg = parseBundledYaml(`
name: "Cards Test"
cards:
  - set: event
    back: { title: "", color: 3355443 }
    entries:
      - id: e1
        count: 3
        front: { title: "Creepy Puppet", text: "Something happens." }
`);
    expect(pkg.cardSets).toEqual([
      {
        key: "event",
        back: { title: "", text: undefined, color: 3355443, image: undefined },
        entries: [{ id: "e1", count: 3, front: { title: "Creepy Puppet", text: "Something happens.", color: undefined, image: undefined } }],
      },
    ]);
  });

  it("maps pieces: to pieceSets, flattening front.image onto the entry", () => {
    const pkg = parseBundledYaml(`
name: "Pieces Test"
pieces:
  - set: room-tile
    entries:
      - id: kitchen
        front: { image: "assets/tiles/kitchen.png" }
        connectors: [north, south]
`);
    expect(pkg.pieceSets).toEqual([
      { key: "room-tile", entries: [{ id: "kitchen", image: "assets/tiles/kitchen.png", symbol: undefined, connectors: ["north", "south"] }] },
    ]);
  });

  it("a piece entry can also use a bare image/symbol without the front nesting", () => {
    const pkg = parseBundledYaml(`
name: "Pieces Test 2"
pieces:
  - set: markers
    entries:
      - id: star
        symbol: "⭐"
`);
    expect(pkg.pieceSets[0].entries[0]).toEqual({ id: "star", image: undefined, symbol: "⭐", connectors: undefined });
  });

  it("maps mats: to matSets, flattening front.image onto the entry", () => {
    const pkg = parseBundledYaml(`
name: "Mats Test"
mats:
  - set: battlemats
    entries:
      - id: arena
        front: { image: "assets/mats/arena.png" }
        locked: true
`);
    expect(pkg.matSets).toEqual([
      { key: "battlemats", entries: [{ id: "arena", image: "assets/mats/arena.png", symbol: undefined, locked: true }] },
    ]);
  });

  it("a mat entry can also use a bare image/symbol without the front nesting", () => {
    const pkg = parseBundledYaml(`
name: "Mats Test 2"
mats:
  - set: zones
    entries:
      - id: zone1
        symbol: "🟩"
`);
    expect(pkg.matSets[0].entries[0]).toEqual({ id: "zone1", image: undefined, symbol: "🟩", locked: undefined });
  });

  it("defaults tracks/dice/cardSets/pieceSets/macros to empty arrays when omitted", () => {
    const pkg = parseBundledYaml('name: "Bare Minimum"');
    expect(pkg).toEqual(createEmptyPackage("Bare Minimum"));
  });

  it("rejects a document with no name", () => {
    expect(() => parseBundledYaml("tracks: []")).toThrow(GameDefinitionError);
  });

  it("rejects unparseable YAML", () => {
    expect(() => parseBundledYaml("name: [unclosed")).toThrow(GameDefinitionError);
  });

  it("rejects a YAML document that isn't a mapping (e.g. a bare list)", () => {
    expect(() => parseBundledYaml("- just\n- a\n- list")).toThrow(GameDefinitionError);
  });
});

describe("fetchBundledPackage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches /game-defs/<name>.yaml and parses it", async () => {
    fetchMock.mockResolvedValue(new Response('name: "Fetched"', { status: 200 }));
    const pkg = await fetchBundledPackage("generic-freeform");
    expect(fetchMock).toHaveBeenCalledWith("/game-defs/generic-freeform.yaml");
    expect(pkg.name).toBe("Fetched");
  });

  it("throws GameDefinitionError for a 404", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fetchBundledPackage("nonexistent")).rejects.toBeInstanceOf(GameDefinitionError);
  });
});

describe("loadPackageForRoom", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the bundled package for a bundled: ref", async () => {
    fetchMock.mockResolvedValue(new Response('name: "D&D 5e (SRD)"', { status: 200 }));
    const pkg = await loadPackageForRoom("bundled:dnd5e-srd");
    expect(fetchMock).toHaveBeenCalledWith("/game-defs/dnd5e-srd.yaml");
    expect(pkg.name).toBe("D&D 5e (SRD)");
  });

  it("returns the supplied custom package for a custom ref", async () => {
    const custom = createEmptyPackage("My Custom Game");
    const pkg = await loadPackageForRoom("custom", custom);
    expect(pkg).toBe(custom);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty placeholder package for a custom ref with nothing supplied", async () => {
    const pkg = await loadPackageForRoom("custom");
    expect(pkg.cardSets).toEqual([]);
    expect(pkg.name).toContain("not available");
  });
});
