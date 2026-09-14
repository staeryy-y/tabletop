// Orchestrates *which* PeerLink (peerLink.ts) exists to whom, and wires them to the
// sync protocol (syncProtocol.ts) — kept separate from TableApp/PixiJS entirely so this
// (the actual networking logic: who's host, who has a link to whom, what happens on
// migration) is unit-testable without a canvas, matching this project's standing
// practice of pulling anything PixiJS-independent out of table.ts. TableApp only ever
// sees the two interfaces below.
import { TableModel, TableSnapshot } from "../engine/pileModel";
import { PeerLink } from "./peerLink";
import { PeerLinkWithFallback } from "./peerLinkWithFallback";
import { SignalingLike } from "./relayPeerLink";
import { HostTableSync, TableEvent, TableRequest } from "./syncProtocol";
import { PeerRole } from "./webrtcPeerLink";

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

/** An independent message protocol allowed to ride the same per-peer links this class
 * already manages — see net/packageTransfer.ts and net/chatSync.ts, its two consumers
 * so far. Every incoming message is offered to each registered channel's
 * `isSideChannelMessage` in registration order; the first one that claims it gets
 * `handle`d and the message never reaches table-sync interpretation (a
 * TableRequest/TableEvent or the request-snapshot catch-up message below) at all. Each
 * channel's messages need a `type` namespace distinct from every other's (by
 * convention, a `"<name>:"` prefix — "pkg:", "chat:") so they never collide. */
export interface SideChannel {
  isSideChannelMessage(message: unknown): boolean;
  handle(fromPeerId: string, message: unknown): void;
}

/** Swap in a different PeerLink implementation by passing a different factory —
 * RoomConnection itself never constructs a transport by name, so upgrading the
 * transport later needs no change here. `role` matters for real WebRTC (only one side
 * of a link may create the offer — see webrtcPeerLink.ts) but a transport that doesn't
 * care, like a bare relay, is free to ignore it. Defaults to
 * peerLinkWithFallback.ts: real WebRTC, falling back to the WS-relay automatically. */
export type PeerLinkFactory = (signaling: SignalingLike, remotePeerId: string, role: PeerRole) => PeerLink;

