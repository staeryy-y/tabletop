// The signaling WebSocket client — see docs/NETWORKING.md for the wire protocol and
// app/signaling.py for the server side. This module only handles presence/GM/host
// attestation for now; establishing the actual WebRTC data channels (and the
// relay-fallback path) is M6 in docs/PLAN.md and isn't wired up yet — the room table
// currently runs its object model locally in each tab rather than syncing it P2P.

export interface RoomInfo {
  slug: string;
  name: string;
  gameDefRef: string;
}

export interface Peer {
  peerId: string;
  name: string;
  isGM: boolean;
}

export type SignalingEvent =
  | { type: "welcome"; peerId: string; hostPeerId: string | null; gmPeerId: string | null; roomInfo: RoomInfo }
  | { type: "you-are-host"; snapshot: unknown }
  | { type: "peer-joined"; peerId: string; name: string; isGM: boolean }
  | { type: "peer-left"; peerId: string }
  | { type: "host-changed"; hostPeerId: string }
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

  close(): void {
    this.ws.close();
  }
}
