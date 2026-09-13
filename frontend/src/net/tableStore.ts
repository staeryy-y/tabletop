// Client-side persistence for a room's *table* state (the object model's piles and
// pieces — see engine/pileModel.ts), keyed by room slug. This is what actually fixes
// "the host refreshes and the game resets": the host's own browser remembers what the
// table looked like without needing the signaling server at all, so reopening the same
// room (even offline, even before any WS connection completes) can resume instantly.
// The signaling server's own recovery snapshot (app/signaling.py's RoomState.snapshot)
// still exists separately, for the different case this can't cover — a *different*
// peer being promoted to host after the original one is gone for good, who has no
// local copy of their own to fall back to.
import { PieceState, PileState, TableSnapshot } from "../engine/pileModel";

const DB_NAME = "rpg-tabletop-table";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** See packages/packageStore.ts's identical helper's doc comment: a short-lived
 * connection per operation, always closed, so nothing here can block a later
 * open/deleteDatabase elsewhere (e.g. a test resetting between cases). */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export class TableStore {
  /** The most recently saved snapshot for this room, or null if this browser has never
   * saved one (a peer that's never been host, or a genuinely new room). Also accepts
   * the pre-pieces shape (a bare PileState[], from before pieces existed at all) and
   * upgrades it in place to `{ piles, pieces: [] }` — so a room saved by an older build
   * of this app still resumes correctly instead of silently losing its saved table the
   * first time a newer build reads it back. */
  async load(slug: string): Promise<TableSnapshot | null> {
    return withDb(async (db) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const result = await promisifyRequest(tx.objectStore(STORE_NAME).get(slug));
      if (result === undefined) return null;
      if (Array.isArray(result)) return { piles: result as PileState[], pieces: [] };
      return result as TableSnapshot;
    });
  }

  async save(slug: string, piles: PileState[], pieces: PieceState[]): Promise<void> {
    await withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put({ piles, pieces } satisfies TableSnapshot, slug);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    );
  }
}
