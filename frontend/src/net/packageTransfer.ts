// P2P transfer of a room's custom game package (rules + every card/piece image, all
// embedded as data: URIs — see packages/gamePackage.ts) from whoever has it to every
// other peer, per docs/NETWORKING.md "Asset distribution" and docs/DECISIONS.md D14 (the
// server never stores or sees this content at all). A *bundled* package needs none of
// this — every peer fetches the same static file independently — so this module and
// PackageDistributor only ever come into play for a room whose game_def_ref is
// "custom".
//
// Deliberate simplification vs. NETWORKING.md's literal "two data channels per peer"
// (one for game sync, one for asset transfer): this rides the *same* PeerLink/channel
// net/roomConnection.ts already manages for the table-sync protocol, distinguished by
// message `type` (see RoomConnection's `SideChannel`) rather than negotiating a second
// RTCDataChannel per peer. A package transfer happens once, briefly, right after join —
// not worth the extra WebRTC negotiation complexity for how rarely it runs. See
// docs/DECISIONS.md D17.
//
// Also deliberately skipped for v1 (matching NETWORKING.md's own framing of
// content-hash caching as "a nice-to-have, not required for a working v1"): no
// cryptographic content hash, no IndexedDB asset cache, no retry on a dropped chunk. A
// lost chunk just means PackageReassembler silently never completes that transfer —
// acceptable given the cooperating-peers trust model this whole project assumes (see
// NETWORKING.md "Trust model") and given a room's custom package rarely changes size
// mid-session.
import { GamePackage } from "../packages/gamePackage";
import { SideChannel } from "./roomConnection";

export type PackageTransferMessage =
  | { type: "pkg:request" }
  | { type: "pkg:begin"; transferId: string; totalChunks: number }
  | { type: "pkg:chunk"; transferId: string; index: number; data: string }
  | { type: "pkg:end"; transferId: string };

/** Comfortably under every real-world WebRTC data channel size ceiling (and the
 * signaling-WS relay's, which just forwards JSON) — see docs/NETWORKING.md "Asset
 * distribution": chunked specifically so a multi-megabyte package with several
 * card/tile images doesn't need one oversized message. */
export const PACKAGE_CHUNK_SIZE = 15000;

export function isPackageTransferMessage(message: unknown): message is PackageTransferMessage {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("pkg:");
}

let transferCounter = 0;
function nextTransferId(): string {
  transferCounter += 1;
  return `t${transferCounter}`;
}

/** Split a package's serialized JSON into the begin/chunk(s)/end message sequence a
 * receiver's PackageReassembler expects, in the order they should be sent. Pure string
 * splitting — no knowledge of GamePackage's shape needed here. */
export function chunkPackageJson(json: string, transferId: string = nextTransferId()): PackageTransferMessage[] {
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += PACKAGE_CHUNK_SIZE) chunks.push(json.slice(i, i + PACKAGE_CHUNK_SIZE));
  const messages: PackageTransferMessage[] = [{ type: "pkg:begin", transferId, totalChunks: chunks.length }];
  chunks.forEach((data, index) => messages.push({ type: "pkg:chunk", transferId, index, data }));
  messages.push({ type: "pkg:end", transferId });
  return messages;
}

/** Reassembles one or more concurrent chunked transfers (keyed by transferId) back into
 * a complete JSON string. Feed it every pkg:begin/chunk/end message in whatever order
 * they arrive; handleMessage returns the reassembled string exactly once, when a
 * transfer's `pkg:end` arrives and every chunk it promised is actually present. */
export class PackageReassembler {
  private inFlight = new Map<string, { totalChunks: number; parts: (string | undefined)[] }>();

  handleMessage(message: PackageTransferMessage): string | null {
    switch (message.type) {
      case "pkg:begin":
        if (!Number.isInteger(message.totalChunks) || message.totalChunks < 1 || message.totalChunks > 100000) return null;
        // .fill(undefined) matters: a bare `new Array(n)` is sparse (n "holes", not n
        // real `undefined` values), and Array.prototype.some() below silently *skips*
        // holes rather than visiting them — so a genuinely missing chunk would go
        // undetected and this could return a corrupted, silently-truncated string
        // instead of correctly giving up. Filling makes every slot a real element.
        this.inFlight.set(message.transferId, { totalChunks: message.totalChunks, parts: new Array(message.totalChunks).fill(undefined) });
        return null;
      case "pkg:chunk": {
        const entry = this.inFlight.get(message.transferId);
        if (!entry) return null; // a chunk for a transfer we never saw pkg:begin for — ignore, not crash
        if (!Number.isInteger(message.index) || message.index < 0 || message.index >= entry.totalChunks || typeof message.data !== "string") return null;
        entry.parts[message.index] = message.data;
        return null;
      }
      case "pkg:end": {
        const entry = this.inFlight.get(message.transferId);
        this.inFlight.delete(message.transferId);
        if (!entry || entry.parts.some((part) => part === undefined)) return null; // incomplete — see module doc comment
        return entry.parts.join("");
      }
      default:
        return null;
    }
  }
}

