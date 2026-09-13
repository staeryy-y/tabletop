import { describe, expect, it, vi } from "vitest";
import { createEmptyPackage, GamePackage } from "../packages/gamePackage";
import {
  chunkPackageJson,
  isPackageTransferMessage,
  PACKAGE_CHUNK_SIZE,
  PackageDistributor,
  PackageReassembler,
  PackageTransferMessage,
  PackageTransport,
} from "./packageTransfer";
import { SideChannel } from "./roomConnection";

describe("isPackageTransferMessage", () => {
  it("recognizes every pkg: message type", () => {
    expect(isPackageTransferMessage({ type: "pkg:request" })).toBe(true);
    expect(isPackageTransferMessage({ type: "pkg:begin", transferId: "t1", totalChunks: 1 })).toBe(true);
    expect(isPackageTransferMessage({ type: "pkg:chunk", transferId: "t1", index: 0, data: "x" })).toBe(true);
    expect(isPackageTransferMessage({ type: "pkg:end", transferId: "t1" })).toBe(true);
  });

  it("rejects table-sync and catch-up message types", () => {
    expect(isPackageTransferMessage({ type: "flip", pileId: "p1" })).toBe(false);
    expect(isPackageTransferMessage({ type: "pile-upserted", pile: {} })).toBe(false);
    expect(isPackageTransferMessage({ type: "request-snapshot" })).toBe(false);
  });

  it("rejects non-objects and null without throwing", () => {
    expect(isPackageTransferMessage(null)).toBe(false);
    expect(isPackageTransferMessage(undefined)).toBe(false);
    expect(isPackageTransferMessage("pkg:request")).toBe(false);
    expect(isPackageTransferMessage(42)).toBe(false);
  });
});

describe("chunkPackageJson", () => {
  it("produces begin, one chunk, then end for a short string", () => {
    const messages = chunkPackageJson("hello", "t1");
    expect(messages).toEqual([
      { type: "pkg:begin", transferId: "t1", totalChunks: 1 },
      { type: "pkg:chunk", transferId: "t1", index: 0, data: "hello" },
      { type: "pkg:end", transferId: "t1" },
    ]);
  });

  it("splits a string longer than PACKAGE_CHUNK_SIZE into multiple chunks in order", () => {
    const json = "a".repeat(PACKAGE_CHUNK_SIZE) + "b".repeat(PACKAGE_CHUNK_SIZE) + "c".repeat(10);
    const messages = chunkPackageJson(json, "t1");
    const chunkMessages = messages.filter((m) => m.type === "pkg:chunk") as Extract<PackageTransferMessage, { type: "pkg:chunk" }>[];

    expect(chunkMessages).toHaveLength(3);
    expect(chunkMessages.map((m) => m.index)).toEqual([0, 1, 2]);
    expect(chunkMessages[0].data).toBe("a".repeat(PACKAGE_CHUNK_SIZE));
    expect(chunkMessages[1].data).toBe("b".repeat(PACKAGE_CHUNK_SIZE));
    expect(chunkMessages[2].data).toBe("c".repeat(10));
    expect(messages[0]).toEqual({ type: "pkg:begin", transferId: "t1", totalChunks: 3 });
    expect(messages[messages.length - 1]).toEqual({ type: "pkg:end", transferId: "t1" });
  });

  it("handles an empty string as zero chunks", () => {
    const messages = chunkPackageJson("", "t1");
    expect(messages).toEqual([
      { type: "pkg:begin", transferId: "t1", totalChunks: 0 },
      { type: "pkg:end", transferId: "t1" },
    ]);
  });

  it("generates a distinct transferId per call when none is given", () => {
    const a = chunkPackageJson("x")[0] as Extract<PackageTransferMessage, { type: "pkg:begin" }>;
    const b = chunkPackageJson("x")[0] as Extract<PackageTransferMessage, { type: "pkg:begin" }>;
    expect(a.transferId).not.toBe(b.transferId);
  });
});

