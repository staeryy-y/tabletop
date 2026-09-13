import { useEffect, useRef, useState } from "preact/hooks";
import { GamePackage, createEmptyPackage } from "../packages/gamePackage";
import { PackageStore, StoredPackage, newPackageId } from "../packages/packageStore";
import { GamePackageEditor } from "./GamePackageEditor";

// The game-package manager: create/edit/import/export/delete packages, entirely
// client-side (IndexedDB — see packages/packageStore.ts) since the server never stores
// a room's rules or assets (docs/DECISIONS.md D14). Picking one of these when creating
// a room, and actually loading it into a live table, is separate follow-up work — this
// is the authoring side.
const store = new PackageStore();

export function GamePackages() {
  const [packages, setPackages] = useState<StoredPackage[]>([]);
  const [editing, setEditing] = useState<StoredPackage | { id: null; pkg: GamePackage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setPackages(await store.list());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(pkg: GamePackage) {
    const id = editing && editing.id ? editing.id : newPackageId();
    await store.save(id, pkg);
    setEditing(null);
    await refresh();
  }

  async function remove(id: string) {
    if (!confirm("Delete this package? This cannot be undone.")) return;
    await store.delete(id);
    await refresh();
  }

  function exportPackage(record: StoredPackage) {
    const blob = new Blob([JSON.stringify(record.pkg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.pkg.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "package"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const pkg = JSON.parse(await file.text()) as GamePackage;
      if (!pkg || typeof pkg !== "object" || !Array.isArray(pkg.cardSets)) {
        throw new Error("that doesn't look like a game package file");
      }
      await store.save(newPackageId(), pkg);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to import package");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (editing) {
    return (
      <section class="panel">
        <h2>{editing.id ? `Edit "${editing.pkg.name}"` : "New game package"}</h2>
        <GamePackageEditor initial={editing.pkg} onSave={save} onCancel={() => setEditing(null)} />
      </section>
    );
  }

  return (
    <section class="panel">
      <h2>Game packages</h2>
      <p class="hint">
        Rules content — tracks, dice, cards, pieces, macros — for rooms to use. Cards can have images or
        just text; pieces can have images or an emoji/symbol. Lives in this browser only (see
        docs/DECISIONS.md D14) — export a package to share or back it up.
      </p>
      {error && <p class="error">{error}</p>}
      <ul class="room-list">
        {packages.map((record) => (
          <li key={record.id}>
            <strong>{record.pkg.name}</strong>
            <span class="hint">
              {" "}
              &middot; {record.pkg.cardSets.length} card set(s), {record.pkg.pieceSets.length} piece set(s) &middot;{" "}
            </span>
            <button onClick={() => setEditing(record)}>Edit</button>{" "}
            <button onClick={() => exportPackage(record)}>Export</button>{" "}
            <button onClick={() => remove(record.id)}>Delete</button>
          </li>
        ))}
        {packages.length === 0 && <li class="hint">No custom packages yet — create one, or import a file.</li>}
      </ul>
      <div class="editor-actions">
        <button onClick={() => setEditing({ id: null, pkg: createEmptyPackage("New Package") })}>
          + New package
        </button>
        <input ref={fileInput} type="file" accept="application/json" onChange={(e) => importFile((e.target as HTMLInputElement).files?.[0])} />
      </div>
    </section>
  );
}
