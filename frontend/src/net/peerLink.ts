// The transport abstraction the sync protocol (syncProtocol.ts) sends/receives
// through, so it never needs to know whether a given peer is reached over a real
// WebRTC data channel or the signaling-WS relay fallback — see docs/NETWORKING.md's
// transport-layer table and docs/PLAN.md's M6 note that this was meant to be a
// transport-only swap over an already-correct protocol.
export interface PeerLink {
  send(message: unknown): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void;
  close(): void;
}
