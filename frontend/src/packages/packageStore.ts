// Client-side storage for game packages — see docs/DECISIONS.md D14: the server never
// stores a room's rules or assets, so a package a GM builds/imports has to live
// somewhere in their own browser. IndexedDB (not localStorage) because packages embed
// images as data: URIs and can get into the megabytes, well past what localStorage's
// ~5MB-per-origin quota comfortably holds.
import { GamePackage } from "./gamePackage";

const DB_NAME = "rpg-tabletop-packages";
const DB_VERSION = 1;
const STORE_NAME = "packages";

export interface StoredPackage {
  id: string;
  pkg: GamePackage;
  updatedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
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

/** Runs `fn` against a freshly-opened connection and always closes it afterward —
 * every PackageStore method is one short-lived operation, not a long-held connection,
 * specifically so nothing here can block a later open/deleteDatabase elsewhere (e.g. a
 * test resetting between cases, or a schema upgrade from another tab) the way a leaked
 * connection would. */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export class PackageStore {
  async list(): Promise<StoredPackage[]> {
    return withDb(async (db) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const all = await promisifyRequest(tx.objectStore(STORE_NAME).getAll());
      return (all as StoredPackage[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  async get(id: string): Promise<StoredPackage | undefined> {
    return withDb(async (db) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      return (await promisifyRequest(tx.objectStore(STORE_NAME).get(id))) as StoredPackage | undefined;
    });
  }

  async save(id: string, pkg: GamePackage): Promise<StoredPackage> {
    const record: StoredPackage = { id, pkg, updatedAt: new Date().toISOString() };
    await withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    );
    return record;
  }

  async delete(id: string): Promise<void> {
    await withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    );
  }
}

export function newPackageId(): string {
  return `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
