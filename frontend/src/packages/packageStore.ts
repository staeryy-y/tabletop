// Browser-local package storage. Packages deliberately stay on this device; the room
// server never receives their rules or images. localStorage keeps persistence simple
// and inspectable in browser developer tools.
import { GamePackage, normalizePackage } from "./gamePackage";

const STORAGE_KEY = "rpg-tabletop-packages";

export interface StoredPackage {
  id: string;
  pkg: GamePackage;
  updatedAt: string;
}

function readAll(): StoredPackage[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredPackage[];
    return Array.isArray(parsed) ? parsed.map((record) => ({ ...record, pkg: normalizePackage(record.pkg) })) : [];
  } catch {
    return [];
  }
}

function writeAll(records: StoredPackage[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export class PackageStore {
  async list(): Promise<StoredPackage[]> {
    return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<StoredPackage | undefined> {
    return readAll().find((record) => record.id === id);
  }

  async save(id: string, pkg: GamePackage): Promise<StoredPackage> {
    const record: StoredPackage = { id, pkg: normalizePackage(pkg), updatedAt: new Date().toISOString() };
    const records = readAll().filter((item) => item.id !== id);
    records.push(record);
    writeAll(records);
    return record;
  }

  async delete(id: string): Promise<void> {
    writeAll(readAll().filter((record) => record.id !== id));
  }
}

export function newPackageId(): string {
  return `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
