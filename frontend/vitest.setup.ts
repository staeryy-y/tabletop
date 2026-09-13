// Vitest's jsdom environment, at these package versions, doesn't reliably expose a
// working localStorage on window/globalThis (Node's own newer built-in `localStorage`
// global — gated behind --localstorage-file — appears to shadow jsdom's). Rather than
// depend on that combination staying fixed, install a tiny in-memory Storage-compatible
// polyfill for the test run only; production code still uses the real
// window.localStorage in an actual browser.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

// jsdom doesn't implement canvas 2D contexts (that needs the native `canvas` package,
// which we don't otherwise need). Merely *importing* pixi.js touches
// HTMLCanvasElement.prototype.getContext for a feature-detection probe, which logs a
// noisy "Not implemented" error to stderr in every test file that imports anything from
// engine/card.ts — even ones, like card.test.ts, that never actually render to a
// canvas. A stub that returns null is exactly what a browser lacking that context type
// would also return, so this doesn't hide a real failure, just jsdom's limitation.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

// Same story as canvas above: jsdom defines its own indexedDB that looks real (methods
// exist, requests get created) but never actually dispatches success/error events,
// which just hangs anything that awaits it forever rather than failing loudly. Force
// fake-indexeddb's real (in-memory) implementation into place instead of relying on
// fake-indexeddb/auto's self-registering import, which doesn't win against jsdom's
// existing property here.
import * as fakeIndexedDb from "fake-indexeddb";

for (const target of [globalThis, typeof window !== "undefined" ? window : undefined]) {
  if (!target) continue;
  Object.defineProperty(target, "indexedDB", { value: fakeIndexedDb.indexedDB, configurable: true, writable: true });
  Object.defineProperty(target, "IDBKeyRange", { value: fakeIndexedDb.IDBKeyRange, configurable: true, writable: true });
}

if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.clear !== "function") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
  }
}
