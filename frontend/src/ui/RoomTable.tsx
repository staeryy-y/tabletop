import { useEffect, useRef, useState } from "preact/hooks";
import { CardDef } from "../engine/card";
import { TableSnapshot } from "../engine/pileModel";
import { PieceDef } from "../engine/piece";
import { TableApp } from "../engine/table";
import { ChatDistributor, ChatMessage } from "../net/chatSync";
import { PackageDistributor } from "../net/packageTransfer";
import { RoomConnection } from "../net/roomConnection";
import { Peer, SignalingConnection } from "../net/signaling";
import { TableStore } from "../net/tableStore";
import { createEmptyPackage, GamePackage } from "../packages/gamePackage";
import { fetchBundledPackage } from "../packages/gameDefinitionLoader";
import { PackageStore } from "../packages/packageStore";
import { defaultCardSetPosition, defaultPieceSetPosition, pieceEntryOffset } from "../packages/startingLayout";
import { loadRoomToken } from "../roomToken";
import { getRememberedRoomPackageId } from "../roomPackageChoice";
import { Chat } from "./Chat";

/** How often the host persists its table state — locally (IndexedDB, net/tableStore.ts,
 * so *this browser* reopening the room resumes instantly with no server round trip at
 * all — this is what actually fixes a host refreshing their own tab) and to the
 * signaling server (docs/NETWORKING.md "Host migration" — for the different case local
 * storage can't cover: a *different* peer being promoted to host after this one is gone
 * for good). Cheap either way: a no-op unless this client currently is host. */
const SNAPSHOT_PERSIST_INTERVAL_MS = 5000;

// A tiny built-in demo deck, shown only when the room's package has no card sets of its
// own — proves out Card/Stack/Hide interaction (M3) even for a bare freeform room.
const DEMO_DECK: CardDef[] = ["A", "B", "C", "D", "E", "F"].map((letter, i) => ({
  id: `demo-${letter}`,
  front: { title: `Card ${letter}`, color: [0xf4d35e, 0xee964b, 0xf95738, 0x0d3b66, 0x3fa796, 0x9381ff][i], text: "Demo content" },
  back: { title: "", color: 0x333333 },
}));

const FALLBACK_CARD_COLOR = 0x556070;
const COLOR_SWATCHES = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45"];

/** One card set's worth of spawn info: what to show on each card (engine/card.ts's
 * CardDef shape — `color` is always filled in even for an image-based face, since
 * that's what shows during the brief window before the image itself decodes) and where
 * its stack starts. Kept per-set (not flattened) so it can spawn as one stack
 * (TableModel.spawnStack) rather than N separate piles — see CardSet.label/startX/startY's
 * own doc comments in packages/gamePackage.ts. */
interface CardSetSpawn {
  label: string;
  startX: number;
  startY: number;
  defs: CardDef[];
}

function cardSetSpawnsFromPackage(pkg: GamePackage): CardSetSpawn[] {
  return pkg.cardSets.map((set, i) => {
    const fallback = defaultCardSetPosition(i, pkg.cardSets.length);
    return {
      label: set.label ?? set.key,
      startX: set.startX ?? fallback.x,
      startY: set.startY ?? fallback.y,
      defs: set.entries.map((entry) => ({
        id: `${set.key}:${entry.id}`,
        front: { title: entry.front.title, text: entry.front.text, color: entry.front.color ?? FALLBACK_CARD_COLOR, image: entry.front.image },
        back: { title: set.back?.title ?? "", color: set.back?.color ?? 0x333333, image: set.back?.image },
      })),
    };
  });
}

/** One individual piece's worth of spawn info — unlike a card set, a piece set never
 * spawns as a single combined object (see docs/GAME_DEFINITION.md "Pieces": pieces
 * never merge into a stack), so this is flattened to one entry per piece, each with its
 * own position, rather than kept per-set the way CardSetSpawn is. */
interface PieceSpawn {
  def: PieceDef;
  x: number;
  y: number;
}

function pieceSetSpawnsFromPackage(pkg: GamePackage): PieceSpawn[] {
  const spawns: PieceSpawn[] = [];
  pkg.pieceSets.forEach((set, i) => {
    const fallback = defaultPieceSetPosition(i, pkg.pieceSets.length);
    const anchorX = set.startX ?? fallback.x;
    const anchorY = set.startY ?? fallback.y;
    set.entries.forEach((entry, j) => {
      const offset = pieceEntryOffset(j);
      spawns.push({ def: { id: `${set.key}:${entry.id}`, image: entry.image, symbol: entry.symbol }, x: anchorX + offset.x, y: anchorY + offset.y });
    });
  });
  return spawns;
}