describe("PackageReassembler", () => {
  it("reassembles a package sent in chunk order", () => {
    const reassembler = new PackageReassembler();
    const json = JSON.stringify({ x: 1, arr: [1, 2, 3] });
    const messages = chunkPackageJson(json, "t1");

    const results = messages.map((m) => reassembler.handleMessage(m));

    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results[results.length - 1]).toBe(json);
  });

  it("reassembles correctly even if chunks arrive out of order", () => {
    const reassembler = new PackageReassembler();
    const json = "a".repeat(PACKAGE_CHUNK_SIZE) + "b".repeat(PACKAGE_CHUNK_SIZE) + "c".repeat(5);
    const messages = chunkPackageJson(json, "t1");
    const [begin, chunk0, chunk1, chunk2, end] = messages;

    reassembler.handleMessage(begin);
    reassembler.handleMessage(chunk2);
    reassembler.handleMessage(chunk0);
    reassembler.handleMessage(chunk1);
    const result = reassembler.handleMessage(end);

    expect(result).toBe(json);
  });

  it("keeps two concurrent transfers (different transferIds) independent", () => {
    const reassembler = new PackageReassembler();
    const messagesA = chunkPackageJson("AAAA", "a");
    const messagesB = chunkPackageJson("BBBB", "b");

    // interleaved
    reassembler.handleMessage(messagesA[0]);
    reassembler.handleMessage(messagesB[0]);
    reassembler.handleMessage(messagesB[1]);
    reassembler.handleMessage(messagesA[1]);
    const resultB = reassembler.handleMessage(messagesB[2]);
    const resultA = reassembler.handleMessage(messagesA[2]);

    expect(resultB).toBe("BBBB");
    expect(resultA).toBe("AAAA");
  });

  it("returns null (never completes) if a chunk never arrives, without throwing", () => {
    const reassembler = new PackageReassembler();
    const messages = chunkPackageJson("a".repeat(PACKAGE_CHUNK_SIZE) + "b".repeat(5), "t1");
    const [begin, , chunk1, end] = messages; // deliberately skip chunk0

    reassembler.handleMessage(begin);
    reassembler.handleMessage(chunk1);
    const result = reassembler.handleMessage(end);

    expect(result).toBeNull();
  });

  it("ignores a chunk for a transferId it never saw a pkg:begin for", () => {
    const reassembler = new PackageReassembler();
    expect(() => reassembler.handleMessage({ type: "pkg:chunk", transferId: "ghost", index: 0, data: "x" })).not.toThrow();
  });

  it("a pkg:end for an unknown transferId returns null rather than throwing", () => {
    const reassembler = new PackageReassembler();
    expect(reassembler.handleMessage({ type: "pkg:end", transferId: "ghost" })).toBeNull();
  });

  it("ignores a pkg:request message (that's PackageDistributor's concern, not the reassembler's)", () => {
    const reassembler = new PackageReassembler();
    expect(reassembler.handleMessage({ type: "pkg:request" })).toBeNull();
  });
});

class FakeTransport implements PackageTransport {
  channel: SideChannel | null = null;
  sentToHost: unknown[] = [];
  sentToPeers: { peerId: string; message: unknown }[] = [];

  setSideChannel(channel: SideChannel): void {
    this.channel = channel;
  }
  sendToHost(message: unknown): void {
    this.sentToHost.push(message);
  }
  sendToPeer(peerId: string, message: unknown): void {
    this.sentToPeers.push({ peerId, message });
  }

  /** Test helper: deliver every message of a chunked transfer to the distributor, as if
   * it arrived from `fromPeerId` over its link. */
  deliverPackage(fromPeerId: string, pkg: GamePackage): void {
    for (const message of chunkPackageJson(JSON.stringify(pkg))) this.channel!.handle(fromPeerId, message);
  }

  sentTo(peerId: string): unknown[] {
    return this.sentToPeers.filter((m) => m.peerId === peerId).map((m) => m.message);
  }
}

const SAMPLE_PACKAGE = createEmptyPackage("Sample");

