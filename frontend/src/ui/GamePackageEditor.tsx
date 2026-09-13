import { useEffect, useRef, useState } from "preact/hooks";
import {
  CardEntry,
  CardSet,
  DiceDef,
  GamePackage,
  MacroDef,
  PieceEntry,
  PieceSet,
  TrackDef,
  validatePackage,
} from "../packages/gamePackage";
import { readImageAsDataUrl } from "../packages/imageUpload";
import { defaultCardSetPosition } from "../packages/startingLayout";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.gamePackageEditor;

let nextId = 1;
const freshId = (prefix: string) => `${prefix}-${nextId++}`;

function colorToCss(color: number | undefined): string | undefined {
  return color === undefined ? undefined : `#${color.toString(16).padStart(6, "0")}`;
}

function parseNumberList(text: string): number[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export function GamePackageEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: GamePackage;
  onSave: (pkg: GamePackage) => void;
  onCancel: () => void;
}) {
  const [pkg, setPkg] = useState<GamePackage>(initial);
  const errors = validatePackage(pkg);

  function update(patch: Partial<GamePackage>) {
    setPkg((p) => ({ ...p, ...patch }));
  }

  return (
    <div class="editor">
      <label>
        {T.packageNameLabel}
        <input value={pkg.name} onInput={(e) => update({ name: (e.target as HTMLInputElement).value })} />
      </label>

      <TracksEditor tracks={pkg.tracks} dice={pkg.dice} onChange={(tracks) => update({ tracks })} />
      <DiceEditor dice={pkg.dice} onChange={(dice) => update({ dice })} />
      <CardSetsEditor cardSets={pkg.cardSets} onChange={(cardSets) => update({ cardSets })} />
      <PieceSetsEditor pieceSets={pkg.pieceSets} onChange={(pieceSets) => update({ pieceSets })} />
      <MacrosEditor macros={pkg.macros} onChange={(macros) => update({ macros })} />

      {errors.length > 0 && (
        <div class="editor-errors">
          {errors.map((e) => (
            <p class="error" key={e}>
              {e}
            </p>
          ))}
        </div>
      )}

      <div class="editor-actions">
        <button onClick={onCancel}>{T.cancel}</button>
        <button disabled={errors.length > 0} onClick={() => onSave(pkg)}>
          {T.savePackage}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <fieldset class="editor-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

/** A plain in-page overlay dialog (not a browser window) — used for filling in a new
 * card/piece's details before it's added, rather than dropping a blank tile straight
 * into the grid (see the explicit request in docs/DECISIONS.md D23). Closes on Escape
 * or a click on the backdrop, same as the existing right-click card menu's
 * click-outside-to-close behavior (engine/table.ts's closeMenu). */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: preact.ComponentChildren }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function TracksEditor({ tracks, dice, onChange }: { tracks: TrackDef[]; dice: DiceDef[]; onChange: (t: TrackDef[]) => void }) {
  const t = T.tracks;

  function add() {
    onChange([...tracks, { key: `track${tracks.length + 1}`, label: t.newTrackDefaultLabel, values: [0, 1, 2, 3, 4, 5] }]);
  }
  function update(i: number, patch: Partial<TrackDef>) {
    onChange(tracks.map((tr, idx) => (idx === i ? { ...tr, ...patch } : tr)));
  }
  function remove(i: number) {
    onChange(tracks.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      {tracks.map((tr, i) => (
        <div class="editor-row" key={i}>
          <input class="key-input" value={tr.key} placeholder={t.keyPlaceholder} onInput={(e) => update(i, { key: (e.target as HTMLInputElement).value })} />
          <input value={tr.label} placeholder={t.labelPlaceholder} onInput={(e) => update(i, { label: (e.target as HTMLInputElement).value })} />
          <input
            value={tr.values.join(",")}
            placeholder={t.valuesPlaceholder}
            onInput={(e) => update(i, { values: parseNumberList((e.target as HTMLInputElement).value) })}
          />
          <select
            value={tr.poolDie ?? ""}
            onChange={(e) => update(i, { poolDie: (e.target as HTMLSelectElement).value || undefined })}
          >
            <option value="">{t.noPoolDieOption}</option>
            {dice.map((d) => (
              <option value={d.key} key={d.key}>
                {t.poolDieOption(d.key)}
              </option>
            ))}
          </select>
          <button onClick={() => remove(i)}>{t.remove}</button>
        </div>
      ))}
      <button onClick={add}>{t.addTrack}</button>
    </Section>
  );
}

function DiceEditor({ dice, onChange }: { dice: DiceDef[]; onChange: (d: DiceDef[]) => void }) {
  const t = T.dice;

  function add() {
    onChange([...dice, { key: `d${dice.length + 1}`, sides: 6 }]);
  }
  function update(i: number, patch: Partial<DiceDef>) {
    onChange(dice.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }
  function remove(i: number) {
    onChange(dice.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      {dice.map((d, i) => (
        <div class="editor-row" key={i}>
          <input class="key-input" value={d.key} placeholder={t.keyPlaceholder} onInput={(e) => update(i, { key: (e.target as HTMLInputElement).value })} />
          <input
            type="number"
            value={d.sides ?? ""}
            placeholder={t.sidesPlaceholder}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              update(i, { sides: v ? Number(v) : undefined, faces: v ? undefined : d.faces });
            }}
          />
          <input
            value={d.faces?.join(",") ?? ""}
            placeholder={t.facesPlaceholder}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              const faces = parseNumberList(v);
              update(i, { faces: faces.length ? faces : undefined, sides: faces.length ? undefined : d.sides });
            }}
          />
          <button onClick={() => remove(i)}>{t.remove}</button>
        </div>
      ))}
      <button onClick={add}>{t.addDie}</button>
    </Section>
  );
}