/** The narrow slice of RoomConnection this needs — matches this project's standing
 * pattern (SignalingLike, TableSyncClient, ...) of depending on an interface small
 * enough to fake in a test rather than the concrete class. */
export interface PackageTransport {
  addSideChannel(channel: SideChannel): void;
  sendToHost(message: unknown): void;
  sendToPeer(peerId: string, message: unknown): void;
}

/** One instance per room, used identically regardless of whether this client is
 * currently host or a peer — like RoomConnection itself, its role just falls out of
 * which methods get called. Owns at most one package's worth of content at a time
 * (`localPackageJson`): whatever this client itself picked (see
 * roomPackageChoice.ts) if anything, else whatever it most recently received from
 * someone else — either way, once set, this client can serve it to anyone who asks,
 * which is what makes a promoted host already able to redistribute it (see
 * docs/ARCHITECTURE.md "Room lifecycle" step 4). */
export class PackageDistributor {
  private localPackageJson: string | null = null;
  private pendingRequesters = new Set<string>();
  private reassembler = new PackageReassembler();

  constructor(private transport: PackageTransport, private onReceived: (pkg: GamePackage) => void) {
    transport.addSideChannel({
      isSideChannelMessage: isPackageTransferMessage,
      handle: (fromPeerId, message) => this.handleMessage(fromPeerId, message as PackageTransferMessage),
    });
  }

  /** This client now has the package's actual content — either it's the one that
   * picked/uploaded it (see roomPackageChoice.ts), or it just finished reassembling one
   * received over the wire. Answers any request that arrived before this was called. */
  setLocalPackage(pkg: GamePackage): void {
    this.localPackageJson = JSON.stringify(pkg);
    const requesters = [...this.pendingRequesters];
    this.pendingRequesters.clear();
    for (const peerId of requesters) this.sendPackageTo(peerId);
  }

  /** True once this client has real package content to serve — either its own pick, or
   * something already received from someone else. */
  hasPackage(): boolean {
    return this.localPackageJson !== null;
  }

  /** Push proactively when signaling announces a new peer. This closes the startup
   * race where the guest's first request arrives before the host's side-channel link
   * is fully attached. */
  sendTo(peerId: string): void { if (this.localPackageJson !== null) this.sendPackageTo(peerId); }

  /** Call whenever this client becomes a peer of some host (see
   * roomConnection.ts's becomePeerOf) in a room with a custom package. A no-op if this
   * client already has content — most commonly because it's the one that picked the
   * package in the first place, so there's nothing to ask for. */
  requestFromHostIfNeeded(): void {
    if (this.localPackageJson !== null) return;
    console.info("[rpg-tabletop][package] requesting package from host");
    this.transport.sendToHost({ type: "pkg:request" });
    // Retry briefly across transport negotiation/fallback. The request is idempotent;
    // once any transfer completes, later retries become no-ops.
    for (const delay of [500, 2000, 5000]) {
      setTimeout(() => {
        if (this.localPackageJson === null) this.transport.sendToHost({ type: "pkg:request" });
      }, delay);
    }
  }

  private sendPackageTo(peerId: string): void {
    if (this.localPackageJson === null) return;
    const messages = chunkPackageJson(this.localPackageJson);
    console.info("[rpg-tabletop][package] sending package", { peerId, chunks: messages.length - 2, bytes: this.localPackageJson.length });
    for (const message of messages) this.transport.sendToPeer(peerId, message);
  }

  private handleMessage(fromPeerId: string, message: PackageTransferMessage): void {
    if (message.type === "pkg:request") {
      if (this.localPackageJson !== null) this.sendPackageTo(fromPeerId);
      else this.pendingRequesters.add(fromPeerId);
      return;
    }
    const json = this.reassembler.handleMessage(message);
    if (json === null) return;
    console.info("[rpg-tabletop][package] package received", { fromPeerId, bytes: json.length });
    try {
      const pkg = JSON.parse(json) as GamePackage;
      this.setLocalPackage(pkg); // ready to redistribute if later promoted to host
      this.onReceived(pkg);
    } catch (err) {
      console.error("received an unparseable game package", err);
    }
  }
}
