import { useState } from "preact/hooks";
import { DiceContext, RollContext, RollError, TrackContext, formatRollResult, roll } from "../engine/roll";
import { GamePackage } from "../packages/gamePackage";

// Chat + /roll + macros, driven by the room's game package (tracks/dice/macros — see
// docs/GAME_DEFINITION.md). Local to this tab only for now: chat isn't synced across
// browsers yet (that needs the P2P layer, M6 in docs/PLAN.md), same as the table itself.
//
// There's no character-sheet/actor system yet, so each player's current track values
// live here as a tiny "quick sheet" — local numbers only you can see/edit, not synced
// to anyone else. `/roll dex` resolves against *your own* quick-sheet value for `dex`.

interface Message {
  author: string;
  text: string;
  isError?: boolean;
}

function buildDiceContext(pkg: GamePackage): DiceContext {
  const dice: DiceContext = {};
  for (const d of pkg.dice) {
    dice[d.key] = d.faces && d.faces.length > 0 ? d.faces : Array.from({ length: d.sides ?? 0 }, (_, i) => i + 1);
  }
  return dice;
}

export function Chat({ pkg, displayName }: { pkg: GamePackage | null; displayName: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [trackValues, setTrackValues] = useState<Record<string, number>>({});

  function post(author: string, text: string, isError = false) {
    setMessages((prev) => [...prev, { author, text, isError }]);
  }

  function buildRollContext(): RollContext {
    const tracks: Record<string, TrackContext> = {};
    for (const t of pkg?.tracks ?? []) {
      const fallback = t.values.length > 0 ? t.values[0] : 0;
      tracks[t.key] = { resolveAs: t.resolveAs, poolDie: t.poolDie, currentValue: trackValues[t.key] ?? fallback };
    }
    return { dice: pkg ? buildDiceContext(pkg) : {}, tracks };
  }

  function runRoll(expr: string) {
    try {
      const result = roll(expr, buildRollContext());
      post(displayName, `/roll ${expr} → ${formatRollResult(result)}`);
    } catch (err) {
      post(displayName, err instanceof RollError ? err.message : String(err), true);
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const rollMatch = text.match(/^\/r(?:oll)?\s+(.+)$/);
    if (rollMatch) {
      runRoll(rollMatch[1]);
    } else {
      post(displayName, text);
    }
    setInput("");
  }

  return (
    <div class="chat">
      <div class="chat-log">
        {messages.map((m, i) => (
          <div class={"chat-message" + (m.isError ? " error" : "")} key={i}>
            <strong>{m.author}:</strong> {m.text}
          </div>
        ))}
        {messages.length === 0 && <p class="hint">Chat is local to this tab for now (not yet synced — see M6).</p>}
      </div>

      {pkg && pkg.tracks.length > 0 && (
        <details class="quick-sheet">
          <summary>Your sheet ({pkg.name})</summary>
          {pkg.tracks.map((t) => (
            <label key={t.key} class="quick-sheet-row">
              {t.label}
              <input
                type="number"
                value={trackValues[t.key] ?? (t.values[0] ?? 0)}
                onInput={(e) => setTrackValues((prev) => ({ ...prev, [t.key]: Number((e.target as HTMLInputElement).value) }))}
              />
            </label>
          ))}
        </details>
      )}

      {pkg && pkg.macros.length > 0 && (
        <div class="macros">
          {pkg.macros.map((m) => (
            <button key={m.label} onClick={() => runRoll(m.roll)} title={m.roll}>
              {m.label}
            </button>
          ))}
        </div>
      )}

      <form class="chat-input" onSubmit={handleSubmit}>
        <input
          value={input}
          placeholder="/roll 1d20 + dex, or just chat"
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