const packageStore = new PackageStore();
const tableStore = new TableStore();

export function RoomTable({ slug }: { slug: string }) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const tableRef = useRef<TableApp | null>(null);
  const connRef = useRef<SignalingConnection | null>(null);
  const roomConnRef = useRef<RoomConnection | null>(null);
  // Every other peer currently known to be in the room (self excluded) — kept up to
  // date by peer-joined/peer-left so that whenever *this* client is told to become
  // host (welcome as the very first joiner, or a later host-changed/you-are-host
  // migration), it knows who to open links to without waiting on another round trip.
  const otherPeerIdsRef = useRef<Set<string>>(new Set());
  const loadedPkgRef = useRef<GamePackage | null>(null);
  const seededRef = useRef({ pkg: false });
  // The room's game_def_ref (see app/rooms.py), remembered from `welcome` so later
  // events (host-changed) know whether a package transfer is even relevant — only a
  // "custom" room's package needs P2P transfer at all (see packageDistributorRef).
  const gameDefRefRef = useRef<string | null>(null);
  // D19: an anonymous room's server-side state is never persisted at all, so uploading
  // a recovery snapshot to it would just be wasted traffic — see persistSnapshotIfHost.
  const isAnonymousRoomRef = useRef(false);
  const packageDistributorRef = useRef<PackageDistributor | null>(null);
  const chatDistributorRef = useRef<ChatDistributor | null>(null);
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map());
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [gmId, setGmId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState(slug);
  const [pkg, setPkg] = useState<GamePackage | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);

  useEffect(() => {
    const token = loadRoomToken(slug);
    if (!token) {
      location.hash = `#/join/${slug}`;
      return;
    }
    setDisplayName(token.displayName);

    let disposed = false;

    // Built synchronously (its object model exists immediately; only rendering to a
    // real canvas is async) so it — and net/roomConnection.ts's link to it — are ready
    // no matter how the WS's first few messages race against PixiJS's own init().
    const table = new TableApp();
    tableRef.current = table;
    (async () => {
      if (canvasHost.current) await table.init(canvasHost.current);
    })();

    // Spawn the starting content exactly once, and only on the client that turns out
    // to be host — see the field comments on seededRef/loadedPkgRef. Every other peer
    // gets the same cards via the host's snapshot/broadcasts instead of spawning its
    // own (independent, diverging) copies.
    //
    // This is one decision, not two: it used to unconditionally seed the demo deck the
    // moment this client became host (package loading is async and usually hasn't
    // resolved yet at that point), then separately seed the package's own cards once
    // it *did* load — so a room with a real package still got the demo deck first,
    // permanently, since nothing ever removed it. seedStarterContentIfHost only fires
    // once the package is actually known, and picks exactly one of the two.
    function seedStarterContentIfHost(loaded: GamePackage): void {
      if (seededRef.current.pkg || !roomConnRef.current?.isHost) return;
      seededRef.current.pkg = true;
      const cardSpawns = cardSetSpawnsFromPackage(loaded);
      const pieceSpawns = pieceSetSpawnsFromPackage(loaded);
      if (cardSpawns.length === 0 && pieceSpawns.length === 0) {
        DEMO_DECK.forEach((def, i) => table.spawnCard(def, (i - 2.5) * 70, 150));
        return;
      }
      // Each card set spawns as one already-stacked pile (e.g. "a stack of all the
      // role cards" — not N separate individual piles), at the position the package
      // author configured (or the same auto-spread default this project always used,
      // if they never touched it — see startingLayout.ts).
      for (const spawn of cardSpawns) {
        table.spawnStack(spawn.defs, spawn.startX, spawn.startY);
      }
      // Pieces never merge into a stack (docs/GAME_DEFINITION.md "Pieces"), so each one
      // spawns as its own standalone object rather than grouped like a card set.
      for (const spawn of pieceSpawns) {
        table.spawnPiece(spawn.def, spawn.x, spawn.y);
      }
    }

    const conn = new SignalingConnection(slug, token.token);
    connRef.current = conn;
    let mySelfId: string | null = null;

    function persistSnapshotIfHost(): void {
      if (!roomConnRef.current?.isHost) return;
      const snapshot = roomConnRef.current.currentSnapshot();
      // The server-side upload only matters for a *different* peer being promoted to
      // host later — an anonymous room's server state is never persisted at all
      // (D19), so there'd be nothing for that upload to accomplish. The local
      // IndexedDB save below always happens regardless — that's not a "server
      // upload," it's this browser remembering its own table.
      if (!isAnonymousRoomRef.current) conn.send({ type: "snapshot", blob: snapshot });
      void tableStore.save(slug, snapshot.piles, snapshot.pieces);
    }
    const snapshotInterval = setInterval(persistSnapshotIfHost, SNAPSHOT_PERSIST_INTERVAL_MS);
    // Best-effort: also flush immediately when the tab is about to go away (reload,
    // close, navigate elsewhere) rather than only relying on the periodic interval —
    // otherwise reloading right after a move could lose up to
    // SNAPSHOT_PERSIST_INTERVAL_MS worth of the most recent state. `pagehide` fires
    // more reliably than `beforeunload` across mobile/bfcache cases; the IndexedDB
    // write and the WS send are both fire-and-forget here, same as the interval above.
    window.addEventListener("pagehide", persistSnapshotIfHost);

    const unsubscribe = conn.on((event) => {
      if (event.type === "welcome") {
        mySelfId = event.peerId;
        setSelfId(event.peerId);
        setHostId(event.hostPeerId);
        setGmId(event.gmPeerId);
        setRoomName(event.roomInfo.name);
        table.setSelfPeerId(event.peerId);
        for (const p of event.peers) otherPeerIdsRef.current.add(p.peerId);
        setPeers((prev) => {
          const next = new Map(prev);
          for (const p of event.peers) next.set(p.peerId, p);
          // Our own presence isn't in `peers` (that list is "everyone else") — the
          // server doesn't echo it back on welcome, so seed a placeholder now;
          // set-presence / a later presence-changed will fill in real values.
          next.set(event.peerId, { peerId: event.peerId, name: token.displayName, isGM: event.gmPeerId === event.peerId, color: "#888888", eyesClosed: false });
          return next;
        });

        // net/roomConnection.ts orchestrates the actual P2P links; TableApp only ever
        // sees the resulting TableSyncClient/TableView interfaces (engine/table.ts).
        // Becoming host specifically waits for the `you-are-host` message below rather
        // than inferring it from hostPeerId === peerId here, since that's the message
        // that actually carries the resume snapshot.
        const roomConn = new RoomConnection(table.getModel(), table, conn, event.peerId);
        roomConnRef.current = roomConn;
        isAnonymousRoomRef.current = event.roomInfo.isAnonymous;

        // A custom package's actual content only ever exists in whichever browser(s)
        // hold it — the server never stores it (docs/DECISIONS.md D14) — so any peer
        // that isn't the one who picked it needs to fetch it from the host over the
        // same links roomConn just set up (net/packageTransfer.ts). A bundled package
        // needs none of this: every peer fetches the identical static file itself.
        const gameDefRef = event.roomInfo.gameDefRef;
        gameDefRefRef.current = gameDefRef;
        const distributor = new PackageDistributor(roomConn, (received) => {
          if (disposed) return;
          setPkg(received);
          loadedPkgRef.current = received;
          seedStarterContentIfHost(received);
        });
        packageDistributorRef.current = distributor;

        // Chat rides the same side-channel mechanism (net/chatSync.ts) — unlike the
        // package, every room type needs this, not just "custom" ones.
        const chatDistributor = new ChatDistributor(roomConn, (message) => {
          if (disposed) return;
          setChatMessages((prev) => [...prev, message]);
        });
        chatDistributorRef.current = chatDistributor;

        if (event.hostPeerId !== null && event.hostPeerId !== event.peerId) {
          table.setSyncClient(roomConn.becomePeerOf(event.hostPeerId));
          if (gameDefRef === "custom") distributor.requestFromHostIfNeeded();
          chatDistributor.requestHistoryIfNeeded();
        }

        (async () => {
          if (gameDefRef.startsWith("bundled:")) {
            try {
              const loaded = await fetchBundledPackage(gameDefRef.slice("bundled:".length));
              if (disposed) return;
              setPkg(loaded);
              loadedPkgRef.current = loaded;
              seedStarterContentIfHost(loaded);
            } catch (err) {
              console.error("failed to load game package", err);
            }
            return;
          }

          // Custom: this browser might be the one that originally picked it (see
          // roomPackageChoice.ts), in which case it already has everything and can
          // skip P2P entirely — feeding it to the distributor also means this client
          // is immediately ready to *serve* it, whether or not it's currently host
          // (see docs/ARCHITECTURE.md "Room lifecycle" step 4).
          const customId = getRememberedRoomPackageId(slug);
          const customPkg = customId ? (await packageStore.get(customId))?.pkg : undefined;
          if (disposed) return;
          if (customPkg) {
            distributor.setLocalPackage(customPkg);
            setPkg(customPkg);
            loadedPkgRef.current = customPkg;
            seedStarterContentIfHost(customPkg);
          } else if (loadedPkgRef.current === null) {
            // Show an honest placeholder rather than a blank table while the transfer
            // is in flight — distributor's onReceived callback above replaces it the
            // moment real content arrives. Guarded on loadedPkgRef so this can't
            // clobber a package that already arrived over the wire before this
            // (IndexedDB-bound) check even finished.
            const placeholder = createEmptyPackage("(waiting for game package from host…)");
            setPkg(placeholder);
          }
        })();
      } else if (event.type === "peer-joined") {
        otherPeerIdsRef.current.add(event.peerId);
        roomConnRef.current?.addPeer(event.peerId);
        setPeers((prev) => new Map(prev).set(event.peerId, event));
      } else if (event.type === "presence-changed") {
        setPeers((prev) => new Map(prev).set(event.peerId, event));
      } else if (event.type === "peer-left") {
        otherPeerIdsRef.current.delete(event.peerId);
        roomConnRef.current?.removePeer(event.peerId);
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(event.peerId);
          return next;
        });
      } else if (event.type === "host-changed") {
        setHostId(event.hostPeerId);
        if (event.hostPeerId !== mySelfId && roomConnRef.current) {
          table.setSyncClient(roomConnRef.current.becomePeerOf(event.hostPeerId));
          // Re-ask the new host in case the old one never got around to answering —
          // a no-op if this client already has the package (setLocalPackage was
          // already called, e.g. it's the one that picked it, or it received it
          // earlier from whoever was host before).
          if (gameDefRefRef.current === "custom") packageDistributorRef.current?.requestFromHostIfNeeded();
          chatDistributorRef.current?.requestHistoryIfNeeded();
        }
      } else if (event.type === "you-are-host") {
        setHostId(mySelfId);
        if (!roomConnRef.current) return; // welcome always arrives first — see above
        const serverSnapshot = (event.snapshot as TableSnapshot | null | undefined) ?? null;
        (async () => {
          // Prefer this browser's own local copy over whatever the server last saw:
          // it's guaranteed to be exactly what this tab itself last showed (no upload
          // race, no staleness window), and covers the common case the server-side
          // snapshot can't — the room going fully empty, or this being the very first
          // "you-are-host" this server process has ever handed out for it. Falls back
          // to the server's copy only when this browser has never held this room's
          // table before (a different peer being promoted, or a genuinely new room).
          const localSnapshot = await tableStore.load(slug);
          if (disposed || !roomConnRef.current) return;
          const snapshot = localSnapshot ?? serverSnapshot;
          if (snapshot !== null && (snapshot.piles.length > 0 || snapshot.pieces.length > 0)) {
            // Resuming real content (from local storage, or a genuine peer migration
            // that already had state) — never inject starter content on top of it.
            // seedStarterContentIfHost's own flag only ever protects against seeding
            // *twice*, not against seeding into an already-nonempty table, so
            // pre-marking it here is what actually prevents duplicated content on
            // every resume.
            seededRef.current.pkg = true;
          }
          const client = roomConnRef.current.becomeHostFromMigration(snapshot, [...otherPeerIdsRef.current]);
          table.setSyncClient(client);
          if (loadedPkgRef.current) seedStarterContentIfHost(loadedPkgRef.current);
        })();
      }
    });

    return () => {
      disposed = true;
      clearInterval(snapshotInterval);
      window.removeEventListener("pagehide", persistSnapshotIfHost);
      unsubscribe();
      conn.close();
      connRef.current = null;
      roomConnRef.current?.destroy();
      roomConnRef.current = null;
      packageDistributorRef.current = null;
      chatDistributorRef.current = null;
      table.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Keep the table's default player tokens (engine/seating.ts) in sync with presence.
  useEffect(() => {
    tableRef.current?.setPlayers([...peers.values()].map((p) => ({ peerId: p.peerId, name: p.name, color: p.color, eyesClosed: p.eyesClosed })));
  }, [peers]);

  const me = selfId ? peers.get(selfId) : undefined;
  const isHost = selfId !== null && selfId === hostId;

  function spawnRandomCard() {
    // Gated to the host in the UI (below) — still not to the GM specifically
    // (docs/ARCHITECTURE.md "Roles: GM vs. players"), which per D13 is normally the
    // same person anyway. The spawn itself is real either way: it goes through
    // TableApp's syncClient (net/roomConnection.ts) like every other action, so it
    // reaches every connected peer.
    const deck = pkg ? cardSetSpawnsFromPackage(pkg).flatMap((s) => s.defs) : [];
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

  function postChatMessage(message: ChatMessage) {
    chatDistributorRef.current?.post(message);
  }

  const [linkCopied, setLinkCopied] = useState(false);
  async function copyInviteLink() {
    const url = `${location.origin}${location.pathname}#/join/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (an insecure context, browser permissions) —
      // nothing else to fall back to here, so just leave the button's label unchanged.
    }
  }

  const eyesClosed = me?.eyesClosed ?? false;

  return (
    <div class="room-page">
      <div class="table-canvas" ref={canvasHost} />

      {/* Floating HUD, not a sidebar — see docs/IMPLEMENTATION_LOG.md's earlier note on
          why this replaced the old webapp-style layout. */}
      <div class="hud-players">
        <h2>{roomName}</h2>
        {pkg && <p class="hint hud-pkg-name">{pkg.name}</p>}
        <button class="hud-invite-button" onClick={copyInviteLink}>
          {linkCopied ? "Copied!" : "\u{1F517} Invite link"}
        </button>
        <ul class="peer-list">
          {[...peers.values()].map((p) => (
            <li key={p.peerId} class={p.eyesClosed ? "eyes-closed" : ""}>
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
      </div>

      {chatOpen && (
        <div class="hud-chat">
          <Chat pkg={pkg} displayName={displayName} messages={chatMessages} onPost={postChatMessage} />
        </div>
      )}

      {helpOpen && (
        <div class="hud-chat hud-help">
          <p>
            <strong>Right-click</strong> a card: flip, hide, rotate 90°, or (once stacked) shuffle/draw top.
          </p>
          <p>Drag the small handle above a card to rotate it freely. Drag one card onto another to stack them.</p>
          <p>
            <strong>Drag a box</strong> over empty table to select several cards, then move/rotate them together, or
            right-click the selection to flip/hide all of them or collapse them into a deck.
          </p>
          <p>
            Pieces (board tiles, standees) never stack — right-click one to rotate it 90° or remove it, or drag its
            own handle to rotate it freely.
          </p>
          <p>
            <strong>WASD</strong> pans the camera, <strong>Q/E</strong> rotates it — handy when players are seated
            on different sides of the table.
          </p>
          <p>
            Cards and pieces sync live with everyone in the room over a direct connection to the host (falling back
            to relaying through the server if a direct connection can't be established).
          </p>
        </div>
      )}

      <div class="hud-toolbar">
        <a href="#/" class="hud-icon-button" title="Back to dashboard">
          &larr;
        </a>
        {isHost && (
          <button onClick={spawnRandomCard} title="Spawn a random card">
            + Card
          </button>
        )}
        <button
          class={"hud-icon-button" + (eyesClosed ? " active" : "")}
          onClick={toggleEyesClosed}
          title={eyesClosed ? "Open your eyes" : "Close your eyes (for reveal moments, e.g. Avalon/Mafia)"}
        >
          {eyesClosed ? "\u{1F648}" : "\u{1F441}"}
        </button>
        <button
          class={"hud-icon-button" + (colorMenuOpen ? " active" : "")}
          onClick={() => {
            setColorMenuOpen((o) => !o);
            setChatOpen(false);
            setHelpOpen(false);
          }}
          title="Change your color"
        >
          <span class="hud-color-preview" style={{ background: me?.color ?? "#888888" }} />
        </button>
        <button
          class={"hud-icon-button" + (chatOpen ? " active" : "")}
          onClick={() => {
            setChatOpen((o) => !o);
            setHelpOpen(false);
            setColorMenuOpen(false);
          }}
        >
          {"\u{1F4AC}"} Chat
        </button>
        <button
          class={"hud-icon-button" + (helpOpen ? " active" : "")}
          onClick={() => {
            setHelpOpen((o) => !o);
            setChatOpen(false);
            setColorMenuOpen(false);
          }}
          title="How to play"
        >
          ?
        </button>
      </div>

      {colorMenuOpen && (
        <div class="hud-chat hud-color-menu">
          <div class="swatches">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c}
                class={"swatch" + (me?.color === c ? " selected" : "")}
                style={{ background: c }}
                onClick={() => {
                  pickColor(c);
                  setColorMenuOpen(false);
                }}
                aria-label={`use color ${c}`}
              />
            ))}
          </div>
        </div>
      )}

      {eyesClosed && (
        <div class="eyes-closed-overlay">
          <p>{"\u{1F648}"} Your eyes are closed.</p>
          <button onClick={toggleEyesClosed}>Open your eyes</button>
        </div>
      )}
    </div>
  );
}
