import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerLink } from "./peerLink";
import { PeerLinkWithFallback } from "./peerLinkWithFallback";

/** A bare PeerLink, standing in for RelayPeerLink in these tests — the fallback logic
 * doesn't care what the relay actually does, only that it's used correctly. */
class FakeLink implements PeerLink {
  sent: unknown[] = [];
  closed = false;
  private handlers = new Set<(message: unknown) => void>();

  send(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  close(): void {
    this.closed = true;
  }
  emit(message: unknown): void {
    for (const handler of this.handlers) handler(message);
  }
}

/** Stands in for WebRtcPeerLink: a PeerLink plus the `ready()` promise
 * PeerLinkWithFallback races against its timeout. Resolve/reject it manually from a
 * test to control exactly when (or whether) the "connection" succeeds. */
class FakeAttempt extends FakeLink {
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private promise: Promise<void>;

  constructor() {
    super();
    this.promise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }
  ready(): Promise<void> {
    return this.promise;
  }
  succeed(): void {
    this.resolveReady();
  }
  fail(err: Error = new Error("connection failed")): void {
    this.rejectReady(err);
  }
}

const TIMEOUT_MS = 1000;

function setup() {
  const webrtc = new FakeAttempt();
  const relay = new FakeLink();
  const makeWebRtc = vi.fn().mockReturnValue(webrtc);
  const makeRelay = vi.fn().mockReturnValue(relay);
  const signaling = {} as never;
  const link = new PeerLinkWithFallback(signaling, "bob", "initiator", TIMEOUT_MS, makeWebRtc, makeRelay);
  return { link, webrtc, relay, makeWebRtc, makeRelay, signaling };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PeerLinkWithFallback — happy path (WebRTC connects in time)", () => {
  it("passes signaling/remotePeerId/role through to the WebRTC factory", () => {
    const { makeWebRtc, signaling } = setup();
    expect(makeWebRtc).toHaveBeenCalledWith(signaling, "bob", "initiator");
  });

  it("sends through the WebRTC link once it's ready, and never constructs a relay", async () => {
    const { link, webrtc, makeRelay } = setup();
    webrtc.succeed();
    await Promise.resolve();
    await Promise.resolve();

    link.send({ hello: "world" });

    expect(webrtc.sent).toEqual([{ hello: "world" }]);
    expect(makeRelay).not.toHaveBeenCalled();
  });

  it("buffers sends made before WebRTC settles and flushes them in order once it does", async () => {
    const { link, webrtc } = setup();
    link.send("a");
    link.send("b");
    expect(webrtc.sent).toEqual([]); // not sent yet — still buffered

    webrtc.succeed();
    await Promise.resolve();
    await Promise.resolve();

    expect(webrtc.sent).toEqual(["a", "b"]);
  });

  it("forwards messages the WebRTC link receives, even before it's settled", () => {
    const { link, webrtc } = setup();
    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));

    webrtc.emit("early message");

    expect(received).toEqual(["early message"]);
  });

  it("becoming ready cancels the fallback timeout — advancing past it does nothing", async () => {
    const { link, webrtc, relay, makeRelay } = setup();
    webrtc.succeed();
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(TIMEOUT_MS * 10);

    expect(makeRelay).not.toHaveBeenCalled();
    expect(webrtc.closed).toBe(false);
    link.send("still webrtc");
    expect(webrtc.sent).toContain("still webrtc");
    expect(relay.sent).toEqual([]);
  });
});

describe("PeerLinkWithFallback — falling back to the relay", () => {
  it("falls back when the WebRTC attempt's ready() rejects", async () => {
    const { link, webrtc, relay, makeRelay } = setup();
    webrtc.fail();
    await Promise.resolve();
    await Promise.resolve();

    expect(webrtc.closed).toBe(true);
    expect(makeRelay).toHaveBeenCalledTimes(1);

    link.send("via relay");
    expect(relay.sent).toEqual(["via relay"]);
  });

  it("falls back when WebRTC doesn't settle before the timeout, even without an explicit failure", () => {
    const { link, webrtc, relay, makeRelay } = setup();

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(webrtc.closed).toBe(true);
    expect(makeRelay).toHaveBeenCalledTimes(1);
    link.send("via relay");
    expect(relay.sent).toEqual(["via relay"]);
  });

  it("buffers sends made before the fallback settles too", () => {
    const { link, relay } = setup();
    link.send("a");
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(relay.sent).toEqual(["a"]);
  });

  it("forwards messages from the relay once it's the active transport", () => {
    const { link, relay } = setup();
    vi.advanceTimersByTime(TIMEOUT_MS);
    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));

    relay.emit("from relay");

    expect(received).toEqual(["from relay"]);
  });

  it("a late ready()/fail() after the timeout has already triggered fallback changes nothing", async () => {
    const { link, webrtc, relay, makeRelay } = setup();
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(makeRelay).toHaveBeenCalledTimes(1);

    webrtc.succeed(); // late — the fallback timeout already fired
    await Promise.resolve();
    await Promise.resolve();

    expect(makeRelay).toHaveBeenCalledTimes(1); // still just the one fallback, not re-settled
    link.send("x");
    expect(relay.sent).toEqual(["x"]);
    expect(webrtc.sent).toEqual([]);
  });
});

describe("PeerLinkWithFallback — close()", () => {
  it("closes the active (WebRTC) transport and stops delivering further messages", async () => {
    const { link, webrtc } = setup();
    webrtc.succeed();
    await Promise.resolve();
    await Promise.resolve();

    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));
    link.close();

    expect(webrtc.closed).toBe(true);
    webrtc.emit("too late");
    expect(received).toEqual([]);
  });

  it("closes the active (relay) transport after a fallback", () => {
    const { link, relay } = setup();
    vi.advanceTimersByTime(TIMEOUT_MS);
    link.close();
    expect(relay.closed).toBe(true);
  });

  it("closing before anything settles closes the WebRTC attempt and never creates a relay", () => {
    const { link, webrtc, makeRelay } = setup();
    link.close();
    vi.advanceTimersByTime(TIMEOUT_MS * 10);

    expect(webrtc.closed).toBe(true);
    expect(makeRelay).not.toHaveBeenCalled();
  });

  it("a late ready()/fail() after close() does not resurrect a fallback or re-settle anything", async () => {
    const { link, webrtc, makeRelay } = setup();
    link.close();

    webrtc.fail();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(TIMEOUT_MS * 10);

    expect(makeRelay).not.toHaveBeenCalled();
  });
});
