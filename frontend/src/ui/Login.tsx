import { useState } from "preact/hooks";
import { ApiError, Me, auth } from "../net/api";

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
      setError(err instanceof ApiError ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>rpg-tabletop</h1>
        <p class="hint">Admin login. No public signup — accounts are invite-only.</p>
        <label>
          Username
          <input value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} autofocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        <p class="hint">First run? Log in with admin / admin — you'll be asked to change it.</p>
        <p class="hint">
          Just want to play? <a href="#/new">Start a game without an account</a>
        </p>
      </form>
    </div>
  );
}
