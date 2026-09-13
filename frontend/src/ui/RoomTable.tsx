import { useEffect, useRef, useState } from "preact/hooks";
import { CardDef } from "../engine/card";
import { TableApp } from "../engine/table";
import { Peer, SignalingConnection } from "../net/signaling";
import { GamePackage } from "../packages/gamePackage";
import { loadPackageForRoom } from "../packages/gameDefinitionLoader";
import { PackageStore } from "../packages/packageStore";
import { loadRoomToken } from "../roomToken";
import { getRememberedRoomPackageId } from "../roomPackageChoice";
import { Chat } from "./Chat";

// A tiny built-in demo deck, shown only when the room's package has no card sets of its
// own — proves out Card/Stack/Hide interaction (M3) even for a bare freeform room.
const DEMO_DECK: CardDef[] = ["A", "B", "C", "D", "E", "F"].map((letter, i) => ({
  id: `demo-${letter}`,
  front: { title: `Card ${letter}`, color: [0xf4d35e, 0xee964b, 0xf95738, 0x0d3b66, 0x3fa796, 0x9381ff][i], text: "Demo content" },
  back: { title: "", color: 0x333333 },
}));

const FALLBACK_CARD_COLOR = 0x556070;
const COLOR_SWATCHES = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45"];

/** Card sets from a loaded package, flattened to engine/card.ts's CardDef shape.
 * Note: an image front (a card built with an uploaded image in the editor) doesn't
 * render as an actual picture yet — the PixiJS renderer only draws color/text faces so
 * far (see engine/card.ts) — it falls back to a plain color so it's still visible and
 * playable rather than crashing; real image rendering on the canvas is a follow-up. */
function cardDefsFromPackage(pkg: GamePackage): CardDef[] {
  return pkg.cardSets.flatMap((set) =>
    set.entries.map((entry) => ({
      id: `${set.key}:${entry.id}`,
      front: { title: entry.front.title, text: entry.front.text, color: entry.front.color ?? FALLBACK_CARD_COLOR },
      back: { title: set.back?.title ?? "", color: set.back?.color ?? 0x333333 },
    })),
  );
}

const packageStore = new PackageStore();

