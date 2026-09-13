import { useEffect, useState } from "preact/hooks";
import { ApiError, RoomPublicInfo, rooms } from "../net/api";
import { storeRoomToken } from "../roomToken";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.roomJoin;

export function RoomJoin({ slug }: { slug: string }) {
  const [info, setInfo] = useState<RoomPublicInfo | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rooms
      .get(slug)
      .then(setInfo)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [slug]);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await rooms.join(slug, displayName, password || undefined);
      storeRoomToken(slug, result);
      location.hash = `#/room/${slug}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !info) {
    return (
      <div class="centered-page">
        <p class="error">{error}</p>
      </div>
    );
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>{info ? info.name : T.loading}</h1>
        <p class="hint">{T.subtitle(Boolean(info?.hasPassword))}</p>
        <label>
          {T.displayNameLabel}
          <input
            value={displayName}
            onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
            maxLength={32}
            required
            autofocus
          />
        </label>
        {info?.hasPassword && (
          <label>
            {T.roomPasswordLabel}
            <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
          </label>
        )}
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy || !info}>
          {busy ? T.submitBusy : T.submit}
        </button>
      </form>
    </div>
  );
}
