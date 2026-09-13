import { beforeEach, describe, expect, it } from "vitest";
import { CardDef } from "../engine/card";
import { TableModel } from "../engine/pileModel";
import { PieceDef } from "../engine/piece";
import { PeerLink } from "./peerLink";
import { PeerLinkFactory, RoomConnection, TableView } from "./roomConnection";
import { TableEvent } from "./syncProtocol";

const DEF_A: CardDef = { id: "a", front: { title: "A", color: 1 }, back: { title: "", color: 9 } };
const PIECE_A: PieceDef = { id: "pa", symbol: "♟" };
const DEF_B: CardDef = { id: "b", front: { title: "B", color: 2 }, back: { title: "", color: 9 } };

/** An in-memory "network": lets two RoomConnections (playing the role of two real
 * peers/browsers) actually exchange messages through matching PeerLink instances,
 * without any real WebSocket/signaling involved — this is what makes it possible to
 * test the *orchestration* (who has a link to whom, what a new peer/migration does) as
 * a real multi-peer scenario, not just each RoomConnection in isolation. */
class TestNetwork {
  private channels = new Map<string, { handlers: Set<(msg: unknown) => void>; open: boolean }>();

  private key(from: string, to: string): string {
    return `${from}->${to}`;
  }

  linkFactory(selfPeerId: string): PeerLinkFactory {
    return (_signaling, remotePeerId): PeerLink => {
      const outKey = this.key(selfPeerId, remotePeerId);
      const inKey = this.key(remotePeerId, selfPeerId);
      this.channels.set(outKey, { handlers: new Set(), open: true });
      return {
        send: (message) => {
          const inbound = this.channels.get(inKey);
          if (inbound?.open) for (const h of inbound.handlers) h(message);
        },
        onMessage: (handler) => {
          const chan = this.channels.get(outKey)!;
          chan.handlers.add(handler);
          return () => chan.handlers.delete(handler);
        },
        close: () => {
          const chan = this.channels.get(outKey);
          if (chan) chan.open = false;
        },
      };
    };
  }
}

class RecordingView implements TableView {
  events: TableEvent[] = [];
  model = new TableModel();
  applyEvent(event: TableEvent): void {
    this.events.push(event);
    if (event.type === "pile-upserted") this.model.setPile(event.pile);
    else if (event.type === "pile-removed") this.model.removePile(event.pileId);
    else if (event.type === "snapshot") this.model.loadSnapshot(event.piles);
  }
}

describe("RoomConnection — solo host (no other peers yet)", () => {
  it("becomeHost lets sendRequest apply directly to the model", () => {
    const model = new TableModel();
    const view = new RecordingView();
    const conn = new RoomConnection(model, view, {} as never, "host");

    const client = conn.becomeHost([]);
    client.sendRequest({ type: "spawn", def: DEF_A, x: 1, y: 2 });

    expect(model.allPiles()).toHaveLength(1);
    expect(conn.isHost).toBe(true);
  });

  it("the host's own broadcast loops back into its own view", () => {
    const model = new TableModel();
    const view = new RecordingView();
    const conn = new RoomConnection(model, view, {} as never, "host");
    const client = conn.becomeHost([]);

    client.sendRequest({ type: "spawn", def: DEF_A, x: 0, y: 0 });

    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toMatchObject({ type: "pile-upserted" });
  });
});

