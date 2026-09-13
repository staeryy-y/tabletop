// The fallback transport from docs/NETWORKING.md "Relay fallback": tunnels a PeerLink's
// messages through the same signaling WebSocket everyone already has open, using the
// `relay` message type app/signaling.py forwards without inspecting. Needs no TURN
// server (which server-watcher's no-root host couldn't run anyway — see
// docs/DECISIONS.md D3) — just a peer whose direct WebRTC connection failed or hasn't
// finished negotiating yet.
import { PeerLink } from "./peerLink";
import { SignalingEvent } from "./signaling";

/** Only the slice of SignalingConnection this needs — lets tests use a trivial fake
 * instead of a real WebSocket-backed connection. */
export interface SignalingLike {
  on(listener: (event: SignalingEvent) => void): () => void;
  send(message: Record<string, unknown>): void;
}

export class RelayPeerLink implements PeerLink {
  private handlers = new Set<(message: unknown) => void>();
  private unsubscribe: () => void;

  constructor(private signaling: SignalingLike, private remotePeerId: string) {
    this.unsubscribe = signaling.on((event) => {
      if (event.type === "relay" && event.from === this.remotePeerId) {
        for (const handler of this.handlers) handler(event.payload);
      }
    });
  }

  send(message: unknown): void {
    this.signaling.send({ type: "relay", to: this.remotePeerId, payload: message });
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.unsubscribe();
    this.handlers.clear();
  }
}
