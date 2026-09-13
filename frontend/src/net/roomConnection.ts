// Orchestrates *which* PeerLink (peerLink.ts) exists to whom, and wires them to the
// sync protocol (syncProtocol.ts) — kept separate from TableApp/PixiJS entirely so this
// (the actual networking logic: who's host, who has a link to whom, what happens on
// migration) is unit-testable without a canvas, matching this project's standing
// practice of pulling anything PixiJS-independent out of table.ts. TableApp only ever
// sees the two interfaces below.
import { PileState, TableModel } from "../engine/pileModel";
import { PeerLink } from "./peerLink";
import { RelayPeerLink, SignalingLike } from "./relayPeerLink";
import { HostTableSync, TableEvent, TableRequest } from "./syncProtocol";

/** What TableApp calls to act — spawn a card, drag one, flip it, ... — without caring
 * whether this client is host (applied immediately) or a peer (sent over the network). */
export interface TableSyncClient {
  sendRequest(req: TableRequest): void;
}

/** What TableApp implements so RoomConnection can push state changes into it, again
 * without TableApp caring whether they originated locally (host) or arrived over a
 * PeerLink (peer). */
export interface TableView {
  applyEvent(event: TableEvent): void;
}

/** Swap in a different PeerLink implementation (e.g. real WebRTC once that lands) by
 * passing a different factory — RoomConnection itself never constructs a transport by
 * name, so upgrading the transport later needs no change here. Defaults to the relay. */
export type PeerLinkFactory = (signaling: SignalingLike, remotePeerId: string) => PeerLink;

const defaultLinkFactory: PeerLinkFactory = (signaling, remotePeerId) => new RelayPeerLink(signaling, remotePeerId);

/** A peer-to-host message that isn't a table mutation — asks the host to (re)send a
 * snapshot. Lives outside TableRequest's union (syncProtocol.ts) since it's a
 * connection-catch-up concern, not a game action; see becomePeerOf's doc comment for
 * why this needs to be a real message a peer can send on its own, not just an
 * optimization on the host's side. */
const REQUEST_SNAPSHOT = { type: "request-snapshot" } as const;

function isRequestSnapshot(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "request-snapshot";
}

export class RoomConnection {
  private hostSync: HostTableSync | null = null;
  private peerLinks = new Map<string, PeerLink>();
  private linkToHost: PeerLink | null = null;

  constructor(
    private model: TableModel,
    private view: TableView,
    private signaling: SignalingLike,
    private selfPeerId: string,
    private makeLink: PeerLinkFactory = defaultLinkFactory,
  ) {}

  get isHost(): boolean {
    return this.hostSync !== null;
  }

  /** Start (or resume, after a migration) acting as host: creates a link to every
   * already-connected peer and immediately sends each one a full snapshot, so a peer
   * that was already in the room before this client became host doesn't wait for its
   * next unrelated state change to catch up. */
  becomeHost(existingPeerIds: string[]): TableSyncClient {
    this.linkToHost?.close();
    this.linkToHost = null;
    this.hostSync = new HostTableSync(this.model, (recipient, event) => this.deliver(recipient, event), () => [
      this.selfPeerId,
      ...this.peerLinks.keys(),
    ]);
    for (const peerId of existingPeerIds) this.addPeer(peerId);
    return { sendRequest: (req) => this.hostSync!.handleRequest(this.selfPeerId, req) };
  }

  /** Start acting as a peer of `hostPeerId` — every outgoing request goes to them, and
   * whatever they broadcast is applied to the view as it arrives. Immediately asks the
   * host for a snapshot rather than only relying on the host's own eager push from its
   * addPeer(): both sides "dialing" a link is itself a network round trip, on top of
   * whatever it took the host to learn this peer exists at all, so there's no ordering
   * guarantee that the host's push arrives after this peer is actually listening for
   * it — asking again here is what makes catch-up correct instead of merely usual. */
  becomePeerOf(hostPeerId: string): TableSyncClient {
    this.teardownHostRole();
    const link = this.makeLink(this.signaling, hostPeerId);
    this.linkToHost = link;
    link.onMessage((msg) => this.view.applyEvent(msg as TableEvent));
    link.send(REQUEST_SNAPSHOT);
    return { sendRequest: (req) => link.send(req) };
  }

  /** A new peer joined the room — give them a link and catch them up. Only meaningful
   * while this client is host; a no-op otherwise (that peer will get a link from
   * whoever the actual host is). This push is a best-effort optimization, not the only
   * way a peer gets caught up — see becomePeerOf's own request-snapshot call for why
   * relying on this alone isn't safe. */
  addPeer(peerId: string): void {
    if (!this.hostSync || peerId === this.selfPeerId || this.peerLinks.has(peerId)) return;
    const link = this.makeLink(this.signaling, peerId);
    link.onMessage((msg) => {
      if (isRequestSnapshot(msg)) this.hostSync!.sendSnapshotTo(peerId);
      else this.hostSync!.handleRequest(peerId, msg as TableRequest);
    });
    this.peerLinks.set(peerId, link);
    this.hostSync.sendSnapshotTo(peerId);
  }

  /** A peer left the room — drop their link. Safe to call regardless of role. */
  removePeer(peerId: string): void {
    this.peerLinks.get(peerId)?.close();
    this.peerLinks.delete(peerId);
  }

  /** The current table state, suitable for the periodic recovery upload described in
   * docs/NETWORKING.md "Host migration" (app/signaling.py's `snapshot` message) — only
   * meaningful while this client is host. */
  currentSnapshot(): PileState[] {
    return this.model.allPiles();
  }

  /** This client was just promoted to host (docs/NETWORKING.md "Host migration"):
   * resume from the snapshot the old host had most recently uploaded (or start empty if
   * there wasn't one yet — a very short-lived room), then take on the host role for
   * whoever's still connected. */
  becomeHostFromMigration(snapshot: PileState[] | null, remainingPeerIds: string[]): TableSyncClient {
    this.model.loadSnapshot(snapshot ?? []);
    this.view.applyEvent({ type: "snapshot", piles: this.model.allPiles() });
    return this.becomeHost(remainingPeerIds);
  }

  private deliver(recipient: string, event: TableEvent): void {
    if (recipient === this.selfPeerId) {
      this.view.applyEvent(event);
    } else {
      this.peerLinks.get(recipient)?.send(event);
    }
  }

  private teardownHostRole(): void {
    this.hostSync = null;
    for (const link of this.peerLinks.values()) link.close();
    this.peerLinks.clear();
  }

  destroy(): void {
    this.linkToHost?.close();
    this.linkToHost = null;
    this.teardownHostRole();
  }
}
