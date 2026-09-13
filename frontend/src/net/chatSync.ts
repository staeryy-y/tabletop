// Chat, synced across every connected player over the same host-authoritative link as
// everything else (net/roomConnection.ts's SideChannel) — chat had been local-to-a-tab
// only since M3, which docs/IMPLEMENTATION_LOG.md flagged as a real gap once M6's P2P
// layer existed and chat still hadn't been wired to it.
//
// Deliberately kept independent of syncProtocol.ts's TableRequest/TableEvent: chat
// messages aren't table state (no pile/id, nothing a redaction rule could apply to),
// and unlike the table there's no id-allocation concern — any client, host or peer, can
// originate a message. The host is still the single point everything passes through
// (star topology — see docs/NETWORKING.md), both to reach every peer and to be the one
// place "history so far" lives for a newly-joined peer to ask for.
import { SideChannel } from "./roomConnection";

export interface ChatMessage {
  author: string;
  text: string;
  isError?: boolean;
}

export type ChatSyncMessage =
  | { type: "chat:post"; message: ChatMessage }
  | { type: "chat:request-history" }
  | { type: "chat:history"; messages: ChatMessage[] }
  | { type: "chat:message"; message: ChatMessage };

export function isChatSyncMessage(message: unknown): message is ChatSyncMessage {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("chat:");
}

/** Caps how much history a newly-joined peer can ask for — plenty for a single
 * session's worth of chat/roll log without holding an unbounded amount of memory on
 * whoever's host. Older messages are simply gone, not persisted anywhere (matching
 * the project's server-is-asset-free, session-scoped design — see D14). */
export const MAX_CHAT_HISTORY = 200;

/** The narrow slice of RoomConnection this needs — matches this project's standing
 * pattern (SignalingLike, PackageTransport, ...) of depending on an interface small
 * enough to fake in a test rather than the concrete class. */
export interface ChatTransport {
  readonly isHost: boolean;
  addSideChannel(channel: SideChannel): void;
  sendToHost(message: unknown): void;
  sendToPeer(peerId: string, message: unknown): void;
  broadcastToPeers(message: unknown): void;
}

/** One instance per room, used identically regardless of whether this client is
 * currently host or a peer — like RoomConnection itself and PackageDistributor, its
 * role just falls out of which methods get called and what `transport.isHost` reads at
 * the time. Posting from a peer round-trips through the host so everyone (including the
 * poster) sees their own message the same way — arriving as a `chat:message` — rather
 * than showing it optimistically ahead of confirmation. */
export class ChatDistributor {
  private history: ChatMessage[] = [];

  constructor(private transport: ChatTransport, private onMessage: (message: ChatMessage) => void) {
    transport.addSideChannel({
      isSideChannelMessage: isChatSyncMessage,
      handle: (fromPeerId, message) => this.handleMessage(fromPeerId, message as ChatSyncMessage),
    });
  }

  /** Post a message as this client. If this client is host, it's recorded and
   * broadcast immediately (no network round trip to itself needed); if a peer, it's
   * sent to the host and — like everyone else's messages — only actually shown once
   * the resulting `chat:message` broadcast comes back. */
  post(message: ChatMessage): void {
    if (this.transport.isHost) this.recordAndBroadcast(message);
    else this.transport.sendToHost({ type: "chat:post", message });
  }

  /** Call after becoming a peer of some host — a no-op if this client already knows
   * about at least one message (either it's been in the room a while, or it already
   * caught up once before), so it's safe to call on every becomePeerOf transition
   * (including after a host migration) the same way PackageDistributor's
   * requestFromHostIfNeeded() is. Not a guarantee against ever missing a message — a
   * client that's briefly disconnected while already having *some* history won't
   * re-request to fill a gap — but losing a line or two of chat during a rare
   * disconnect is an accepted tradeoff for staying this simple (matches
   * net/packageTransfer.ts's own no-retry stance). */
  requestHistoryIfNeeded(): void {
    if (this.history.length === 0) this.transport.sendToHost({ type: "chat:request-history" });
  }

  private recordAndBroadcast(message: ChatMessage): void {
    this.remember(message);
    this.onMessage(message); // the host's own copy — no self-addressed network round trip
    this.transport.broadcastToPeers({ type: "chat:message", message });
  }

  /** Keeps `history` a running total of everything this client has ever learned,
   * regardless of whether it arrived by posting (as host), receiving a broadcast (as a
   * peer), or catching up on someone else's history — so if this client is later
   * promoted to host, it's already able to serve the full history onward, the same way
   * PackageDistributor's received packages make it ready to redistribute. */
  private remember(message: ChatMessage): void {
    this.history.push(message);
    if (this.history.length > MAX_CHAT_HISTORY) this.history.shift();
  }

  private handleMessage(fromPeerId: string, message: ChatSyncMessage): void {
    switch (message.type) {
      case "chat:post":
        // Topologically this only ever reaches a client that IS host — a peer has no
        // direct link from anyone but its own host to receive this on — but the guard
        // costs nothing and keeps that assumption from being silently load-bearing.
        if (this.transport.isHost) this.recordAndBroadcast(message.message);
        break;
      case "chat:request-history":
        this.transport.sendToPeer(fromPeerId, { type: "chat:history", messages: [...this.history] });
        break;
      case "chat:history":
        for (const historical of message.messages) {
          this.remember(historical);
          this.onMessage(historical);
        }
        break;
      case "chat:message":
        this.remember(message.message);
        this.onMessage(message.message);
        break;
    }
  }
}
