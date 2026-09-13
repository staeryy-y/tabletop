import { useState } from "preact/hooks";
import { ApiError, auth } from "../net/api";

export function ChangePassword({ onDone }: { onDone: () => void }) {
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
      await auth.changePassword(current, next);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="centered-page">
      <form class="panel" onSubmit={submit}>
        <h1>Set a real password</h1>
        <p class="hint">This account still has its bootstrap password. Choose a new one to continue.</p>
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
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
