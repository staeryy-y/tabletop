import { useEffect, useRef, useState } from "preact/hooks";
import { DiceContext, RollContext, RollError, TrackContext, formatRollResult, roll } from "../engine/roll";
import { ChatMessage } from "../net/chatSync";
import { GamePackage } from "../packages/gamePackage";

// Chat + /roll + macros, driven by the room's game package (tracks/dice/macros — see
// docs/GAME_DEFINITION.md). The message log itself is owned by the caller (RoomTable.tsx,
// via net/chatSync.ts) and handed down as `messages` — every post goes out through
// `onPost` rather than local state, so it's synced across every connected player, host
// or peer.
//
// There's no character-sheet/actor system yet, so each player's current track values
// live here as a tiny "quick sheet" — local numbers only you can see/edit, not synced
// to anyone else. `/roll dex` resolves against *your own* quick-sheet value for `dex`.

function buildDiceContext(pkg: GamePackage): DiceContext {
  const dice: DiceContext = {};
  for (const d of pkg.dice) {
    dice[d.key] = d.faces && d.faces.length > 0 ? d.faces : Array.from({ length: d.sides ?? 0 }, (_, i) => i + 1);
  }
  return dice;
}

interface ChatProps {
  pkg: GamePackage | null;
  displayName: string;
  messages: ChatMessage[];
  onPost: (message: ChatMessage) => void;
}

export function Chat({ pkg, displayName, messages, onPost }: ChatProps) {
  const [input, setInput] = useState("");
  const [trackValues, setTrackValues] = useState<Record<string, number>>({});
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the log scrolled to the newest message as history/new messages arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function post(text: string, isError = false) {
    onPost({ author: displayName, text, isError });
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
      post(`/roll ${expr} → ${formatRollResult(result)}`);
    } catch (err) {
      post(err instanceof RollError ? err.message : String(err), true);
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
      post(text);
    }
    setInput("");
  }

  return (
    <div class="chat">
      <div class="chat-log" ref={logRef}>
        {messages.map((m, i) => (
          <div class={"chat-message" + (m.isError ? " error" : "")} key={i}>
            <strong>{m.author}:</strong> {m.text}
          </div>
        ))}
        {messages.length === 0 && <p class="hint">No messages yet. Say hello, or try /roll 1d20.</p>}
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
