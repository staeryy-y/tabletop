import { describe, expect, it } from "vitest";
import { ChatDistributor, ChatMessage, ChatTransport, isChatSyncMessage, MAX_CHAT_HISTORY } from "./chatSync";
import { SideChannel } from "./roomConnection";

describe("isChatSyncMessage", () => {
  it("recognizes every chat: message type", () => {
    expect(isChatSyncMessage({ type: "chat:post", message: {} })).toBe(true);
    expect(isChatSyncMessage({ type: "chat:request-history" })).toBe(true);
    expect(isChatSyncMessage({ type: "chat:history", messages: [] })).toBe(true);
    expect(isChatSyncMessage({ type: "chat:message", message: {} })).toBe(true);
  });

  it("rejects table-sync and package-transfer message types", () => {
    expect(isChatSyncMessage({ type: "flip", pileId: "p1" })).toBe(false);
    expect(isChatSyncMessage({ type: "pkg:request" })).toBe(false);
    expect(isChatSyncMessage({ type: "request-snapshot" })).toBe(false);
  });

  it("rejects non-objects and null without throwing", () => {
    expect(isChatSyncMessage(null)).toBe(false);
    expect(isChatSyncMessage(undefined)).toBe(false);
    expect(isChatSyncMessage("chat:post")).toBe(false);
    expect(isChatSyncMessage(7)).toBe(false);
  });
});

class FakeTransport implements ChatTransport {
  isHost = false;
  channel: SideChannel | null = null;
  sentToHost: unknown[] = [];
  broadcasts: unknown[] = [];
  sentToPeers: { peerId: string; message: unknown }[] = [];

  addSideChannel(channel: SideChannel): void {
    this.channel = channel;
  }
  sendToHost(message: unknown): void {
    this.sentToHost.push(message);
  }
  sendToPeer(peerId: string, message: unknown): void {
    this.sentToPeers.push({ peerId, message });
  }
  broadcastToPeers(message: unknown): void {
    this.broadcasts.push(message);
  }

  sentTo(peerId: string): unknown[] {
    return this.sentToPeers.filter((m) => m.peerId === peerId).map((m) => m.message);
  }
}

const HELLO: ChatMessage = { author: "Alice", text: "hello" };
const HI: ChatMessage = { author: "Bob", text: "hi" };

describe("ChatDistributor — construction", () => {
  it("registers itself as the transport's side channel", () => {
    const transport = new FakeTransport();
    new ChatDistributor(transport, () => {});
    expect(transport.channel).not.toBeNull();
    expect(transport.channel!.isSideChannelMessage({ type: "chat:post", message: HELLO })).toBe(true);
  });
});

describe("ChatDistributor — posting as host", () => {
  it("records the message locally (onMessage) and broadcasts it to every peer, without contacting itself over the network", () => {
    const transport = new FakeTransport();
    transport.isHost = true;
    const received: ChatMessage[] = [];
    const distributor = new ChatDistributor(transport, (m) => received.push(m));

    distributor.post(HELLO);

    expect(received).toEqual([HELLO]);
    expect(transport.broadcasts).toEqual([{ type: "chat:message", message: HELLO }]);
    expect(transport.sentToHost).toEqual([]);
  });

  it("keeps every posted message in order for later history requests", () => {
    const transport = new FakeTransport();
    transport.isHost = true;
    const distributor = new ChatDistributor(transport, () => {});

    distributor.post(HELLO);
    distributor.post(HI);
    transport.channel!.handle("carol", { type: "chat:request-history" });

    expect(transport.sentTo("carol")).toEqual([{ type: "chat:history", messages: [HELLO, HI] }]);
  });

  it("caps history at MAX_CHAT_HISTORY, dropping the oldest message first", () => {
    const transport = new FakeTransport();
    transport.isHost = true;
    const distributor = new ChatDistributor(transport, () => {});

    for (let i = 0; i < MAX_CHAT_HISTORY + 10; i++) distributor.post({ author: "x", text: String(i) });
    transport.channel!.handle("carol", { type: "chat:request-history" });

    const history = (transport.sentTo("carol")[0] as { messages: ChatMessage[] }).messages;
    expect(history).toHaveLength(MAX_CHAT_HISTORY);
    expect(history[0].text).toBe("10"); // the first 10 fell off
    expect(history[history.length - 1].text).toBe(String(MAX_CHAT_HISTORY + 9));
  });
});