const defaultLinkFactory: PeerLinkFactory = (signaling, remotePeerId, role) => new PeerLinkWithFallback(signaling, remotePeerId, role);

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
  private sideChannels: SideChannel[] = [];

  constructor(
    private model: TableModel,
    private view: TableView,
    private signaling: SignalingLike,
    private selfPeerId: string,
    private makeLink: PeerLinkFactory = defaultLinkFactory,
    /** The room's current GM peerId, or null — passed straight through to
     * HostTableSync to gate locked-Mat requests (D26). A callback (not a plain value)
     * since the caller (ui/RoomTable.tsx) learns/updates this from React state that
     * can change after this RoomConnection is already constructed. Defaults to
     * "unknown," matching HostTableSync's own default, so every existing call site
     * that never mentions Mats/GM at all keeps working unchanged. */
    private getGmPeerId: () => string | null = () => null,
  ) {}

  get isHost(): boolean {
    return this.hostSync !== null;
  }

  /** Start (or resume, after a migration) acting as host: creates a link to every
   * already-connected peer and immediately sends each one a full snapshot, so a peer
   * that was already in the room before this client became host doesn't wait for its
   * next unrelated state change to catch up. */
  becomeHost(existingPeerIds: string[]): TableSyncClient {
    console.info("[rpg-tabletop][sync] becoming host", { self: this.selfPeerId, peers: existingPeerIds });
    this.linkToHost?.close();
    this.linkToHost = null;
    this.hostSync = new HostTableSync(
      this.model,
      (recipient, event) => this.deliver(recipient, event),
      () => [this.selfPeerId, ...this.peerLinks.keys()],
      this.getGmPeerId,
    );
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
    console.info("[rpg-tabletop][sync] linking to host", { self: this.selfPeerId, host: hostPeerId });
    this.teardownHostRole();
    // The peer always initiates the offer to the host — see docs/NETWORKING.md's
    // signaling flow and webrtcPeerLink.ts's doc comment on PeerRole.
    const link = this.makeLink(this.signaling, hostPeerId, "initiator");
    this.linkToHost = link;
    link.onMessage((msg) => {
      if (this.tryHandleAsSideChannel(hostPeerId, msg)) return;
      if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "snapshot") {
        const snapshot = msg as { piles?: unknown[]; pieces?: unknown[]; mats?: unknown[] };
        console.info("[rpg-tabletop][sync] snapshot received", { self: this.selfPeerId, host: hostPeerId, piles: snapshot.piles?.length ?? 0, pieces: snapshot.pieces?.length ?? 0, mats: snapshot.mats?.length ?? 0 });
      }
      this.view.applyEvent(msg as TableEvent);
    });
    link.send(REQUEST_SNAPSHOT);
    // A request sent while the transport is negotiating is buffered by the normal
    // wrapper, but retrying is cheap and protects older/fallback transports that may
    // settle between the initial send and their message handler being ready. This is
    // especially important for guests joining an already-populated table.
    for (const delay of [500, 2000, 5000]) {
      setTimeout(() => {
        if (this.linkToHost === link) link.send(REQUEST_SNAPSHOT);
      }, delay);
    }
    return { sendRequest: (req) => link.send(req) };
  }

  /** Ask the current host for a fresh full state. This is intentionally public for
   * startup catch-up: a custom package can finish transferring after the first table
   * snapshot, and the host may have seeded its cards in that interval. */
  requestSnapshotFromHost(): void {
    if (this.linkToHost) {
      console.info("[rpg-tabletop][sync] requesting fresh snapshot", { self: this.selfPeerId });
      this.linkToHost.send(REQUEST_SNAPSHOT);
    }
  }

  /** A new peer joined the room — give them a link and catch them up. Only meaningful
   * while this client is host; a no-op otherwise (that peer will get a link from
   * whoever the actual host is). This push is a best-effort optimization, not the only
   * way a peer gets caught up — see becomePeerOf's own request-snapshot call for why
   * relying on this alone isn't safe. */
  addPeer(peerId: string): void {
    if (!this.hostSync || peerId === this.selfPeerId || this.peerLinks.has(peerId)) return;
    console.info("[rpg-tabletop][sync] linking peer", { host: this.selfPeerId, peer: peerId });
    // The host always answers rather than initiates — see becomePeerOf's comment.
    const link = this.makeLink(this.signaling, peerId, "answerer");
    link.onMessage((msg) => {
      if (this.tryHandleAsSideChannel(peerId, msg)) return;
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

  /** Register another side channel — see the SideChannel doc comment above. Safe to
   * call any number of times, before or after a role is established; every link
   * (existing or created afterward) offers messages to every registered channel, in
   * registration order, since the check happens per-message, not per-link. */
  addSideChannel(channel: SideChannel): void {
    this.sideChannels.push(channel);
  }

  private tryHandleAsSideChannel(fromPeerId: string, message: unknown): boolean {
    for (const channel of this.sideChannels) {
      if (channel.isSideChannelMessage(message)) {
        channel.handle(fromPeerId, message);
        return true;
      }
    }
    return false;
  }

  /** Send a side-channel message directly to the host — meaningful only while this
   * client is a peer (a harmless no-op otherwise, e.g. before any role is assigned). */
  sendToHost(message: unknown): void {
    this.linkToHost?.send(message);
  }

  /** Send a side-channel message directly to one connected peer — meaningful only
   * while this client is host (a harmless no-op if that peer isn't linked, e.g. it
   * already left, or this client isn't host at all). */
  sendToPeer(peerId: string, message: unknown): void {
    this.peerLinks.get(peerId)?.send(message);
  }

  /** Send a side-channel message to every currently-connected peer — meaningful only
   * while this client is host (a harmless no-op, sending to no one, otherwise). */
  broadcastToPeers(message: unknown): void {
    for (const link of this.peerLinks.values()) link.send(message);
  }

  /** The current table state, suitable for the periodic recovery upload described in
   * docs/NETWORKING.md "Host migration" (app/signaling.py's `snapshot` message) — only
   * meaningful while this client is host. */
  currentSnapshot(): TableSnapshot {
    const snapshot = { piles: this.model.allPiles(), pieces: this.model.allPieces(), mats: this.model.allMats() };
    console.info("[rpg-tabletop][sync] snapshot", { self: this.selfPeerId, piles: snapshot.piles.length, pieces: snapshot.pieces.length, mats: snapshot.mats.length });
    return snapshot;
  }

  /** This client was just promoted to host (docs/NETWORKING.md "Host migration"):
   * resume from the snapshot the old host had most recently uploaded (or start empty if
   * there wasn't one yet — a very short-lived room), then take on the host role for
   * whoever's still connected. */
  becomeHostFromMigration(snapshot: TableSnapshot | null, remainingPeerIds: string[]): TableSyncClient {
    this.model.loadSnapshot(snapshot?.piles ?? [], snapshot?.pieces ?? [], snapshot?.mats ?? []);
    this.view.applyEvent({ type: "snapshot", piles: this.model.allPiles(), pieces: this.model.allPieces(), mats: this.model.allMats() });
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
