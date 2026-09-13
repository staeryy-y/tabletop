import { useEffect, useState } from "preact/hooks";
import { ApiError, rooms } from "../net/api";
import { StoredPackage, PackageStore } from "../packages/packageStore";
import { rememberRoomPackageId } from "../roomPackageChoice";

// No account needed at all (docs/DECISIONS.md D19) — the room this creates never
// touches the server's database; see app/rooms.py's own docstring for what "anonymous"
// means here. Mirrors AdminDashboard.tsx's room-creation form, minus anything that
// implies an account (no "your rooms" list — there's nowhere to list an anonymous room
// even if there were one to show).
const packageStore = new PackageStore();

export function NewAnonymousRoom() {
  const [customPackages, setCustomPackages] = useState<StoredPackage[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [gameDefRef, setGameDefRef] = useState("bundled:generic-freeform");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    packageStore.list().then(setCustomPackages);
  }, []);

  async function createRoom(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const isCustom = gameDefRef.startsWith("custom:");
      const { slug } = await rooms.createAnonymous(name, password || null, isCustom ? "custom" : gameDefRef);
      if (isCustom) rememberRoomPackageId(slug, gameDefRef.slice("custom:".length));
      location.hash = `#/room/${slug}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={createRoom}>
        <h1>Start a game</h1>
        <p class="hint">No account needed — this room isn't saved anywhere on the server.</p>
        <label>
          Room name
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required autofocus />
        </label>
        <label>
          Password (optional)
          <input value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Game
          <select value={gameDefRef} onChange={(e) => setGameDefRef((e.target as HTMLSelectElement).value)}>
            <option value="bundled:generic-freeform">Generic Freeform</option>
            <option value="bundled:dnd5e-srd">D&amp;D 5e (SRD)</option>
            {customPackages.map((p) => (
              <option value={`custom:${p.id}`} key={p.id}>
                {p.pkg.name} (this browser)
              </option>
            ))}
          </select>
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create room"}
        </button>
        <p class="hint">
          Have an account? <a href="#/">Log in instead</a>
        </p>
      </form>
    </div>
  );
}
