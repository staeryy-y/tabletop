import { useEffect, useRef, useState } from "preact/hooks";
import {
  CardEntry,
  CardSet,
  DiceDef,
  GamePackage,
  MacroDef,
  MatEntry,
  MatSet,
  PieceEntry,
  PieceSet,
  TrackDef,
  validatePackage,
} from "../packages/gamePackage";
import { readImageAsDataUrl } from "../packages/imageUpload";
import { defaultCardSetPosition, defaultMatSetPosition, defaultPieceSetPosition } from "../packages/startingLayout";
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

/** One tab per element, plus a final "Layout" tab for arranging every card/piece/mat
 * set's spawn position in one place — the explicit, long-standing request this
 * replaces the old single continuously-scrolling editor with (docs/DECISIONS.md D27).
 * Kept as a plain union + array (not, say, a routed sub-page) since a package is
 * edited as one in-memory `pkg` value regardless of which tab is showing — switching
 * tabs never loses unsaved changes to another one. */
type TabKey = "tracks" | "dice" | "cards" | "pieces" | "mats" | "macros" | "layout";

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
  const [activeTab, setActiveTab] = useState<TabKey>("cards");
  const errors = validatePackage(pkg);

  function update(patch: Partial<GamePackage>) {
    setPkg((p) => ({ ...p, ...patch }));
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "tracks", label: T.tabs.tracks },
    { key: "dice", label: T.tabs.dice },
    { key: "cards", label: T.tabs.cards },
    { key: "pieces", label: T.tabs.pieces },
    { key: "mats", label: T.tabs.mats },
    { key: "macros", label: T.tabs.macros },
    { key: "layout", label: T.tabs.layout },
  ];

  return (
    <div class="editor">
      <label>
        {T.packageNameLabel}
        <input value={pkg.name} onInput={(e) => update({ name: (e.target as HTMLInputElement).value })} />
      </label>

      <div class="editor-tabs" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.key} type="button" role="tab" aria-selected={activeTab === tab.key} class={"editor-tab" + (activeTab === tab.key ? " active" : "")} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "tracks" && <TracksEditor tracks={pkg.tracks} dice={pkg.dice} onChange={(tracks) => update({ tracks })} />}
      {activeTab === "dice" && <DiceEditor dice={pkg.dice} onChange={(dice) => update({ dice })} />}
      {activeTab === "cards" && <CardSetsEditor cardSets={pkg.cardSets} onChange={(cardSets) => update({ cardSets })} />}
      {activeTab === "pieces" && <PieceSetsEditor pieceSets={pkg.pieceSets} onChange={(pieceSets) => update({ pieceSets })} />}
      {activeTab === "mats" && <MatSetsEditor matSets={pkg.matSets} onChange={(matSets) => update({ matSets })} />}
      {activeTab === "macros" && <MacrosEditor macros={pkg.macros} onChange={(macros) => update({ macros })} />}
      {activeTab === "layout" && (
        <LayoutTab
          cardSets={pkg.cardSets}
          pieceSets={pkg.pieceSets}
          matSets={pkg.matSets}
          onMoveCardSet={(i, patch) => update({ cardSets: pkg.cardSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) })}
          onMovePieceSet={(i, patch) => update({ pieceSets: pkg.pieceSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) })}
          onMoveMatSet={(i, patch) => update({ matSets: pkg.matSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) })}
        />
      )}

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

/** Coordinates map onto the same world-coordinate range engine/table.ts actually spawns
 * things in; a set that's never been dragged shows at the same auto-spread position
 * the runtime would use for it (startingLayout.ts), so this preview and the real room
 * always agree. */
const LAYOUT_WORLD_WIDTH = 900;
const LAYOUT_WORLD_HEIGHT = 640;

/** One draggable token in the Layout tab's shared preview canvas — one per card set,
 * piece set, or mat set (never per individual card/piece/mat: a set's *entries* fan
 * out from wherever its one token ends up, per packages/startingLayout.ts's own
 * per-family offset math). `key` is globally unique across all three families so it
 * can be used directly as this token's identity while dragging. */
interface LayoutToken {
  key: string;
  label: string;
  kind: "card" | "piece" | "mat";
  x: number;
  y: number;
  onMove: (x: number, y: number) => void;
}

/** A single shared draggable map of where every card/piece/mat set starts when the
 * room first starts — the explicit "the tab where you order all the pieces" request,
 * replacing the old per-tab preview embedded only in the card-sets editor (which had
 * no way to position piece/mat sets visually at all). Dragging a token only ever moves
 * *that set's* anchor point (CardSet/PieceSet/MatSet's own startX/startY) — see
 * LayoutToken's own doc comment for why a whole set, not each individual entry, is
 * what's draggable here. */