describe("ChatDistributor — posting as a peer", () => {
  it("sends a chat:post to the host instead of showing it locally right away", () => {
    const transport = new FakeTransport();
    transport.isHost = false;
    const received: ChatMessage[] = [];
    const distributor = new ChatDistributor(transport, (m) => received.push(m));

    distributor.post(HELLO);

    expect(transport.sentToHost).toEqual([{ type: "chat:post", message: HELLO }]);
    expect(received).toEqual([]); // not shown until the host's broadcast echoes back
  });

  it("shows a message once the host's broadcast (chat:message) arrives", () => {
    const transport = new FakeTransport();
    transport.isHost = false;
    const received: ChatMessage[] = [];
    const distributor = new ChatDistributor(transport, (m) => received.push(m));

    transport.channel!.handle("host", { type: "chat:message", message: HELLO });

    expect(received).toEqual([HELLO]);
  });

  it("requestHistoryIfNeeded() asks the host and applies every message in the reply, in order", () => {
    const transport = new FakeTransport();
    transport.isHost = false;
    const received: ChatMessage[] = [];
    const distributor = new ChatDistributor(transport, (m) => received.push(m));

    distributor.requestHistoryIfNeeded();
    expect(transport.sentToHost).toEqual([{ type: "chat:request-history" }]);

    transport.channel!.handle("host", { type: "chat:history", messages: [HELLO, HI] });
    expect(received).toEqual([HELLO, HI]);
  });

  it("requestHistoryIfNeeded() is a no-op once this client already knows about at least one message", () => {
    const transport = new FakeTransport();
    transport.isHost = false;
    const distributor = new ChatDistributor(transport, () => {});

    transport.channel!.handle("host", { type: "chat:message", message: HELLO });
    distributor.requestHistoryIfNeeded();

    expect(transport.sentToHost).toEqual([]);
  });

  it("a peer that received history or messages is ready to serve them onward if later promoted to host", () => {
    const transport = new FakeTransport();
    transport.isHost = false; // still a peer when it receives these
    const distributor = new ChatDistributor(transport, () => {});

    transport.channel!.handle("host", { type: "chat:history", messages: [HELLO] });
    transport.channel!.handle("host", { type: "chat:message", message: HI });

    // Now promoted: this same instance's transport.isHost flips, and someone asks it.
    transport.isHost = true;
    transport.channel!.handle("carol", { type: "chat:request-history" });

    expect(transport.sentTo("carol")).toEqual([{ type: "chat:history", messages: [HELLO, HI] }]);
  });

  it("ignores a chat:post that (topologically shouldn't but) reaches a non-host client", () => {
    const transport = new FakeTransport();
    transport.isHost = false;
    const received: ChatMessage[] = [];
    const distributor = new ChatDistributor(transport, (m) => received.push(m));
    void distributor;

    transport.channel!.handle("mallory", { type: "chat:post", message: HELLO });

    expect(received).toEqual([]);
    expect(transport.broadcasts).toEqual([]);
  });
});

describe("ChatDistributor — end to end: host relays a peer's post to everyone, including back to the host's own view", () => {
  it("converges", () => {
    const hostTransport = new FakeTransport();
    hostTransport.isHost = true;
    const hostReceived: ChatMessage[] = [];
    const hostDistributor = new ChatDistributor(hostTransport, (m) => hostReceived.push(m));

    // Simulate Alice (a peer) posting — her request reaches the host's side channel.
    hostTransport.channel!.handle("alice", { type: "chat:post", message: HELLO });

    expect(hostReceived).toEqual([HELLO]); // the host sees it too
    expect(hostTransport.broadcasts).toEqual([{ type: "chat:message", message: HELLO }]);
  });
});