function CardSetsEditor({ cardSets, onChange }: { cardSets: CardSet[]; onChange: (c: CardSet[]) => void }) {
  const t = T.cardSets;

  function addSet() {
    onChange([...cardSets, { key: `set${cardSets.length + 1}`, entries: [] }]);
  }
  function updateSet(i: number, patch: Partial<CardSet>) {
    onChange(cardSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSet(i: number) {
    onChange(cardSets.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      <StartingLayoutPreview cardSets={cardSets} onMove={updateSet} />
      {cardSets.map((set, i) => (
        <div class="editor-subsection" key={i}>
          <div class="editor-row">
            <input class="key-input" value={set.key} placeholder={t.keyPlaceholder} onInput={(e) => updateSet(i, { key: (e.target as HTMLInputElement).value })} />
            <input
              value={set.label ?? ""}
              placeholder={t.labelPlaceholder}
              onInput={(e) => updateSet(i, { label: (e.target as HTMLInputElement).value || undefined })}
            />
            <button onClick={() => removeSet(i)}>{t.removeSet}</button>
          </div>
          <CardEntriesEditor entries={set.entries} onChange={(entries) => updateSet(i, { entries })} />
        </div>
      ))}
      <button onClick={addSet}>{t.addSet}</button>
    </Section>
  );
}

/** A small draggable map of where each card set's stack appears when the room first
 * starts — the "configure, visually, how the table should look on a new start" request.
 * Coordinates map onto the same world-coordinate range engine/table.ts actually spawns
 * things in (see LAYOUT_WORLD_WIDTH/HEIGHT below); a set that's never been dragged shows
 * at the same auto-spread position the runtime would use for it (startingLayout.ts),
 * so this preview and the real room always agree. */
const LAYOUT_WORLD_WIDTH = 900;
const LAYOUT_WORLD_HEIGHT = 640;

function StartingLayoutPreview({ cardSets, onMove }: { cardSets: CardSet[]; onMove: (i: number, patch: Partial<CardSet>) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  if (cardSets.length === 0) return null;

  function positionOf(i: number): { x: number; y: number } {
    const set = cardSets[i];
    if (set.startX !== undefined && set.startY !== undefined) return { x: set.startX, y: set.startY };
    return defaultCardSetPosition(i, cardSets.length);
  }

  function moveTo(i: number, clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const relY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    onMove(i, {
      startX: Math.round(relX * LAYOUT_WORLD_WIDTH - LAYOUT_WORLD_WIDTH / 2),
      startY: Math.round(relY * LAYOUT_WORLD_HEIGHT - LAYOUT_WORLD_HEIGHT / 2),
    });
  }

  return (
    <div>
      <p class="hint">{T.cardSets.layoutHint}</p>
      <div
        class="layout-preview"
        ref={containerRef}
        onPointerMove={(e) => dragging !== null && moveTo(dragging, e.clientX, e.clientY)}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {cardSets.map((set, i) => {
          const pos = positionOf(i);
          const left = ((pos.x + LAYOUT_WORLD_WIDTH / 2) / LAYOUT_WORLD_WIDTH) * 100;
          const top = ((pos.y + LAYOUT_WORLD_HEIGHT / 2) / LAYOUT_WORLD_HEIGHT) * 100;
          return (
            <div
              key={set.key}
              class="layout-preview-token"
              style={{ left: `${left}%`, top: `${top}%` }}
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                setDragging(i);
              }}
            >
              {set.label || set.key}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The "+ Add card" modal — fills in a new card's details before it's added to the
 * grid, rather than dropping a blank tile in and editing it in place (D23). Mirrors
 * exactly what an existing tile lets you edit (title, body text, image) — nothing new,
 * just asked for up front instead of after the fact. */
function NewCardModal({ onCreate, onCancel }: { onCreate: (entry: CardEntry) => void; onCancel: () => void }) {
  const t = T.cardEntries;
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadImage(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setImage(await readImageAsDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : T.readImageFailedFallback);
    } finally {
      setBusy(false);
    }
  }

  function create() {
    onCreate({ id: freshId("card"), front: { title: title.trim() || t.newCardDefaultTitle, text: text.trim() || undefined, image } });
  }

  return (
    <Modal title={t.modalTitle} onClose={onCancel}>
      <label>
        {t.modalTitleLabel}
        <input value={title} placeholder={t.modalTitlePlaceholder} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} autofocus />
      </label>
      <label>
        {t.modalTextLabel}
        <input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        {t.modalImageLabel}
        <input type="file" accept="image/*" onChange={(e) => uploadImage((e.target as HTMLInputElement).files?.[0])} />
      </label>
      {busy && <span class="hint">{t.readingHint}</span>}
      {error && <p class="error">{error}</p>}
      <div class="modal-actions">
        <button onClick={onCancel}>{T.cancel}</button>
        <button onClick={create}>{t.createButton}</button>
      </div>
    </Modal>
  );
}

function CardEntriesEditor({ entries, onChange }: { entries: CardEntry[]; onChange: (e: CardEntry[]) => void }) {
  const t = T.cardEntries;
  const [busy, setBusy] = useState<string | null>(null);
  const [showNewCard, setShowNewCard] = useState(false);

  function update(i: number, patch: Partial<CardEntry["front"]>) {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, front: { ...e.front, ...patch } } : e)));
  }
  function remove(i: number) {
    onChange(entries.filter((_, idx) => idx !== i));
  }
  async function uploadImage(i: number, file: File | undefined) {
    if (!file) return;
    setBusy(entries[i].id);
    try {
      update(i, { image: await readImageAsDataUrl(file), title: entries[i].front.title });
    } catch (err) {
      alert(err instanceof Error ? err.message : T.readImageFailedFallback);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div class="entry-grid">
        {entries.map((entry, i) => (
          <div class="entry-tile" key={entry.id}>
            {entry.front.image ? (
              <img class="entry-tile-preview" src={entry.front.image} alt={t.imageAltText} />
            ) : (
              <div class="entry-tile-preview entry-tile-preview-empty" style={{ background: colorToCss(entry.front.color) }}>
                {!entry.front.title && t.emptyPreviewPlaceholder}
              </div>
            )}
            <input
              value={entry.front.title}
              placeholder={t.titlePlaceholder}
              onInput={(e) => update(i, { title: (e.target as HTMLInputElement).value })}
            />
            <input
              value={entry.front.text ?? ""}
              placeholder={t.bodyTextPlaceholder}
              onInput={(e) => update(i, { text: (e.target as HTMLInputElement).value })}
            />
            <input type="file" accept="image/*" onChange={(e) => uploadImage(i, (e.target as HTMLInputElement).files?.[0])} />
            {busy === entry.id && <span class="hint">{t.readingHint}</span>}
            <div class="entry-tile-actions">
              {entry.front.image && <button onClick={() => update(i, { image: undefined })}>{t.clearImage}</button>}
              <button onClick={() => remove(i)}>{t.remove}</button>
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setShowNewCard(true)}>{t.addCard}</button>
      {showNewCard && (
        <NewCardModal
          onCreate={(entry) => {
            onChange([...entries, entry]);
            setShowNewCard(false);
          }}
          onCancel={() => setShowNewCard(false)}
        />
      )}
    </div>
  );
}

function PieceSetsEditor({ pieceSets, onChange }: { pieceSets: PieceSet[]; onChange: (p: PieceSet[]) => void }) {
  const t = T.pieceSets;

  function addSet() {
    onChange([...pieceSets, { key: `pieces${pieceSets.length + 1}`, entries: [] }]);
  }
  function updateSet(i: number, patch: Partial<PieceSet>) {
    onChange(pieceSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSet(i: number) {
    onChange(pieceSets.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      {pieceSets.map((set, i) => (
        <div class="editor-subsection" key={i}>
          <div class="editor-row">
            <input class="key-input" value={set.key} placeholder={t.keyPlaceholder} onInput={(e) => updateSet(i, { key: (e.target as HTMLInputElement).value })} />
            <button onClick={() => removeSet(i)}>{t.removeSet}</button>
          </div>
          <PieceEntriesEditor entries={set.entries} onChange={(entries) => updateSet(i, { entries })} />
        </div>
      ))}
      <button onClick={addSet}>{t.addSet}</button>
    </Section>
  );
}

/** The "+ Add piece" modal — same idea as NewCardModal above, for a piece's fields
 * (symbol/image, connectors) instead of a card's. */
function NewPieceModal({ onCreate, onCancel }: { onCreate: (entry: PieceEntry) => void; onCancel: () => void }) {
  const t = T.pieceEntries;
  const [symbol, setSymbol] = useState(t.newPieceDefaultSymbol);
  const [image, setImage] = useState<string | undefined>(undefined);
  const [connectorsText, setConnectorsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadImage(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setImage(await readImageAsDataUrl(file));
      setSymbol("");
    } catch (err) {
      setError(err instanceof Error ? err.message : T.readImageFailedFallback);
    } finally {
      setBusy(false);
    }
  }

  function create() {
    const connectors = connectorsText.split(",").map((s) => s.trim()).filter(Boolean);
    onCreate({
      id: freshId("piece"),
      symbol: image ? undefined : symbol || t.newPieceDefaultSymbol,
      image,
      connectors: connectors.length ? connectors : undefined,
    });
  }

  return (
    <Modal title={t.modalTitle} onClose={onCancel}>
      <label>
        {t.modalSymbolLabel}
        <input
          value={symbol}
          placeholder={t.symbolPlaceholder}
          maxLength={4}
          onInput={(e) => {
            setSymbol((e.target as HTMLInputElement).value);
            setImage(undefined);
          }}
          autofocus
        />
      </label>
      <label>
        {t.modalImageLabel}
        <input type="file" accept="image/*" onChange={(e) => uploadImage((e.target as HTMLInputElement).files?.[0])} />
      </label>
      <label>
        {t.modalConnectorsLabel}
        <input value={connectorsText} placeholder={t.connectorsPlaceholder} onInput={(e) => setConnectorsText((e.target as HTMLInputElement).value)} />
      </label>
      {busy && <span class="hint">{t.readingHint}</span>}
      {error && <p class="error">{error}</p>}
      <div class="modal-actions">
        <button onClick={onCancel}>{T.cancel}</button>
        <button onClick={create}>{t.createButton}</button>
      </div>
    </Modal>
  );
}

function PieceEntriesEditor({ entries, onChange }: { entries: PieceEntry[]; onChange: (e: PieceEntry[]) => void }) {
  const t = T.pieceEntries;
  const [busy, setBusy] = useState<string | null>(null);
  const [showNewPiece, setShowNewPiece] = useState(false);

  function update(i: number, patch: Partial<PieceEntry>) {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  function remove(i: number) {
    onChange(entries.filter((_, idx) => idx !== i));
  }
  async function uploadImage(i: number, file: File | undefined) {
    if (!file) return;
    setBusy(entries[i].id);
    try {
      update(i, { image: await readImageAsDataUrl(file), symbol: undefined });
    } catch (err) {
      alert(err instanceof Error ? err.message : T.readImageFailedFallback);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div class="entry-grid">
        {entries.map((entry, i) => (
          <div class="entry-tile" key={entry.id}>
            {entry.image ? (
              <img class="entry-tile-preview piece-preview" src={entry.image} alt="" />
            ) : (
              <div class="entry-tile-preview piece-preview entry-tile-preview-symbol">{entry.symbol}</div>
            )}
            <input
              value={entry.symbol ?? ""}
              placeholder={t.symbolPlaceholder}
              maxLength={4}
              onInput={(e) => update(i, { symbol: (e.target as HTMLInputElement).value || undefined, image: (e.target as HTMLInputElement).value ? undefined : entry.image })}
            />
            <input type="file" accept="image/*" onChange={(e) => uploadImage(i, (e.target as HTMLInputElement).files?.[0])} />
            <input
              value={entry.connectors?.join(",") ?? ""}
              placeholder={t.connectorsPlaceholder}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                const connectors = v.split(",").map((s) => s.trim()).filter(Boolean);
                update(i, { connectors: connectors.length ? connectors : undefined });
              }}
            />
            {busy === entry.id && <span class="hint">{t.readingHint}</span>}
            <div class="entry-tile-actions">
              <button onClick={() => remove(i)}>{t.remove}</button>
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setShowNewPiece(true)}>{t.addPiece}</button>
      {showNewPiece && (
        <NewPieceModal
          onCreate={(entry) => {
            onChange([...entries, entry]);
            setShowNewPiece(false);
          }}
          onCancel={() => setShowNewPiece(false)}
        />
      )}
    </div>
  );
}

function MacrosEditor({ macros, onChange }: { macros: MacroDef[]; onChange: (m: MacroDef[]) => void }) {
  const t = T.macros;

  function add() {
    onChange([...macros, { label: t.newMacroDefaultLabel, roll: t.newMacroDefaultRoll }]);
  }
  function update(i: number, patch: Partial<MacroDef>) {
    onChange(macros.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function remove(i: number) {
    onChange(macros.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      {macros.map((m, i) => (
        <div class="editor-row" key={i}>
          <input value={m.label} placeholder={t.labelPlaceholder} onInput={(e) => update(i, { label: (e.target as HTMLInputElement).value })} />
          <input value={m.roll} placeholder={t.rollPlaceholder} onInput={(e) => update(i, { roll: (e.target as HTMLInputElement).value })} />
          <button onClick={() => remove(i)}>{t.remove}</button>
        </div>
      ))}
      <button onClick={add}>{t.addMacro}</button>
    </Section>
  );
}