function LayoutTab({
  cardSets,
  pieceSets,
  matSets,
  onMoveCardSet,
  onMovePieceSet,
  onMoveMatSet,
}: {
  cardSets: CardSet[];
  pieceSets: PieceSet[];
  matSets: MatSet[];
  onMoveCardSet: (i: number, patch: Partial<CardSet>) => void;
  onMovePieceSet: (i: number, patch: Partial<PieceSet>) => void;
  onMoveMatSet: (i: number, patch: Partial<MatSet>) => void;
}) {
  const t = T.layoutTab;
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const tokens: LayoutToken[] = [
    ...cardSets.map((set, i): LayoutToken => {
      const fallback = defaultCardSetPosition(i, cardSets.length);
      return {
        key: `card:${set.key}`,
        label: set.label || set.key,
        kind: "card",
        x: set.startX ?? fallback.x,
        y: set.startY ?? fallback.y,
        onMove: (x, y) => onMoveCardSet(i, { startX: x, startY: y }),
      };
    }),
    ...pieceSets.map((set, i): LayoutToken => {
      const fallback = defaultPieceSetPosition(i, pieceSets.length);
      return {
        key: `piece:${set.key}`,
        label: set.key,
        kind: "piece",
        x: set.startX ?? fallback.x,
        y: set.startY ?? fallback.y,
        onMove: (x, y) => onMovePieceSet(i, { startX: x, startY: y }),
      };
    }),
    ...matSets.map((set, i): LayoutToken => {
      const fallback = defaultMatSetPosition(i, matSets.length);
      return {
        key: `mat:${set.key}`,
        label: set.key,
        kind: "mat",
        x: set.startX ?? fallback.x,
        y: set.startY ?? fallback.y,
        onMove: (x, y) => onMoveMatSet(i, { startX: x, startY: y }),
      };
    }),
  ];

  function moveTo(key: string, clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const relY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const token = tokens.find((tk) => tk.key === key);
    token?.onMove(Math.round(relX * LAYOUT_WORLD_WIDTH - LAYOUT_WORLD_WIDTH / 2), Math.round(relY * LAYOUT_WORLD_HEIGHT - LAYOUT_WORLD_HEIGHT / 2));
  }

  return (
    <Section title={t.sectionTitle}>
      {tokens.length === 0 ? (
        <p class="hint">{t.emptyHint}</p>
      ) : (
        <>
          <p class="hint">{t.hint}</p>
          <div
            class="layout-preview"
            ref={containerRef}
            onPointerMove={(e) => dragging !== null && moveTo(dragging, e.clientX, e.clientY)}
            onPointerUp={() => setDragging(null)}
            onPointerLeave={() => setDragging(null)}
          >
            {tokens.map((token) => {
              const left = ((token.x + LAYOUT_WORLD_WIDTH / 2) / LAYOUT_WORLD_WIDTH) * 100;
              const top = ((token.y + LAYOUT_WORLD_HEIGHT / 2) / LAYOUT_WORLD_HEIGHT) * 100;
              return (
                <div
                  key={token.key}
                  class={`layout-preview-token layout-preview-token-${token.kind}`}
                  style={{ left: `${left}%`, top: `${top}%` }}
                  onPointerDown={(e) => {
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    setDragging(token.key);
                  }}
                >
                  {token.label}
                </div>
              );
            })}
          </div>
          <ul class="layout-legend">
            <li>
              <span class="layout-legend-swatch layout-legend-swatch-card" /> {t.cardsLegend}
            </li>
            <li>
              <span class="layout-legend-swatch layout-legend-swatch-piece" /> {t.piecesLegend}
            </li>
            <li>
              <span class="layout-legend-swatch layout-legend-swatch-mat" /> {t.matsLegend}
            </li>
          </ul>
        </>
      )}
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

function MatSetsEditor({ matSets, onChange }: { matSets: MatSet[]; onChange: (m: MatSet[]) => void }) {
  const t = T.matSets;

  function addSet() {
    onChange([...matSets, { key: `mats${matSets.length + 1}`, entries: [] }]);
  }
  function updateSet(i: number, patch: Partial<MatSet>) {
    onChange(matSets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSet(i: number) {
    onChange(matSets.filter((_, idx) => idx !== i));
  }

  return (
    <Section title={t.sectionTitle}>
      {matSets.map((set, i) => (
        <div class="editor-subsection" key={i}>
          <div class="editor-row">
            <input class="key-input" value={set.key} placeholder={t.keyPlaceholder} onInput={(e) => updateSet(i, { key: (e.target as HTMLInputElement).value })} />
            <button onClick={() => removeSet(i)}>{t.removeSet}</button>
          </div>
          <MatEntriesEditor entries={set.entries} onChange={(entries) => updateSet(i, { entries })} />
        </div>
      ))}
      <button onClick={addSet}>{t.addSet}</button>
    </Section>
  );
}

/** The "+ Add mat" modal — same idea as NewPieceModal above, plus a "starts locked"
 * checkbox (docs/DECISIONS.md D26). */
function NewMatModal({ onCreate, onCancel }: { onCreate: (entry: MatEntry) => void; onCancel: () => void }) {
  const t = T.matEntries;
  const [symbol, setSymbol] = useState(t.newMatDefaultSymbol);
  const [image, setImage] = useState<string | undefined>(undefined);
  const [locked, setLocked] = useState(false);
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
    onCreate({ id: freshId("mat"), symbol: image ? undefined : symbol || t.newMatDefaultSymbol, image, locked: locked || undefined });
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
      <label class="checkbox">
        <input type="checkbox" checked={locked} onChange={(e) => setLocked((e.target as HTMLInputElement).checked)} />
        {t.startsLockedLabel}
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

function MatEntriesEditor({ entries, onChange }: { entries: MatEntry[]; onChange: (e: MatEntry[]) => void }) {
  const t = T.matEntries;
  const [busy, setBusy] = useState<string | null>(null);
  const [showNewMat, setShowNewMat] = useState(false);

  function update(i: number, patch: Partial<MatEntry>) {
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
            <label class="checkbox">
              <input type="checkbox" checked={entry.locked ?? false} onChange={(e) => update(i, { locked: (e.target as HTMLInputElement).checked || undefined })} />
              {t.startsLockedLabel}
            </label>
            {busy === entry.id && <span class="hint">{t.readingHint}</span>}
            <div class="entry-tile-actions">
              <button onClick={() => remove(i)}>{t.remove}</button>
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setShowNewMat(true)}>{t.addMat}</button>
      {showNewMat && (
        <NewMatModal
          onCreate={(entry) => {
            onChange([...entries, entry]);
            setShowNewMat(false);
          }}
          onCancel={() => setShowNewMat(false)}
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
