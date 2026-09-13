import { describe, expect, it } from "vitest";
import { SignalingEvent } from "./signaling";
import { RtcPeerConnectionFactory, WebRtcPeerLink } from "./webrtcPeerLink";

/** A fake RTCDataChannel — just enough of the real interface for WebRtcPeerLink to
 * drive: readyState gating send(), the three handlers it assigns, and test helpers
 * (open/receive) to simulate the browser doing the rest. */
class FakeDataChannel {
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closeCalled = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalled = true;
    this.readyState = "closed";
    this.onclose?.();
  }

  // --- test helpers, standing in for what a real browser would do ---
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(data: string): void {
    this.onmessage?.({ data });
  }
}

/** A fake RTCPeerConnection. Deliberately doesn't simulate real ICE/SDP negotiation —
 * it just records what WebRtcPeerLink calls and lets a test drive the rest (an incoming
 * offer/answer, an incoming data channel) exactly like the signaling layer or the
 * browser's own WebRTC stack would. */
class FakePeerConnection {
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  connectionState = "new";
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  closeCalled = false;
  addedCandidates: unknown[] = [];
  dataChannel: FakeDataChannel | null = null;

  createDataChannel(_label: string): FakeDataChannel {
    this.dataChannel = new FakeDataChannel();
    return this.dataChannel;
  }
  async createOffer(): Promise<unknown> {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer(): Promise<unknown> {
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(desc?: unknown): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: unknown): Promise<void> {
    this.remoteDescription = desc;
  }
  async addIceCandidate(candidate: unknown): Promise<void> {
    this.addedCandidates.push(candidate);
  }
  close(): void {
    this.closeCalled = true;
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }

  // test helper: the answerer side "receiving" the initiator's data channel
  simulateIncomingChannel(): FakeDataChannel {
    const channel = new FakeDataChannel();
    this.dataChannel = channel;
    this.ondatachannel?.({ channel });
    return channel;
  }
}

class FakeSignaling {
  sent: Record<string, unknown>[] = [];
  private listeners = new Set<(event: SignalingEvent) => void>();

  on(listener: (event: SignalingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }
  emit(event: SignalingEvent): void {
    for (const l of this.listeners) l(event);
  }
}

async function flush(): Promise<void> {
  // Several turns of the microtask queue — WebRtcPeerLink's signaling handlers are
  // async functions with a few awaits each.
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function setup(role: "initiator" | "answerer") {
  const signaling = new FakeSignaling();
  const pc = new FakePeerConnection();
  const makePc: RtcPeerConnectionFactory = () => pc as unknown as RTCPeerConnection;
  const link = new WebRtcPeerLink(signaling, "bob", role, makePc);
  return { signaling, pc, link };
}

describe("WebRtcPeerLink — initiator role", () => {
  it("creates a data channel and sends an offer addressed to the remote peer", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();

    expect(pc.dataChannel).not.toBeNull();
    expect(signaling.sent).toEqual([{ type: "offer", to: "bob", sdp: { type: "offer", sdp: "offer-sdp" } }]);
  });

  it("applies the answer once it arrives from the right remote peer", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();

    signaling.emit({ type: "answer", to: "me", from: "bob", sdp: { type: "answer", sdp: "answer-sdp" } });
    await flush();

    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
  });

  it("ignores an answer that claims to be from a different peer", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();

    signaling.emit({ type: "answer", to: "me", from: "mallory", sdp: { type: "answer", sdp: "evil" } });
    await flush();

    expect(pc.remoteDescription).toBeNull();
  });

  it("never answers an incoming offer (that's the answerer's job)", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();
    const offersSentBefore = signaling.sent.length;

    signaling.emit({ type: "offer", to: "me", from: "bob", sdp: { type: "offer", sdp: "x" } });
    await flush();

    expect(signaling.sent.length).toBe(offersSentBefore); // no answer was sent
  });
});

describe("WebRtcPeerLink — answerer role", () => {
  it("replies with an answer once an offer arrives from the right remote peer", async () => {
    const { signaling, pc } = setup("answerer");

    signaling.emit({ type: "offer", to: "me", from: "bob", sdp: { type: "offer", sdp: "offer-sdp" } });
    await flush();

    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "offer-sdp" });
    expect(signaling.sent).toEqual([{ type: "answer", to: "bob", sdp: { type: "answer", sdp: "answer-sdp" } }]);
  });

  it("ignores an offer from a different peer", async () => {
    const { signaling, pc } = setup("answerer");

    signaling.emit({ type: "offer", to: "me", from: "mallory", sdp: { type: "offer", sdp: "x" } });
    await flush();

    expect(pc.remoteDescription).toBeNull();
    expect(signaling.sent).toEqual([]);
  });

  it("exposes the incoming data channel once the browser fires ondatachannel", () => {
    const { pc } = setup("answerer");
    const channel = pc.simulateIncomingChannel();
    expect(channel.onopen).not.toBeNull(); // wired by wireChannel()
  });
});

