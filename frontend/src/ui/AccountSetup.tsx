import { useState } from "preact/hooks";
import { ApiError, Me, auth } from "../net/api";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.accountSetup;

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
      setError(T.passwordMismatch);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await auth.completeSetup(current, username, next);
      onDone(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T.setupFailedFallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>{T.title}</h1>
        <p class="hint">{T.placeholderNotice(me.username)}</p>
        <label>
          {T.newUsernameLabel}
          <input
            value={username}
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            autofocus
            required
          />
        </label>
        <label>
          {T.currentPasswordLabel}
          <input type="password" value={current} onInput={(e) => setCurrent((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          {T.newPasswordLabel}
          <input type="password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          {T.confirmPasswordLabel}
          <input type="password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? T.submitBusy : T.submit}
        </button>
      </form>
    </div>
  );
}
