import { describe, expect, it, vi } from "vitest";
import { RelayPeerLink, SignalingLike } from "./relayPeerLink";
import { SignalingEvent } from "./signaling";

class FakeSignaling implements SignalingLike {
  sent: Record<string, unknown>[] = [];
  private listeners = new Set<(event: SignalingEvent) => void>();

  on(listener: (event: SignalingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  // test helper: simulate the server delivering a relay message from someone
  emit(event: SignalingEvent): void {
    for (const l of this.listeners) l(event);
  }
}

describe("RelayPeerLink", () => {
  it("send() wraps the message as a relay addressed to the remote peer", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");

    link.send({ hello: "world" });

    expect(signaling.sent).toEqual([{ type: "relay", to: "bob", payload: { hello: "world" } }]);
  });

  it("delivers a relay event from the right sender to registered handlers", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const received: unknown[] = [];
    link.onMessage((msg) => received.push(msg));

    signaling.emit({ type: "relay", from: "bob", payload: { hi: 1 } });

    expect(received).toEqual([{ hi: 1 }]);
  });

  it("ignores a relay event from a different peer", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const received: unknown[] = [];
    link.onMessage((msg) => received.push(msg));

    signaling.emit({ type: "relay", from: "carol", payload: { hi: 1 } });

    expect(received).toEqual([]);
  });

  it("ignores unrelated signaling event types entirely", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const received: unknown[] = [];
    link.onMessage((msg) => received.push(msg));

    signaling.emit({ type: "peer-left", peerId: "bob" });

    expect(received).toEqual([]);
  });

  it("delivers to every registered handler", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const a: unknown[] = [];
    const b: unknown[] = [];
    link.onMessage((msg) => a.push(msg));
    link.onMessage((msg) => b.push(msg));

    signaling.emit({ type: "relay", from: "bob", payload: "x" });

    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("onMessage's returned unsubscribe stops further delivery to that handler only", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const received: unknown[] = [];
    const unsubscribe = link.onMessage((msg) => received.push(msg));

    signaling.emit({ type: "relay", from: "bob", payload: 1 });
    unsubscribe();
    signaling.emit({ type: "relay", from: "bob", payload: 2 });

    expect(received).toEqual([1]);
  });

  it("close() stops listening to the underlying signaling connection", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    const received: unknown[] = [];
    link.onMessage((msg) => received.push(msg));

    link.close();
    signaling.emit({ type: "relay", from: "bob", payload: 1 });

    expect(received).toEqual([]);
  });

  it("close() on a link with no listeners does not throw", () => {
    const signaling = new FakeSignaling();
    const link = new RelayPeerLink(signaling, "bob");
    expect(() => link.close()).not.toThrow();
  });
});