describe("WebRtcPeerLink — ICE candidates", () => {
  it("sends a local ICE candidate to the remote peer as it's discovered", () => {
    const { signaling, pc } = setup("initiator");
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "c1" }) } });
    expect(signaling.sent).toContainEqual({ type: "ice", to: "bob", candidate: { candidate: "c1" } });
  });

  it("a null candidate (end-of-candidates) is not sent", () => {
    const { signaling, pc } = setup("initiator");
    pc.onicecandidate?.({ candidate: null });
    expect(signaling.sent.filter((m) => m.type === "ice")).toEqual([]);
  });

  it("buffers a remote ICE candidate until the remote description is set, then flushes it", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();

    signaling.emit({ type: "ice", to: "me", from: "bob", candidate: { foo: 1 } });
    await flush();
    expect(pc.addedCandidates).toEqual([]); // no remote description yet — buffered

    signaling.emit({ type: "answer", to: "me", from: "bob", sdp: { type: "answer", sdp: "x" } });
    await flush();

    expect(pc.addedCandidates).toEqual([{ foo: 1 }]);
  });

  it("adds a remote ICE candidate immediately once a remote description already exists", async () => {
    const { signaling, pc } = setup("initiator");
    await flush();
    signaling.emit({ type: "answer", to: "me", from: "bob", sdp: { type: "answer", sdp: "x" } });
    await flush();

    signaling.emit({ type: "ice", to: "me", from: "bob", candidate: { foo: 2 } });
    await flush();

    expect(pc.addedCandidates).toEqual([{ foo: 2 }]);
  });

  it("ignores an ICE candidate from a different peer", async () => {
    const { signaling, pc } = setup("initiator");
    signaling.emit({ type: "ice", to: "me", from: "mallory", candidate: { foo: 3 } });
    await flush();
    expect(pc.addedCandidates).toEqual([]);
  });
});

describe("WebRtcPeerLink — data channel send/receive", () => {
  it("queues send() calls until the channel opens, then flushes them in order", () => {
    const { link, pc } = setup("initiator");
    link.send("a");
    link.send("b");
    expect(pc.dataChannel!.sent).toEqual([]);

    pc.dataChannel!.open();

    expect(pc.dataChannel!.sent).toEqual([JSON.stringify("a"), JSON.stringify("b")]);
  });

  it("sends immediately once the channel is already open", () => {
    const { link, pc } = setup("initiator");
    pc.dataChannel!.open();
    link.send({ x: 1 });
    expect(pc.dataChannel!.sent).toEqual([JSON.stringify({ x: 1 })]);
  });

  it("ready() resolves once the channel opens", async () => {
    const { link, pc } = setup("initiator");
    pc.dataChannel!.open();
    await expect(link.ready()).resolves.toBeUndefined();
  });

  it("delivers parsed JSON messages received on the channel", () => {
    const { link, pc } = setup("initiator");
    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));

    pc.dataChannel!.receive(JSON.stringify({ hello: "world" }));

    expect(received).toEqual([{ hello: "world" }]);
  });

  it("silently drops a non-JSON message instead of throwing", () => {
    const { link, pc } = setup("initiator");
    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));

    expect(() => pc.dataChannel!.receive("not json{")).not.toThrow();
    expect(received).toEqual([]);
  });

  it("onMessage's returned unsubscribe stops further delivery to that handler only", () => {
    const { link, pc } = setup("initiator");
    const received: unknown[] = [];
    const unsubscribe = link.onMessage((m) => received.push(m));

    pc.dataChannel!.receive(JSON.stringify(1));
    unsubscribe();
    pc.dataChannel!.receive(JSON.stringify(2));

    expect(received).toEqual([1]);
  });
});

describe("WebRtcPeerLink — connection failure", () => {
  it("ready() rejects if the connection transitions to failed", async () => {
    const { link, pc } = setup("initiator");
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();

    await expect(link.ready()).rejects.toThrow(/failed/);
  });

  it("ready() rejects if the connection transitions to closed", async () => {
    const { link, pc } = setup("initiator");
    pc.connectionState = "closed";
    pc.onconnectionstatechange?.();

    await expect(link.ready()).rejects.toThrow(/closed/);
  });
});

describe("WebRtcPeerLink — close()", () => {
  it("closes the data channel and the peer connection", () => {
    const { link, pc } = setup("initiator");
    link.close();
    expect(pc.dataChannel!.closeCalled).toBe(true);
    expect(pc.closeCalled).toBe(true);
  });

  it("close() without a data channel yet (answerer, before any offer arrived) does not throw", () => {
    const { link } = setup("answerer");
    expect(() => link.close()).not.toThrow();
  });

  it("stops processing signaling events after close()", async () => {
    const { signaling, pc, link } = setup("initiator");
    await flush();
    link.close();

    signaling.emit({ type: "answer", to: "me", from: "bob", sdp: { type: "answer", sdp: "late" } });
    await flush();

    expect(pc.remoteDescription).toBeNull();
  });

  it("clears message handlers so nothing fires after close()", () => {
    const { link, pc } = setup("initiator");
    const received: unknown[] = [];
    link.onMessage((m) => received.push(m));
    link.close();

    // A stray message somehow still arriving on an already-closed channel shouldn't
    // reach application code.
    pc.dataChannel!.onmessage?.({ data: JSON.stringify("late") });
    expect(received).toEqual([]);
  });
});
