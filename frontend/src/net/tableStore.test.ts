// fake-indexeddb gives a real (in-memory) IndexedDB implementation — see
// packages/packageStore.test.ts's identical setup note for why this isn't a hand-rolled
// mock and why the database is deleted fresh before each test.
import { beforeEach, describe, expect, it } from "vitest";
import { PieceState, PileState } from "../engine/pileModel";
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
const PIECES: PieceState[] = [{ id: "piece-1", x: 3, y: 4, rotation: 0, def: { id: "pc", symbol: "♟" } }];

describe("TableStore", () => {
  it("load() returns null for a room that was never saved", async () => {
    expect(await new TableStore().load("room-a")).toBeNull();
  });

  it("save() then load() round-trips the piles and pieces", async () => {
    const store = new TableStore();
    await store.save("room-a", PILES, PIECES);
    expect(await store.load("room-a")).toEqual({ piles: PILES, pieces: PIECES });
  });

  it("save() overwrites the previous snapshot for the same room", async () => {
    const store = new TableStore();
    await store.save("room-a", PILES, PIECES);
    const updated: PileState[] = [{ id: "p2", x: 9, y: 9, rotation: 0, cards: [] }];

    await store.save("room-a", updated, []);

    expect(await store.load("room-a")).toEqual({ piles: updated, pieces: [] });
  });

  it("keeps different rooms independent", async () => {
    const store = new TableStore();
    const other: PileState[] = [{ id: "other", x: 0, y: 0, rotation: 0, cards: [] }];

    await store.save("room-a", PILES, PIECES);
    await store.save("room-b", other, []);

    expect(await store.load("room-a")).toEqual({ piles: PILES, pieces: PIECES });
    expect(await store.load("room-b")).toEqual({ piles: other, pieces: [] });
  });

  it("save() with empty arrays round-trips as empty arrays, not null", async () => {
    const store = new TableStore();
    await store.save("room-a", [], []);
    expect(await store.load("room-a")).toEqual({ piles: [], pieces: [] });
  });

  it("load() upgrades a pre-pieces snapshot (a bare piles array, from an older build) instead of losing it", async () => {
    const store = new TableStore();
    // Simulate what an older build of this app actually wrote: the bare array itself,
    // not {piles, pieces} — write it directly rather than through save(), which only
    // ever produces the current shape.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("rpg-tabletop-table", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("snapshots")) req.result.createObjectStore("snapshots");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(PILES, "room-a");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    expect(await store.load("room-a")).toEqual({ piles: PILES, pieces: [] });
  });
});
