import { useState } from "preact/hooks";
import { ApiError, Me, auth } from "../net/api";

/** The forced first-login flow for any account with mustChangePassword set — the
 * bootstrap admin/admin account, or one an admin just created. Both the username and
 * password are placeholders someone else assigned, so both get replaced together; see
 * app/auth.py's complete_setup docstring for why "admin" specifically shouldn't stick
 * around as a real identity. */
export function AccountSetup({ me, onDone }: { me: Me; onDone: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (next !== confirm) {
      setError("passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await auth.completeSetup(current, username, next);
      onDone(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to complete setup");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>Finish setting up your account</h1>
        <p class="hint">
          "{me.username}" is a placeholder, not a real account yet — pick a real username and password to
          continue.
        </p>
        <label>
          New username
          <input
            value={username}
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            autofocus
            required
          />
        </label>
        <label>
          Current password
          <input type="password" value={current} onInput={(e) => setCurrent((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          New password
          <input type="password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Finish setup"}
        </button>
      </form>
    </div>
  );
}
