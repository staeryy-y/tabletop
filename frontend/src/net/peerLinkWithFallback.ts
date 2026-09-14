// Tries a real WebRTC data channel first; if it doesn't open within a timeout (or the
// RTCPeerConnection fails outright), transparently switches to the WS-relay fallback —
// see docs/NETWORKING.md "Relay fallback". This is the PeerLink RoomConnection actually
// uses by default (net/roomConnection.ts's defaultLinkFactory); callers never see which
// transport won, or that a decision was even made.
import { PeerLink } from "./peerLink";
import { RelayPeerLink, SignalingLike } from "./relayPeerLink";
import { PeerRole, WebRtcPeerLink } from "./webrtcPeerLink";

/** Generous but bounded — a direct connection either opens quickly or, per
 * docs/NETWORKING.md, should give up and let the relay carry the session instead of
 * leaving a peer stuck waiting on a connection that may never come. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/** The minimal shape this needs from either transport — both WebRtcPeerLink and
 * RelayPeerLink already satisfy this (PeerLink plus, for the WebRTC side, `ready()`). */
interface ConnectAttempt extends PeerLink {
  ready?(): Promise<void>;
}

export class PeerLinkWithFallback implements PeerLink {
  private active: ConnectAttempt;
  private handlers = new Set<(message: unknown) => void>();
  /** Buffers anything sent before a transport has actually settled, so callers never
   * need to know a race is still in flight. Set back to null once settled — its
   * presence *is* the "have we settled yet" flag. */
  private queuedBeforeSettled: unknown[] | null = [];
  private closed = false;
  private timeoutHandle: ReturnType<typeof setTimeout>;

  constructor(
    private signaling: SignalingLike,
    private remotePeerId: string,
    role: PeerRole,
    timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
    private makeWebRtc: (signaling: SignalingLike, remotePeerId: string, role: PeerRole) => ConnectAttempt = (s, r, ro) => new WebRtcPeerLink(s, r, ro),
    private makeRelay: (signaling: SignalingLike, remotePeerId: string) => PeerLink = (s, r) => new RelayPeerLink(s, r),
  ) {
    const webrtc = this.makeWebRtc(signaling, remotePeerId, role);
    this.active = webrtc;
    webrtc.onMessage((message) => this.deliver(message));

    this.timeoutHandle = setTimeout(() => this.fallBack(), timeoutMs);
    webrtc.ready?.().then(
      () => this.settle(webrtc),
      () => this.fallBack(),
    );
  }

  /** Give up on WebRTC (timed out, or its own ready() promise rejected) and switch to
   * the relay instead. A no-op if something already settled this link (WebRTC opened in
   * time, this already fell back once, or the link was closed) — settling only ever
   * happens once. */
  private fallBack(): void {
    if (this.queuedBeforeSettled === null || this.closed) return;
    clearTimeout(this.timeoutHandle);
    this.active.close();
    const relay = this.makeRelay(this.signaling, this.remotePeerId);
    relay.onMessage((message) => this.deliver(message));
    this.settle(relay);
  }

  private settle(link: ConnectAttempt): void {
    if (this.queuedBeforeSettled === null || this.closed) return;
    clearTimeout(this.timeoutHandle);
    this.active = link;
    const queued = this.queuedBeforeSettled;
    this.queuedBeforeSettled = null;
    for (let i = 0; i < queued.length; i++) {
      const message = queued[i];
      try {
        link.send(message);
      } catch (err) {
        // RTCDataChannel can reject an otherwise-open channel when a message exceeds
        // negotiated max-message-size (large table snapshots are the common case).
        // Switch transports immediately and resend instead of losing synchronization.
        console.warn("[rpg-tabletop][sync] WebRTC send failed; switching to relay", err);
        this.activateRelay();
        for (const remaining of queued.slice(i)) this.active.send(remaining);
        break;
      }
    }
  }

  private activateRelay(firstMessage?: unknown): void {
    if (this.closed || this.active instanceof RelayPeerLink) {
      if (firstMessage !== undefined) this.active.send(firstMessage);
      return;
    }
    this.active.close();
    const relay = this.makeRelay(this.signaling, this.remotePeerId);
    relay.onMessage((message) => this.deliver(message));
    this.active = relay;
    this.queuedBeforeSettled = null;
    if (firstMessage !== undefined) relay.send(firstMessage);
  }

  private deliver(message: unknown): void {
    for (const handler of this.handlers) handler(message);
  }

  send(message: unknown): void {
    if (this.queuedBeforeSettled !== null) this.queuedBeforeSettled.push(message);
    else {
      try {
        this.active.send(message);
      } catch (err) {
        console.warn("[rpg-tabletop][sync] WebRTC send failed; switching to relay", err);
        this.activateRelay(message);
      }
    }
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timeoutHandle);
    this.active.close();
    this.handlers.clear();
  }
}