describe("PackageDistributor", () => {
  it("registers itself as the transport's side channel on construction", () => {
    const transport = new FakeTransport();
    new PackageDistributor(transport, () => {});
    expect(transport.channel).not.toBeNull();
    expect(transport.channel!.isSideChannelMessage({ type: "pkg:request" })).toBe(true);
  });

  it("hasPackage() is false until setLocalPackage() is called", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});
    expect(distributor.hasPackage()).toBe(false);
    distributor.setLocalPackage(SAMPLE_PACKAGE);
    expect(distributor.hasPackage()).toBe(true);
  });

  it("requestFromHostIfNeeded() asks the host only when there's nothing local yet", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});

    distributor.requestFromHostIfNeeded();
    expect(transport.sentToHost).toEqual([{ type: "pkg:request" }]);

    distributor.setLocalPackage(SAMPLE_PACKAGE);
    distributor.requestFromHostIfNeeded();
    expect(transport.sentToHost).toEqual([{ type: "pkg:request" }]); // still just the one — no second request
  });

  it("answers a pkg:request immediately if a package is already set", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});
    distributor.setLocalPackage(SAMPLE_PACKAGE);

    transport.channel!.handle("alice", { type: "pkg:request" });

    const received = transport.sentTo("alice");
    expect(received[0]).toMatchObject({ type: "pkg:begin" });
    expect(received[received.length - 1]).toMatchObject({ type: "pkg:end" });
    const json = (received.filter((m) => (m as { type: string }).type === "pkg:chunk") as { data: string }[])
      .map((m) => m.data)
      .join("");
    expect(JSON.parse(json)).toEqual(SAMPLE_PACKAGE);
  });

  it("queues a pkg:request that arrives before any local package exists, and answers it once one is set", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});

    transport.channel!.handle("alice", { type: "pkg:request" });
    expect(transport.sentTo("alice")).toEqual([]); // nothing to send yet

    distributor.setLocalPackage(SAMPLE_PACKAGE);

    expect(transport.sentTo("alice").length).toBeGreaterThan(0);
  });

  it("answers each of several distinct requesters once a package becomes available", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});

    transport.channel!.handle("alice", { type: "pkg:request" });
    transport.channel!.handle("bob", { type: "pkg:request" });
    distributor.setLocalPackage(SAMPLE_PACKAGE);

    expect(transport.sentTo("alice").length).toBeGreaterThan(0);
    expect(transport.sentTo("bob").length).toBeGreaterThan(0);
  });

  it("reassembles a package received over the channel and reports it via onReceived", () => {
    const transport = new FakeTransport();
    const received: GamePackage[] = [];
    const distributor = new PackageDistributor(transport, (pkg) => received.push(pkg));

    transport.deliverPackage("host", SAMPLE_PACKAGE);

    expect(received).toEqual([SAMPLE_PACKAGE]);
  });

  it("is ready to redistribute a package it received, once it has one (e.g. after a host migration)", () => {
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});
    expect(distributor.hasPackage()).toBe(false);

    transport.deliverPackage("host", SAMPLE_PACKAGE);

    expect(distributor.hasPackage()).toBe(true);
    transport.channel!.handle("carol", { type: "pkg:request" });
    expect(transport.sentTo("carol").length).toBeGreaterThan(0);
  });

  it("logs but does not throw or call onReceived when the reassembled content isn't valid JSON", () => {
    const transport = new FakeTransport();
    const onReceived = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const distributor = new PackageDistributor(transport, onReceived);

    for (const message of chunkPackageJson("not valid json{")) transport.channel!.handle("host", message);

    expect(onReceived).not.toHaveBeenCalled();
    expect(distributor.hasPackage()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never sends anything to the host in response to its own outgoing request being answered by chunks", () => {
    // Sanity check on message direction: receiving chunks (as a peer) never triggers
    // sendToHost again — that would be a request-storm bug.
    const transport = new FakeTransport();
    const distributor = new PackageDistributor(transport, () => {});
    distributor.requestFromHostIfNeeded();

    transport.deliverPackage("host", SAMPLE_PACKAGE);

    expect(transport.sentToHost).toEqual([{ type: "pkg:request" }]);
  });
});
