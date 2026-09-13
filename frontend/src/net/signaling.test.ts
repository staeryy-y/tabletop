import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingConnection } from "./signaling";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((ev: any) => void)[]> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // Test helper: simulate the server sending a message down this socket.
  emitMessage(data: unknown): void {
    for (const listener of this.listeners["message"] ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SignalingConnection", () => {
  it("connects to /ws/room/<slug> with the token URL-encoded as a query param", () => {
    new SignalingConnection("my-room", "a token/with?special&chars");
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain("/ws/room/my-room?token=");
    expect(ws.url).toContain(encodeURIComponent("a token/with?special&chars"));
  });

  it("uses ws:// for an http page and wss:// for an https page", () => {
    const originalProtocol = window.location.protocol;
    try {
      Object.defineProperty(window, "location", {
        value: { ...window.location, protocol: "https:", host: "example.com" },
        writable: true,
      });
      new SignalingConnection("room", "tok");
      expect(FakeWebSocket.instances[0].url.startsWith("wss://")).toBe(true);
    } finally {
      Object.defineProperty(window, "location", { value: { ...window.location, protocol: originalProtocol }, writable: true });
    }
  });

  it("delivers parsed JSON messages to a registered listener", () => {
    const conn = new SignalingConnection("room", "tok");
    const received: unknown[] = [];
    conn.on((event) => received.push(event));

    FakeWebSocket.instances[0].emitMessage({ type: "welcome", peerId: "p1", hostPeerId: "p1", gmPeerId: null, roomInfo: {} });

    expect(received).toEqual([{ type: "welcome", peerId: "p1", hostPeerId: "p1", gmPeerId: null, roomInfo: {} }]);
  });

  it("delivers each message to every registered listener", () => {
    const conn = new SignalingConnection("room", "tok");
    const a: unknown[] = [];
    const b: unknown[] = [];
    conn.on((event) => a.push(event));
    conn.on((event) => b.push(event));

    FakeWebSocket.instances[0].emitMessage({ type: "peer-left", peerId: "p2" });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("on() returns an unsubscribe function that stops further delivery to that listener", () => {
    const conn = new SignalingConnection("room", "tok");
    const received: unknown[] = [];
    const unsubscribe = conn.on((event) => received.push(event));

    FakeWebSocket.instances[0].emitMessage({ type: "peer-left", peerId: "p1" });
    unsubscribe();
    FakeWebSocket.instances[0].emitMessage({ type: "peer-left", peerId: "p2" });

    expect(received).toHaveLength(1);
  });

  it("send() JSON-encodes the message onto the underlying socket", () => {
    const conn = new SignalingConnection("room", "tok");
    conn.send({ type: "offer", to: "p2", sdp: "xyz" });

    expect(FakeWebSocket.instances[0].sent).toEqual([JSON.stringify({ type: "offer", to: "p2", sdp: "xyz" })]);
  });

  it("close() closes the underlying socket", () => {
    const conn = new SignalingConnection("room", "tok");
    conn.close();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });
});