export function RoomTable({ slug }: { slug: string }) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableApp | null>(null);
  const connRef = useRef<SignalingConnection | null>(null);
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map());
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [gmId, setGmId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState(slug);
  const [pkg, setPkg] = useState<GamePackage | null>(null);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    const token = loadRoomToken(slug);
    if (!token) {
      location.hash = `#/join/${slug}`;
      return;
    }
    setDisplayName(token.displayName);

    let table: TableApp | null = null;
    let disposed = false;

    (async () => {
      table = new TableApp();
      if (canvasHost.current) await table.init(canvasHost.current);
      if (disposed) {
        return;
      }
      tableRef.current = table;
      // A small starting hand so the table isn't empty before/without a package.
      DEMO_DECK.forEach((def, i) => table!.spawnCard(def, (i - 2.5) * 70, 150));
    })();

    const conn = new SignalingConnection(slug, token.token);
    connRef.current = conn;
    let mySelfId: string | null = null;

    const unsubscribe = conn.on((event) => {
      if (event.type === "welcome") {
        mySelfId = event.peerId;
        setSelfId(event.peerId);
        setHostId(event.hostPeerId);
        setGmId(event.gmPeerId);
        setRoomName(event.roomInfo.name);
        setPeers((prev) => {
          const next = new Map(prev);
          for (const p of event.peers) next.set(p.peerId, p);
          // Our own presence isn't in `peers` (that list is "everyone else") — the
          // server doesn't echo it back on welcome, so seed a placeholder now;
          // set-presence / a later presence-changed will fill in real values.
          next.set(event.peerId, { peerId: event.peerId, name: token.displayName, isGM: event.gmPeerId === event.peerId, color: "#888888", eyesClosed: false });
          return next;
        });

        // Load the room's game package (docs/GAME_DEFINITION.md) — bundled fetches a
        // static file; custom only resolves if *this* browser is the one that picked it
        // (see roomPackageChoice.ts — the server never stores which one, per
        // docs/DECISIONS.md D14). Any other peer sees the honest empty placeholder until
        // M6's P2P package transfer exists.
        (async () => {
          const ref = event.roomInfo.gameDefRef;
          const customId = ref === "custom" ? getRememberedRoomPackageId(slug) : null;
          const customPkg = customId ? (await packageStore.get(customId))?.pkg : undefined;
          try {
            const loaded = await loadPackageForRoom(ref, customPkg);
            if (disposed) return;
            setPkg(loaded);
            const cardDefs = cardDefsFromPackage(loaded);
            cardDefs.forEach((def, i) => tableRef.current?.spawnCard(def, (i - (cardDefs.length - 1) / 2) * 70, -150));
          } catch (err) {
            console.error("failed to load game package", err);
          }
        })();
      } else if (event.type === "peer-joined" || event.type === "presence-changed") {
        setPeers((prev) => new Map(prev).set(event.peerId, event));
      } else if (event.type === "peer-left") {
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(event.peerId);
          return next;
        });
      } else if (event.type === "host-changed") {
        setHostId(event.hostPeerId);
      } else if (event.type === "you-are-host") {
        setHostId(mySelfId);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
      conn.close();
      connRef.current = null;
      table?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Keep the table's default player tokens (engine/seating.ts) in sync with presence.
  useEffect(() => {
    tableRef.current?.setPlayers([...peers.values()].map((p) => ({ peerId: p.peerId, name: p.name, color: p.color })));
  }, [peers]);

  const me = selfId ? peers.get(selfId) : undefined;

  function spawnRandomCard() {
    // Stand-in for GM "spawn" (docs/ARCHITECTURE.md "Roles: GM vs. players") until the
    // object model is actually synced (M6) and gated by GM attestation.
    const deck = pkg ? cardDefsFromPackage(pkg) : [];
    const pool = deck.length > 0 ? deck : DEMO_DECK;
    const def = pool[Math.floor(Math.random() * pool.length)];
    tableRef.current?.spawnCard(def, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 200);
  }

  function toggleEyesClosed() {
    connRef.current?.setPresence({ eyesClosed: !me?.eyesClosed });
  }

  function pickColor(color: string) {
    connRef.current?.setPresence({ color });
  }

  return (
    <div class="room-page">
      <aside class="sidebar">
        <h2>{roomName}</h2>
        <p class="hint">
          <a href="#/">&larr; dashboard</a>
          {pkg && ` · ${pkg.name}`}
        </p>

        <h3>You</h3>
        <div class="my-presence">
          <button
            class={"eyes-toggle" + (me?.eyesClosed ? " closed" : "")}
            onClick={toggleEyesClosed}
            title={me?.eyesClosed ? "Open your eyes" : "Close your eyes (for reveal moments, e.g. Avalon/Mafia)"}
          >
            {me?.eyesClosed ? "\u{1F648} Eyes closed" : "\u{1F441} Eyes open"}
          </button>
          <div class="swatches">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                class={"swatch" + (me?.color === c ? " selected" : "")}
                style={{ background: c }}
                onClick={() => pickColor(c)}
                aria-label={`use color ${c}`}
              />
            ))}
          </div>
        </div>

        <h3>Presence</h3>
        <ul class="peer-list">
          {[...peers.values()].map((p) => (
            <li key={p.peerId}>
              <span class="peer-dot" style={{ background: p.color }} />
              {p.name}
              {p.peerId === selfId && " (you)"}
              {p.peerId === hostId && " • host"}
              {p.peerId === gmId && " • GM"}
              {p.eyesClosed && " • \u{1F648}"}
            </li>
          ))}
          {peers.size === 0 && <li class="hint">Connecting…</li>}
        </ul>

        <Chat pkg={pkg} displayName={displayName} />

        <p class="hint">
          Right-click a card: flip, hide, rotate 90°, or (once stacked) shuffle/draw. Drag the small
          handle above a card to rotate it freely. Drag one card onto another to stack them. WASD pans
          the camera, Q/E rotates it — handy when players are seated on different sides of the table.
        </p>
        <p class="hint">
          Not yet wired up: syncing this table to other browsers over WebRTC (M6 in the plan) — right
          now each tab's table (and chat) is local to itself; presence (who's here, colors,
          eyes-closed) is real and synced, but cards/tokens/chat are not yet.
        </p>
      </aside>
      <div class="table-toolbar">
        <button onClick={spawnRandomCard}>+ Spawn card</button>
      </div>
      <div class="table-canvas" ref={canvasHost} />
    </div>
  );
}
