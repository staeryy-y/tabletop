import { useEffect, useState } from "preact/hooks";
import { ApiError, rooms } from "../net/api";
import { StoredPackage, PackageStore } from "../packages/packageStore";
import { rememberRoomPackageId } from "../roomPackageChoice";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.newAnonymousRoom;

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
        <h1>{T.title}</h1>
        <p class="hint">{T.subtitle}</p>
        <label>
          {T.roomNameLabel}
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required autofocus />
        </label>
        <label>
          {T.passwordLabel}
          <input value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          {T.gameLabel}
          <select value={gameDefRef} onChange={(e) => setGameDefRef((e.target as HTMLSelectElement).value)}>
            <option value="bundled:generic-freeform">{T.genericFreeformOption}</option>
            <option value="bundled:dnd5e-srd">{T.dnd5eOption}</option>
            {customPackages.map((p) => (
              <option value={`custom:${p.id}`} key={p.id}>
                {T.localPackageOption(p.pkg.name)}
              </option>
            ))}
          </select>
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? T.submitBusy : T.submit}
        </button>
        <p class="hint">
          {T.haveAccountPrompt}
          <a href="#/">{T.haveAccountLink}</a>
        </p>
      </form>
    </div>
  );
}