describe("RoomConnection — host with a connected peer", () => {
  function setupHostAndPeer() {
    const net = new TestNetwork();
    const hostModel = new TableModel();
    const hostView = new RecordingView();
    const hostConn = new RoomConnection(hostModel, hostView, {} as never, "host", net.linkFactory("host"));

    const peerView = new RecordingView();
    const peerConn = new RoomConnection(new TableModel(), peerView, {} as never, "alice", net.linkFactory("alice"));

    const hostClient = hostConn.becomeHost([]);
    hostConn.addPeer("alice");
    const peerClient = peerConn.becomePeerOf("host");

    return { hostConn, peerConn, hostModel, hostView, peerView, hostClient, peerClient };
  }

  it("a peer joining after some state exists receives that state via the initial snapshot", () => {
    const net = new TestNetwork();
    const hostModel = new TableModel();
    const hostView = new RecordingView();
    const hostConn = new RoomConnection(hostModel, hostView, {} as never, "host", net.linkFactory("host"));
    const hostClient = hostConn.becomeHost([]);
    hostClient.sendRequest({ type: "spawn", def: DEF_A, x: 5, y: 5 });

    const peerView = new RecordingView();
    const peerConn = new RoomConnection(new TableModel(), peerView, {} as never, "alice", net.linkFactory("alice"));
    hostConn.addPeer("alice");
    peerConn.becomePeerOf("host");

    const snapshotEvt = peerView.events.find((e) => e.type === "snapshot");
    expect(snapshotEvt).toBeDefined();
    if (snapshotEvt?.type === "snapshot") {
      expect(snapshotEvt.piles).toHaveLength(1);
      expect(snapshotEvt.piles[0]).toMatchObject({ x: 5, y: 5 });
    }
  });

  it("a peer's request reaches the host and mutates the host's model", () => {
    const { hostModel, hostClient, peerClient } = setupHostAndPeer();
    const pile = hostModel.spawnCard(DEF_A, 0, 0); // simulate existing state directly for this test
    void hostClient;

    peerClient.sendRequest({ type: "flip", pileId: pile.id });

    expect(hostModel.topCard(pile.id)!.faceUp).toBe(true);
  });

  it("the host's broadcast of a peer's action reaches that peer's own view too (echo)", () => {
    const { hostModel, peerClient, peerView } = setupHostAndPeer();
    const pile = hostModel.spawnCard(DEF_A, 0, 0);

    peerClient.sendRequest({ type: "flip", pileId: pile.id });

    const flipEvt = peerView.events.find((e) => e.type === "pile-upserted");
    expect(flipEvt).toMatchObject({ type: "pile-upserted", pile: { cards: [{ faceUp: true }] } });
  });

  it("the host's action is broadcast to the connected peer", () => {
    const { hostClient, peerView } = setupHostAndPeer();

    hostClient.sendRequest({ type: "spawn", def: DEF_B, x: 9, y: 9 });

    const evt = peerView.events.find((e) => e.type === "pile-upserted");
    expect(evt).toMatchObject({ type: "pile-upserted", pile: { x: 9, y: 9 } });
  });

  it("two peers stay converged with each other's actions, not just the host's", () => {
    const net = new TestNetwork();
    const hostModel = new TableModel();
    const hostConn = new RoomConnection(hostModel, new RecordingView(), {} as never, "host", net.linkFactory("host"));
    const hostClient = hostConn.becomeHost([]);

    const aliceView = new RecordingView();
    const aliceConn = new RoomConnection(new TableModel(), aliceView, {} as never, "alice", net.linkFactory("alice"));
    hostConn.addPeer("alice");
    const aliceClient = aliceConn.becomePeerOf("host");

    const bobView = new RecordingView();
    const bobConn = new RoomConnection(new TableModel(), bobView, {} as never, "bob", net.linkFactory("bob"));
    hostConn.addPeer("bob");
    const bobClient = bobConn.becomePeerOf("host");

    aliceClient.sendRequest({ type: "spawn", def: DEF_A, x: 1, y: 1 });
    const [pile] = hostModel.allPiles();
    bobClient.sendRequest({ type: "flip", pileId: pile.id });
    void hostClient;

    expect(aliceView.model.allPiles()).toEqual(hostModel.allPiles());
    expect(bobView.model.allPiles()).toEqual(hostModel.allPiles());
  });

  it("removePeer stops delivering further broadcasts to them", () => {
    const { hostConn, hostClient, peerView } = setupHostAndPeer();
    hostConn.removePeer("alice");
    const before = peerView.events.length;

    hostClient.sendRequest({ type: "spawn", def: DEF_A, x: 0, y: 0 });

    expect(peerView.events.length).toBe(before);
  });

  it("addPeer is a no-op if this client isn't (yet) host", () => {
    const net = new TestNetwork();
    const conn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "alice", net.linkFactory("alice"));
    expect(() => conn.addPeer("bob")).not.toThrow();
    expect(conn.isHost).toBe(false);
  });

  it("addPeer never links a peer to itself", () => {
    const { hostConn } = setupHostAndPeer();
    expect(() => hostConn.addPeer("host")).not.toThrow();
  });
});

