// The signaling WebSocket client — see docs/NETWORKING.md for the wire protocol and
// app/signaling.py for the server side. This module only handles presence/GM/host
// attestation for now; establishing the actual WebRTC data channels (and the
// relay-fallback path) is M6 in docs/PLAN.md and isn't wired up yet — the room table
// currently runs its object model locally in each tab rather than syncing it P2P.

export interface RoomInfo {
  slug: string;
  name: string;
  gameDefRef: string;
  /** True for a room created without an account (docs/DECISIONS.md D19) — its
   * server-side state is never persisted, so the client shouldn't bother uploading a
   * recovery snapshot at all (see ui/RoomTable.tsx's persistSnapshotIfHost). */
  isAnonymous: boolean;
}

export interface Peer {
  peerId: string;
  name: string;
  isGM: boolean;
  color: string;
  eyesClosed: boolean;
}

export type SignalingEvent =
  | {
      type: "welcome";
      peerId: string;
      hostPeerId: string | null;
      gmPeerId: string | null;
      roomInfo: RoomInfo;
      peers: Peer[];
      /** This client's own presence — notably its randomly-assigned `color` (see
       * app/signaling.py's DEFAULT_COLOR_PALETTE). A peer is never told about itself
       * via "peer-joined" (that broadcast excludes the peer it's about), so this is
       * the only way a joining client ever learns its own real color rather than
       * having to make one up locally. */
      self: Peer;
    }
  | { type: "you-are-host"; snapshot: unknown }
  | ({ type: "peer-joined" } & Peer)
  | { type: "peer-left"; peerId: string }
  | { type: "host-changed"; hostPeerId: string }
  | ({ type: "presence-changed" } & Peer)
  | { type: "offer" | "answer" | "ice"; to: string; from: string; [key: string]: unknown }
  | { type: "relay"; from: string; payload: unknown };

type Listener = (event: SignalingEvent) => void;

export class SignalingConnection {
  private ws: WebSocket;
  private listeners = new Set<Listener>();

  constructor(slug: string, token: string) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/ws/room/${slug}?token=${encodeURIComponent(token)}`);
    this.ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data) as SignalingEvent;
      for (const listener of this.listeners) listener(data);
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Update this peer's own color and/or eyes-closed state; either field is optional
   * (send only what changed). The server echoes the result back as a `presence-changed`
   * broadcast to everyone, sender included — see app/signaling.py's set-presence
   * handler — so callers should update their UI from that event, not optimistically. */
  setPresence(update: { color?: string; eyesClosed?: boolean }): void {
    this.send({ type: "set-presence", ...update });
  }

  close(): void {
    this.ws.close();
  }
}
