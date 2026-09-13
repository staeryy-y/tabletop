// The real transport docs/NETWORKING.md describes: one RTCDataChannel per peer, with
// the signaling WebSocket used purely to exchange SDP offers/answers and ICE candidates
// (never game state itself). Per the signaling flow it documents, the *peer* (joiner)
// always creates the offer and the *host* always answers — see roomConnection.ts, whose
// two makeLink() call sites (becomePeerOf = initiator, addPeer = answerer) are the only
// place that decides which role a given link plays. Wrapped by peerLinkWithFallback.ts,
// which is what actually gets handed to RoomConnection — this class alone has no
// fallback behavior, it just is-or-isn't connected.
import { PeerLink } from "./peerLink";
import { SignalingEvent } from "./signaling";

/** Only the slice of SignalingConnection this needs — matches relayPeerLink.ts's
 * interface of the same name (structurally identical; kept separate so this module
 * doesn't have to import from a sibling transport). */
export interface SignalingLike {
  on(listener: (event: SignalingEvent) => void): () => void;
  send(message: Record<string, unknown>): void;
}

export type PeerRole = "initiator" | "answerer";

/** Lets tests substitute a fake RTCPeerConnection (jsdom/Node have no real WebRTC
 * stack) — the only way this class talks to the network at all. */
export type RtcPeerConnectionFactory = () => RTCPeerConnection;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DATA_CHANNEL_LABEL = "table-sync";

function defaultFactory(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
}

export class WebRtcPeerLink implements PeerLink {
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private handlers = new Set<(message: unknown) => void>();
  private unsubscribeSignaling: () => void;
  /** ICE candidates that arrived before setRemoteDescription() — addIceCandidate()
   * throws if called too early, so these wait until there's a remote description to
   * attach to. */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private queuedBeforeOpen: unknown[] = [];
  private closed = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;

  constructor(private signaling: SignalingLike, private remotePeerId: string, private role: PeerRole, makePc: RtcPeerConnectionFactory = defaultFactory) {
    this.pc = makePc();
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A deliberate close() (see below) transitions the underlying connection to
    // "closed" too, which the onconnectionstatechange handler below turns into a
    // rejection of this same promise — correct if some caller is awaiting ready(), but
    // otherwise an unhandled-rejection warning for a promise nobody was ever going to
    // look at again once already connected. This dummy handler doesn't stop ready()'s
    // *other* subscribers (a caller's own `.then`/`.catch`) from seeing the rejection
    // normally — Promises support multiple independent subscribers — it only keeps the
    // runtime from treating this internal one as unhandled.
    this.readyPromise.catch(() => {});

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signaling.send({ type: "ice", to: this.remotePeerId, candidate: ev.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
        this.rejectReady(new Error(`webrtc connection ${this.pc.connectionState}`));
      }
    };

    this.unsubscribeSignaling = signaling.on((event) => {
      void this.handleSignalingEvent(event);
    });

    if (role === "initiator") {
      const channel = this.pc.createDataChannel(DATA_CHANNEL_LABEL);
      this.wireChannel(channel);
      void this.sendOffer();
    } else {
      this.pc.ondatachannel = (ev) => this.wireChannel(ev.channel);
    }
  }

  /** Resolves once the data channel is open and ready to send/receive; rejects if the
   * underlying connection fails or closes before that happens. peerLinkWithFallback.ts
   * races this (with its own timeout) against falling back to the relay. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private wireChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => {
      this.resolveReady();
      const queued = this.queuedBeforeOpen;
      this.queuedBeforeOpen = [];
      for (const message of queued) channel.send(JSON.stringify(message));
    };
    channel.onmessage = (ev) => {
      let message: unknown;
      try {
        message = JSON.parse(ev.data as string);
      } catch {
        return; // not a message this protocol sent; ignore rather than crash
      }
      for (const handler of this.handlers) handler(message);
    };
  }

  private async sendOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.send({ type: "offer", to: this.remotePeerId, sdp: offer });
    } catch (err) {
      this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async handleSignalingEvent(event: SignalingEvent): Promise<void> {
    if (this.closed) return;
    try {
      if (event.type === "offer" && this.role === "answerer" && event.from === this.remotePeerId) {
        await this.pc.setRemoteDescription(event.sdp as RTCSessionDescriptionInit);
        await this.flushPendingCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({ type: "answer", to: this.remotePeerId, sdp: answer });
      } else if (event.type === "answer" && this.role === "initiator" && event.from === this.remotePeerId) {
        await this.pc.setRemoteDescription(event.sdp as RTCSessionDescriptionInit);
        await this.flushPendingCandidates();
      } else if (event.type === "ice" && event.from === this.remotePeerId) {
        const candidate = event.candidate as RTCIceCandidateInit;
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
        else this.pendingCandidates.push(candidate);
      }
    } catch (err) {
      this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) await this.pc.addIceCandidate(candidate);
  }

  send(message: unknown): void {
    if (!this.channel || this.channel.readyState !== "open") {
      this.queuedBeforeOpen.push(message);
      return;
    }
    this.channel.send(JSON.stringify(message));
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.unsubscribeSignaling();
    this.handlers.clear();
    this.channel?.close();
    this.pc.close();
  }
}