describe("RoomConnection — host migration", () => {
  it("becomeHostFromMigration loads the snapshot, tells the view, and takes on the host role", () => {
    const model = new TableModel();
    const view = new RecordingView();
    const conn = new RoomConnection(model, view, {} as never, "newhost");

    const snapshotPiles = [{ id: "p1", x: 1, y: 1, rotation: 0, cards: [] }];
    const client = conn.becomeHostFromMigration({ piles: snapshotPiles, pieces: [] }, []);

    expect(model.allPiles()).toEqual(snapshotPiles);
    expect(view.events.some((e) => e.type === "snapshot")).toBe(true);
    expect(conn.isHost).toBe(true);

    client.sendRequest({ type: "spawn", def: DEF_A, x: 2, y: 2 });
    expect(model.allPiles()).toHaveLength(2);
  });

  it("handles a null snapshot (promoted before the old host ever uploaded one) as empty, not a crash", () => {
    const model = new TableModel();
    const conn = new RoomConnection(model, new RecordingView(), {} as never, "newhost");
    expect(() => conn.becomeHostFromMigration(null, [])).not.toThrow();
    expect(model.allPiles()).toEqual([]);
  });

  it("re-links every still-connected peer after migration", () => {
    const net = new TestNetwork();
    const conn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "newhost", net.linkFactory("newhost"));

    const survivorView = new RecordingView();
    const survivorConn = new RoomConnection(new TableModel(), survivorView, {} as never, "survivor", net.linkFactory("survivor"));

    conn.becomeHostFromMigration({ piles: [], pieces: [] }, ["survivor"]);
    survivorConn.becomePeerOf("newhost");

    expect(survivorView.events.some((e) => e.type === "snapshot")).toBe(true);
  });

  it("switching from peer to host (becomeHost) tears down the old link-to-host", () => {
    const net = new TestNetwork();
    const hostConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "host", net.linkFactory("host"));
    hostConn.becomeHost([]);

    const conn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "alice", net.linkFactory("alice"));
    hostConn.addPeer("alice");
    conn.becomePeerOf("host");

    expect(() => conn.becomeHost([])).not.toThrow();
    expect(conn.isHost).toBe(true);
  });
});

describe("RoomConnection — destroy", () => {
  it("closes the link to the host when acting as a peer", () => {
    const net = new TestNetwork();
    const hostConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "host", net.linkFactory("host"));
    hostConn.becomeHost([]);

    const peerView = new RecordingView();
    const peerConn = new RoomConnection(new TableModel(), peerView, {} as never, "alice", net.linkFactory("alice"));
    hostConn.addPeer("alice");
    peerConn.becomePeerOf("host");
    peerConn.destroy();

    const before = peerView.events.length;
    hostConn.becomeHost([]).sendRequest({ type: "spawn", def: DEF_A, x: 0, y: 0 }); // rebroadcast attempt, alice already gone from host's perspective anyway
    expect(peerView.events.length).toBe(before);
  });

  it("closes every peer link when acting as host", () => {
    const { hostConn } = (() => {
      const net = new TestNetwork();
      const hostConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "host", net.linkFactory("host"));
      hostConn.becomeHost([]);
      hostConn.addPeer("alice");
      return { hostConn };
    })();
    expect(() => hostConn.destroy()).not.toThrow();
  });
});

describe("RoomConnection — currentSnapshot", () => {
  it("reflects the current model's piles and pieces, for periodic recovery upload", () => {
    const model = new TableModel();
    const conn = new RoomConnection(model, new RecordingView(), {} as never, "host");
    const client = conn.becomeHost([]);
    client.sendRequest({ type: "spawn", def: DEF_A, x: 0, y: 0 });
    client.sendRequest({ type: "spawn-piece", def: PIECE_A, x: 1, y: 1 });

    expect(conn.currentSnapshot()).toEqual({ piles: model.allPiles(), pieces: model.allPieces() });
  });
});

