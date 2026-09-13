import { useState } from "preact/hooks";
import { ApiError, Me, auth } from "../net/api";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.login;

export function Login({ onLoggedIn }: { onLoggedIn: (me: Me) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await auth.login(username, password);
      onLoggedIn(me);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.loginFailedFallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>{T.title}</h1>
        <p class="hint">{T.subtitle}</p>
        <label>
          {T.usernameLabel}
          <input value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} autofocus />
        </label>
        <label>
          {T.passwordLabel}
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? T.submitBusy : T.submit}
        </button>
        <p class="hint">{T.firstRunHint}</p>
        <p class="hint">
          {T.noAccountPrompt}
          <a href="#/new">{T.noAccountLink}</a>
        </p>
      </form>
    </div>
  );
}
