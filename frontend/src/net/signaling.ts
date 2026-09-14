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
  tokenX: number | null;
  tokenY: number | null;
}

export type SignalingEvent =
  | { type: "connection-error"; message: string }
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
  private closed = false;
  private connectionErrorEmitted = false;
  private readonly logLabel: string;
  private connectionTimer: number | undefined;

  constructor(slug: string, token: string) {
    this.logLabel = `room=${slug}`;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/room/${slug}?token=${encodeURIComponent(token)}`;
    console.info("[rpg-tabletop][signaling] connecting", this.logLabel, `${proto}//${location.host}/ws/room/${slug}`);
    this.ws = new WebSocket(url);
    this.connectionTimer = window.setTimeout(() => {
      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.emitConnectionError("The table server did not respond in time.");
        this.ws.close();
      }
    }, 15000);
    this.ws.addEventListener("open", () => {
      this.clearConnectionTimer();
      console.info("[rpg-tabletop][signaling] connected", this.logLabel);
    });
    this.ws.addEventListener("error", () => {
      console.warn("[rpg-tabletop][signaling] socket error", this.logLabel);
      if (!this.closed) this.emitConnectionError("Unable to connect to the table server.");
    });
    this.ws.addEventListener("close", (event) => {
      this.clearConnectionTimer();
      console.warn("[rpg-tabletop][signaling] closed", this.logLabel, { code: event.code, reason: event.reason });
      if (!this.closed) {
        const detail = event.code ? ` (connection closed with code ${event.code})` : "";
        this.emitConnectionError(`The connection to the table server was lost${detail}.`);
      }
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data) as SignalingEvent;
        if (data.type === "welcome" || data.type === "you-are-host" || data.type === "host-changed" || data.type === "peer-joined" || data.type === "peer-left") {
          console.info("[rpg-tabletop][signaling] event", this.logLabel, data.type);
        }
        for (const listener of this.listeners) listener(data);
      } catch {
        this.emitConnectionError("The table server sent an invalid response.");
      }
    });
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer !== undefined) {
      window.clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
  }

  private emitConnectionError(message: string): void {
    if (this.connectionErrorEmitted) return;
    this.connectionErrorEmitted = true;
    for (const listener of this.listeners) listener({ type: "connection-error", message });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Update this peer's own color and/or eyes-closed state; either field is optional
   * (send only what changed). The server echoes the result back as a `presence-changed`
   * broadcast to everyone, sender included — see app/signaling.py's set-presence
   * handler — so callers should update their UI from that event, not optimistically. */
  setPresence(update: { color?: string; eyesClosed?: boolean }): void {
    this.send({ type: "set-presence", ...update });
  }

  setPlayerToken(peerId: string, x: number, y: number): void {
    this.send({ type: "set-player-token", peerId, x, y });
  }

  close(): void {
    this.closed = true;
    this.clearConnectionTimer();
    this.ws.close();
  }
}