describe("RoomConnection — side channels (net/packageTransfer.ts, net/chatSync.ts)", () => {
  it("a registered side channel intercepts its own messages instead of them reaching the table view", () => {
    const net = new TestNetwork();
    const hostView = new RecordingView();
    const hostConn = new RoomConnection(new TableModel(), hostView, {} as never, "host", net.linkFactory("host"));
    hostConn.becomeHost([]);
    hostConn.addPeer("alice");

    const peerView = new RecordingView();
    const peerConn = new RoomConnection(new TableModel(), peerView, {} as never, "alice", net.linkFactory("alice"));
    peerConn.becomePeerOf("host");

    const received: { fromPeerId: string; message: unknown }[] = [];
    hostConn.addSideChannel({
      isSideChannelMessage: (m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "custom:ping",
      handle: (fromPeerId, message) => received.push({ fromPeerId, message }),
    });

    peerConn.sendToHost({ type: "custom:ping", n: 1 });

    expect(received).toEqual([{ fromPeerId: "alice", message: { type: "custom:ping", n: 1 } }]);
    // Definitely never reached table-sync interpretation as some bogus TableEvent —
    // the peer's view only ever saw its own real, expected connect-time snapshot.
    expect(peerView.events).toEqual([{ type: "snapshot", piles: [], pieces: [] }]);
  });

  it("two independently-registered side channels coexist without either seeing the other's messages", () => {
    const net = new TestNetwork();
    const hostConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "host", net.linkFactory("host"));
    hostConn.becomeHost([]);
    hostConn.addPeer("alice");
    const peerConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "alice", net.linkFactory("alice"));
    peerConn.becomePeerOf("host");

    const channelA: unknown[] = [];
    const channelB: unknown[] = [];
    hostConn.addSideChannel({
      isSideChannelMessage: (m) => (m as { type?: unknown }).type === "a:msg",
      handle: (_from, m) => channelA.push(m),
    });
    hostConn.addSideChannel({
      isSideChannelMessage: (m) => (m as { type?: unknown }).type === "b:msg",
      handle: (_from, m) => channelB.push(m),
    });

    peerConn.sendToHost({ type: "a:msg" });
    peerConn.sendToHost({ type: "b:msg" });

    expect(channelA).toEqual([{ type: "a:msg" }]);
    expect(channelB).toEqual([{ type: "b:msg" }]);
  });

  it("broadcastToPeers reaches every currently-connected peer", () => {
    const net = new TestNetwork();
    const hostConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "host", net.linkFactory("host"));
    hostConn.becomeHost([]);
    hostConn.addPeer("alice");
    hostConn.addPeer("bob");

    const aliceReceived: unknown[] = [];
    const bobReceived: unknown[] = [];
    const aliceConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "alice", net.linkFactory("alice"));
    aliceConn.becomePeerOf("host");
    aliceConn.addSideChannel({ isSideChannelMessage: (m) => (m as { type?: unknown }).type === "x", handle: (_f, m) => aliceReceived.push(m) });
    const bobConn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "bob", net.linkFactory("bob"));
    bobConn.becomePeerOf("host");
    bobConn.addSideChannel({ isSideChannelMessage: (m) => (m as { type?: unknown }).type === "x", handle: (_f, m) => bobReceived.push(m) });

    hostConn.broadcastToPeers({ type: "x", n: 1 });

    expect(aliceReceived).toEqual([{ type: "x", n: 1 }]);
    expect(bobReceived).toEqual([{ type: "x", n: 1 }]);
  });

  it("broadcastToPeers is a harmless no-op when this client isn't host", () => {
    const conn = new RoomConnection(new TableModel(), new RecordingView(), {} as never, "alice");
    expect(() => conn.broadcastToPeers({ type: "x" })).not.toThrow();
  });
});
