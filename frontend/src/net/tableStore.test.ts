// fake-indexeddb gives a real (in-memory) IndexedDB implementation — see
// packages/packageStore.test.ts's identical setup note for why this isn't a hand-rolled
// mock and why the database is deleted fresh before each test.
import { beforeEach, describe, expect, it } from "vitest";
import { PileState } from "../engine/pileModel";
import { TableStore } from "./tableStore";

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("rpg-tabletop-table");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

const PILES: PileState[] = [{ id: "p1", x: 1, y: 2, rotation: 0, cards: [] }];

describe("TableStore", () => {
  it("load() returns null for a room that was never saved", async () => {
    expect(await new TableStore().load("room-a")).toBeNull();
  });

  it("save() then load() round-trips the piles", async () => {
    const store = new TableStore();
    await store.save("room-a", PILES);
    expect(await store.load("room-a")).toEqual(PILES);
  });

  it("save() overwrites the previous snapshot for the same room", async () => {
    const store = new TableStore();
    await store.save("room-a", PILES);
    const updated: PileState[] = [{ id: "p2", x: 9, y: 9, rotation: 0, cards: [] }];

    await store.save("room-a", updated);

    expect(await store.load("room-a")).toEqual(updated);
  });

  it("keeps different rooms independent", async () => {
    const store = new TableStore();
    const other: PileState[] = [{ id: "other", x: 0, y: 0, rotation: 0, cards: [] }];

    await store.save("room-a", PILES);
    await store.save("room-b", other);

    expect(await store.load("room-a")).toEqual(PILES);
    expect(await store.load("room-b")).toEqual(other);
  });

  it("save() with an empty array round-trips as an empty array, not null", async () => {
    const store = new TableStore();
    await store.save("room-a", []);
    expect(await store.load("room-a")).toEqual([]);
  });
});
