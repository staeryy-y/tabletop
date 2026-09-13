import { useEffect, useRef, useState } from "preact/hooks";
import { CardDef } from "../engine/card";
import { TableApp } from "../engine/table";
import { Peer, SignalingConnection } from "../net/signaling";
import { loadRoomToken } from "../roomToken";

// A tiny built-in demo deck, purely to prove out Card/Stack/Hide interaction (M3) —
// not a real game definition. Loading an actual game package (docs/GAME_DEFINITION.md)
// is M4/M5 and isn't wired up yet.
const DEMO_DECK: CardDef[] = ["A", "B", "C", "D", "E", "F"].map((letter, i) => ({
  id: `demo-${letter}`,
  front: { title: `Card ${letter}`, color: [0xf4d35e, 0xee964b, 0xf95738, 0x0d3b66, 0x3fa796, 0x9381ff][i], text: "Demo content" },
  back: { title: "", color: 0x333333 },
}));

export function RoomTable({ slug }: { slug: string }) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableApp | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [gmId, setGmId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState(slug);
  const [connError, setConnError] = useState<string | null>(null);

  useEffect(() => {
    const token = loadRoomToken(slug);
    if (!token) {
      location.hash = `#/join/${slug}`;
      return;
    }

    let table: TableApp | null = null;
    let disposed = false;

    (async () => {
      table = new TableApp();
      if (canvasHost.current) await table.init(canvasHost.current);
      if (disposed) {
        return;
      }
      tableRef.current = table;
      // A small starting hand so the table isn't empty on first load.
      DEMO_DECK.forEach((def, i) => table!.spawnCard(def, (i - 2.5) * 70, 150));
    })();

    const conn = new SignalingConnection(slug, token.token);
    const unsubscribe = conn.on((event) => {
      if (event.type === "welcome") {
        setSelfId(event.peerId);
        setHostId(event.hostPeerId);
        setGmId(event.gmPeerId);
        setRoomName(event.roomInfo.name);
        setPeers((prev) => [...prev, { peerId: event.peerId, name: token.displayName, isGM: event.gmPeerId === event.peerId }]);
      } else if (event.type === "peer-joined") {
        setPeers((prev) => [...prev, { peerId: event.peerId, name: event.name, isGM: event.isGM }]);
      } else if (event.type === "peer-left") {
        setPeers((prev) => prev.filter((p) => p.peerId !== event.peerId));
      } else if (event.type === "host-changed") {
        setHostId(event.hostPeerId);
      } else if (event.type === "you-are-host") {
        setHostId(selfId);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
      conn.close();
      table?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function spawnRandomCard() {
    // Stand-in for GM "spawn" (docs/ARCHITECTURE.md "Roles: GM vs. players") until the
    // object model is actually synced (M6) and gated by GM attestation.
    const def = DEMO_DECK[Math.floor(Math.random() * DEMO_DECK.length)];
    tableRef.current?.spawnCard(def, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 200);
  }

  return (
    <div class="room-page">
      <aside class="sidebar">
        <h2>{roomName}</h2>
        <p class="hint">
          <a href="#/">&larr; dashboard</a>
        </p>
        <h3>Presence</h3>
        <ul class="peer-list">
          {peers.map((p) => (
            <li key={p.peerId}>
              {p.name}
              {p.peerId === selfId && " (you)"}
              {p.peerId === hostId && " • host"}
              {p.peerId === gmId && " • GM"}
            </li>
          ))}
          {peers.length === 0 && <li class="hint">Connecting…</li>}
        </ul>
        {connError && <p class="error">{connError}</p>}
        <p class="hint">
          Right-click a card: flip, hide, rotate, or (once stacked) shuffle/draw. Drag one card onto
          another to stack them.
        </p>
        <p class="hint">
          Not yet wired up: syncing this table to other browsers over WebRTC (M6 in the plan) — right
          now each tab's table is local to itself.
        </p>
      </aside>
      <div class="table-toolbar">
        <button onClick={spawnRandomCard}>+ Spawn card</button>
      </div>
      <div class="table-canvas" ref={canvasHost} />
    </div>
  );
}
