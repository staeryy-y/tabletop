import { describe, expect, it } from "vitest";
import { CardDef } from "../engine/card";
import { TableModel } from "../engine/pileModel";
import { HostTableSync, PeerTableSync, TableEvent, redactPileFor } from "./syncProtocol";

const DEF_A: CardDef = { id: "a", front: { title: "Secret Role: Evil", color: 1 }, back: { title: "", color: 9 } };
const DEF_B: CardDef = { id: "b", front: { title: "B", color: 2 }, back: { title: "", color: 9 } };

// --- redactPileFor ---

describe("redactPileFor", () => {
  it("returns the pile unchanged when the top card isn't hidden", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    expect(redactPileFor(pile, "anyone")).toEqual(pile);
  });

  it("returns the true pile unchanged for the hider themselves", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "alice");
    expect(redactPileFor(pile, "alice")).toEqual(pile);
  });

  it("replaces the front with the back, and forces faceUp false, for anyone else", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.flip(pile.id); // face up, to prove redaction overrides this too
    model.toggleHide(pile.id, "alice");

    const redacted = redactPileFor(pile, "bob");

    expect(redacted.cards[0].faceUp).toBe(false);
    expect(redacted.cards[0].def.front).toEqual(DEF_A.back);
    expect(redacted.cards[0].hiddenBy).toBeNull(); // no trace it was specially hidden at all
  });

  it("never leaks the real title/text through the redacted def", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "alice");
    const redacted = redactPileFor(pile, "bob");
    expect(JSON.stringify(redacted)).not.toContain("Secret Role");
  });

  it("does not mutate the original pile", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "alice");
    redactPileFor(pile, "bob");
    expect(pile.cards[0].def).toBe(DEF_A); // untouched
  });

  it("handles an empty pile without throwing", () => {
    expect(() => redactPileFor({ id: "x", x: 0, y: 0, rotation: 0, cards: [] }, "anyone")).not.toThrow();
  });

  it("only the top card's hidden state matters — a buried card's stale hiddenBy is ignored", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "alice"); // A (currently on top) is hidden
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null }); // B is now on top, unhidden
    expect(redactPileFor(pile, "bob")).toEqual(pile); // nothing redacted — the visible (top) card isn't hidden
  });
});

// --- HostTableSync ---

interface Sent {
  recipient: string;
  event: TableEvent;
}

function makeHost(recipients: string[]) {
  const model = new TableModel();
  const sent: Sent[] = [];
  const sync = new HostTableSync(model, (recipient, event) => sent.push({ recipient, event }), () => recipients);
  return { model, sync, sent };
}

describe("HostTableSync — spawn", () => {
  it("broadcasts the new pile to every recipient", () => {
    const { sync, sent } = makeHost(["host", "alice"]);
    sync.handleRequest("host", { type: "spawn", def: DEF_A, x: 1, y: 2 });

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.recipient).sort()).toEqual(["alice", "host"]);
    for (const s of sent) {
      expect(s.event).toMatchObject({ type: "pile-upserted", pile: { x: 1, y: 2 } });
    }
  });
});

describe("HostTableSync — spawn-stack", () => {
  it("broadcasts one pile holding every card to every recipient", () => {
    const { sync, sent } = makeHost(["host", "alice"]);
    sync.handleRequest("host", { type: "spawn-stack", defs: [DEF_A, DEF_B], x: 5, y: 6 });

    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.event).toMatchObject({ type: "pile-upserted", pile: { x: 5, y: 6 } });
      if (s.event.type === "pile-upserted") expect(s.event.pile.cards).toHaveLength(2);
    }
  });

  it("an empty defs list spawns nothing and broadcasts nothing", () => {
    const { model, sync, sent } = makeHost(["host"]);
    sync.handleRequest("host", { type: "spawn-stack", defs: [], x: 0, y: 0 });

    expect(model.allPiles()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("HostTableSync — pick-up-and-drop", () => {
  it("placing (no merge) emits an upsert for the same pile id at the new position", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);

    sync.handleRequest("host", { type: "pick-up-and-drop", pileId: pile.id, x: 50, y: 50, mergeRadius: 10 });

    const upserts = sent.filter((s) => s.event.type === "pile-upserted");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].event).toMatchObject({ pile: { id: pile.id, x: 50, y: 50 } });
  });

  it("merging emits removal of the consumed pile and an upsert of the target", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const target = model.spawnCard(DEF_A, 100, 100);
    const source = model.spawnCard(DEF_B, 0, 0);

    sync.handleRequest("host", { type: "pick-up-and-drop", pileId: source.id, x: 101, y: 99, mergeRadius: 10 });

    const removed = sent.find((s) => s.event.type === "pile-removed");
    expect(removed?.event).toEqual({ type: "pile-removed", pileId: source.id });
    const upserted = sent.find((s) => s.event.type === "pile-upserted");
    expect(upserted?.event).toMatchObject({ pile: { id: target.id } });
    if (upserted?.event.type === "pile-upserted") {
      expect(upserted.event.pile.cards.map((c) => c.def.id)).toEqual(["a", "b"]);
    }
  });

  it("dragging just the top off a multi-card pile updates both the remainder and the new pile", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    sync.handleRequest("host", { type: "pick-up-and-drop", pileId: pile.id, x: 500, y: 500, mergeRadius: 10 });

    const upserts = sent.filter((s) => s.event.type === "pile-upserted").map((s) => s.event);
    const remainderEvt = upserts.find((e) => e.type === "pile-upserted" && e.pile.id === pile.id);
    expect(remainderEvt).toMatchObject({ pile: { cards: [{ def: DEF_A }] } });
    const newPileEvt = upserts.find((e) => e.type === "pile-upserted" && e.pile.id !== pile.id);
    expect(newPileEvt).toMatchObject({ pile: { x: 500, y: 500, cards: [{ def: DEF_B }] } });
  });

  it("a request for a pile that no longer exists (a race) is a silent no-op", () => {
    const { sync, sent } = makeHost(["host"]);
    sync.handleRequest("host", { type: "pick-up-and-drop", pileId: "ghost", x: 0, y: 0, mergeRadius: 10 });
    expect(sent).toEqual([]);
  });
});

describe("HostTableSync — flip/rotate/shuffle/draw/remove", () => {
  it("flip toggles the top card and broadcasts the pile", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    sync.handleRequest("host", { type: "flip", pileId: pile.id });
    expect(sent[0].event).toMatchObject({ type: "pile-upserted", pile: { cards: [{ faceUp: true }] } });
  });

  it("toggle-hide hides as the requesting peer, not some other identity", () => {
    const { model, sync } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    sync.handleRequest("alice", { type: "toggle-hide", pileId: pile.id });
    expect(model.topCard(pile.id)!.hiddenBy).toBe("alice");
  });

  it("rotate-by and set-rotation update rotation and broadcast", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    sync.handleRequest("host", { type: "rotate-by", pileId: pile.id, deltaRadians: 1 });
    expect(model.getPile(pile.id)!.rotation).toBeCloseTo(1);
    sync.handleRequest("host", { type: "set-rotation", pileId: pile.id, radians: 2 });
    expect(model.getPile(pile.id)!.rotation).toBeCloseTo(2);
    expect(sent.every((s) => s.event.type === "pile-upserted")).toBe(true);
  });

  it("shuffle is resolved once by the host and the resulting order is broadcast", () => {
    const { model, sync, sent } = makeHost(["host", "alice"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    sync.handleRequest("host", { type: "shuffle", pileId: pile.id });

    const events = sent.map((s) => s.event);
    expect(events.every((e) => e.type === "pile-upserted")).toBe(true);
    // every recipient was told the exact same resulting order
    const orders = events.map((e) => (e.type === "pile-upserted" ? e.pile.cards.map((c) => c.def.id) : []));
    expect(orders[0]).toEqual(orders[1]);
  });

  it("draw-top emits both the shrunken source and the newly drawn pile", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    pile.cards.push({ def: DEF_B, faceUp: false, hiddenBy: null });

    sync.handleRequest("host", { type: "draw-top", pileId: pile.id, offsetX: 10, offsetY: 0 });

    expect(sent).toHaveLength(2);
    expect(sent.some((s) => s.event.type === "pile-upserted" && s.event.pile.id === pile.id)).toBe(true);
    expect(sent.some((s) => s.event.type === "pile-upserted" && s.event.pile.id !== pile.id)).toBe(true);
  });

  it("draw-top on a 1-card pile is a no-op (drawTop itself refuses) but still reports the source's unchanged state", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    sync.handleRequest("host", { type: "draw-top", pileId: pile.id, offsetX: 10, offsetY: 0 });
    expect(sent).toHaveLength(1); // only the (unchanged) source, no second pile was created
  });

  it("remove deletes the pile and broadcasts pile-removed", () => {
    const { model, sync, sent } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    sync.handleRequest("host", { type: "remove", pileId: pile.id });
    expect(model.getPile(pile.id)).toBeUndefined();
    expect(sent).toEqual([{ recipient: "host", event: { type: "pile-removed", pileId: pile.id } }]);
  });

  it("a mutation request for a nonexistent pile doesn't throw, and correctly reports it as absent", () => {
    const { sync, sent } = makeHost(["host"]);
    for (const req of [
      { type: "flip" as const, pileId: "ghost" },
      { type: "toggle-hide" as const, pileId: "ghost" },
      { type: "rotate-by" as const, pileId: "ghost", deltaRadians: 1 },
      { type: "shuffle" as const, pileId: "ghost" },
    ]) {
      expect(() => sync.handleRequest("host", req)).not.toThrow();
    }
    // TableModel's own mutators are safe no-ops on a missing pile, but the sync layer
    // still touches that id and finds nothing there — reporting "removed" is the
    // correct (if slightly redundant) signal that this id doesn't exist, not a crash.
    expect(sent.every((s) => s.event.type === "pile-removed" && s.event.pileId === "ghost")).toBe(true);
  });
});

describe("HostTableSync — per-recipient redaction on broadcast", () => {
  it("the hider receives the true content; everyone else receives the redacted back", () => {
    const { model, sync, sent } = makeHost(["alice", "bob"]);
    const pile = model.spawnCard(DEF_A, 0, 0);

    sync.handleRequest("alice", { type: "toggle-hide", pileId: pile.id });

    const toAlice = sent.find((s) => s.recipient === "alice")!.event;
    const toBob = sent.find((s) => s.recipient === "bob")!.event;
    expect(toAlice).toMatchObject({ type: "pile-upserted", pile: { cards: [{ def: DEF_A, hiddenBy: "alice" }] } });
    expect(toBob.type).toBe("pile-upserted");
    if (toBob.type === "pile-upserted") {
      expect(toBob.pile.cards[0].def.front).toEqual(DEF_A.back);
      expect(toBob.pile.cards[0].hiddenBy).toBeNull();
    }
  });
});

describe("HostTableSync — drag-hint (cosmetic, never touches the model)", () => {
  it("relays the hint to every recipient except the dragger, tagged with who's dragging", () => {
    const { sync, sent } = makeHost(["host", "alice", "bob"]);

    sync.handleRequest("alice", { type: "drag-hint", pileId: "p1", x: 10, y: 20 });

    expect(sent).toEqual([
      { recipient: "host", event: { type: "drag-hint", pileId: "p1", x: 10, y: 20, byPeerId: "alice" } },
      { recipient: "bob", event: { type: "drag-hint", pileId: "p1", x: 10, y: 20, byPeerId: "alice" } },
    ]);
  });

  it("reaches the host itself when a peer drags, since the host is just another viewer", () => {
    const { sync, sent } = makeHost(["host", "alice"]);
    sync.handleRequest("alice", { type: "drag-hint", pileId: "p1", x: 0, y: 0 });
    expect(sent.some((s) => s.recipient === "host")).toBe(true);
  });

  it("reaches every peer when the host itself drags", () => {
    const { sync, sent } = makeHost(["host", "alice", "bob"]);
    sync.handleRequest("host", { type: "drag-hint", pileId: "p1", x: 0, y: 0 });
    expect(sent.map((s) => s.recipient).sort()).toEqual(["alice", "bob"]);
  });

  it("never mutates the model — a pile that doesn't even exist produces no error", () => {
    const { model, sync } = makeHost(["host"]);
    expect(() => sync.handleRequest("alice", { type: "drag-hint", pileId: "ghost", x: 1, y: 1 })).not.toThrow();
    expect(model.getPile("ghost")).toBeUndefined();
  });

  it("does not affect the real pile's position in the model at all", () => {
    const { model, sync } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 5, 5);

    sync.handleRequest("host", { type: "drag-hint", pileId: pile.id, x: 999, y: 999 });

    expect(model.getPile(pile.id)).toMatchObject({ x: 5, y: 5 });
  });
});

describe("HostTableSync — rotate-hint (cosmetic, never touches the model)", () => {
  it("relays the hint to every recipient except the rotator, tagged with who's rotating", () => {
    const { sync, sent } = makeHost(["host", "alice", "bob"]);

    sync.handleRequest("alice", { type: "rotate-hint", pileId: "p1", radians: 1.5 });

    expect(sent).toEqual([
      { recipient: "host", event: { type: "rotate-hint", pileId: "p1", radians: 1.5, byPeerId: "alice" } },
      { recipient: "bob", event: { type: "rotate-hint", pileId: "p1", radians: 1.5, byPeerId: "alice" } },
    ]);
  });

  it("does not affect the real pile's rotation in the model at all", () => {
    const { model, sync } = makeHost(["host"]);
    const pile = model.spawnCard(DEF_A, 5, 5);

    sync.handleRequest("host", { type: "rotate-hint", pileId: pile.id, radians: 3 });

    expect(model.getPile(pile.id)).toMatchObject({ rotation: 0 });
  });
});

describe("HostTableSync — cursor-hint (cosmetic presence, not tied to any pile)", () => {
  it("relays the hint to every recipient except the sender, tagged with who it's from", () => {
    const { sync, sent } = makeHost(["host", "alice", "bob"]);

    sync.handleRequest("alice", { type: "cursor-hint", x: 10, y: 20 });

    expect(sent).toEqual([
      { recipient: "host", event: { type: "cursor-hint", x: 10, y: 20, byPeerId: "alice" } },
      { recipient: "bob", event: { type: "cursor-hint", x: 10, y: 20, byPeerId: "alice" } },
    ]);
  });

  it("touches nothing in the model — there's no pile involved at all", () => {
    const { model, sync } = makeHost(["host"]);
    expect(() => sync.handleRequest("host", { type: "cursor-hint", x: 1, y: 1 })).not.toThrow();
    expect(model.allPiles()).toHaveLength(0);
  });
});

describe("HostTableSync — sendSnapshotTo", () => {
  it("sends every current pile, redacted for that recipient", () => {
    const { model, sync, sent } = makeHost(["alice", "bob"]);
    const pile = model.spawnCard(DEF_A, 0, 0);
    model.toggleHide(pile.id, "alice");

    sync.sendSnapshotTo("bob");

    expect(sent).toHaveLength(1);
    const event = sent[0].event;
    expect(event.type).toBe("snapshot");
    if (event.type === "snapshot") {
      expect(event.piles[0].cards[0].def.front).toEqual(DEF_A.back); // redacted for bob
    }
  });

  it("sends nothing to anyone except the requested recipient", () => {
    const { sync, sent } = makeHost(["alice", "bob"]);
    sync.sendSnapshotTo("alice");
    expect(sent.every((s) => s.recipient === "alice")).toBe(true);
  });
});

// --- PeerTableSync ---

describe("PeerTableSync — applying host events", () => {
  it("pile-upserted upserts into the local model", () => {
    const model = new TableModel();
    const sync = new PeerTableSync(model, () => {});
    const pile = { id: "p1", x: 1, y: 2, rotation: 0, cards: [{ def: DEF_A, faceUp: false, hiddenBy: null }] };

    sync.applyEvent({ type: "pile-upserted", pile });

    expect(model.getPile("p1")).toEqual(pile);
  });

  it("pile-removed deletes from the local model", () => {
    const model = new TableModel();
    model.setPile({ id: "p1", x: 0, y: 0, rotation: 0, cards: [] });
    const sync = new PeerTableSync(model, () => {});

    sync.applyEvent({ type: "pile-removed", pileId: "p1" });

    expect(model.getPile("p1")).toBeUndefined();
  });

  it("snapshot replaces the entire local model", () => {
    const model = new TableModel();
    model.setPile({ id: "stale", x: 0, y: 0, rotation: 0, cards: [] });
    const sync = new PeerTableSync(model, () => {});
    const fresh = { id: "fresh", x: 5, y: 5, rotation: 0, cards: [] };

    sync.applyEvent({ type: "snapshot", piles: [fresh] });

    expect(model.getPile("stale")).toBeUndefined();
    expect(model.getPile("fresh")).toEqual(fresh);
  });

  it("drag-hint is a no-op on the local model — it's cosmetic only", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 5, 5);
    const sync = new PeerTableSync(model, () => {});

    sync.applyEvent({ type: "drag-hint", pileId: pile.id, x: 999, y: 999, byPeerId: "alice" });

    expect(model.getPile(pile.id)).toMatchObject({ x: 5, y: 5 });
  });

  it("rotate-hint is a no-op on the local model — it's cosmetic only", () => {
    const model = new TableModel();
    const pile = model.spawnCard(DEF_A, 5, 5);
    const sync = new PeerTableSync(model, () => {});

    sync.applyEvent({ type: "rotate-hint", pileId: pile.id, radians: 2, byPeerId: "alice" });

    expect(model.getPile(pile.id)).toMatchObject({ rotation: 0 });
  });
});

describe("PeerTableSync — sending requests to the host", () => {
  function makePeer() {
    const requests: unknown[] = [];
    const sync = new PeerTableSync(new TableModel(), (req) => requests.push(req));
    return { sync, requests };
  }

  it("spawn", () => {
    const { sync, requests } = makePeer();
    sync.spawn(DEF_A, 1, 2);
    expect(requests).toEqual([{ type: "spawn", def: DEF_A, x: 1, y: 2 }]);
  });

  it("spawnStack", () => {
    const { sync, requests } = makePeer();
    sync.spawnStack([DEF_A, DEF_B], 3, 4);
    expect(requests).toEqual([{ type: "spawn-stack", defs: [DEF_A, DEF_B], x: 3, y: 4 }]);
  });

  it("pickUpAndDrop", () => {
    const { sync, requests } = makePeer();
    sync.pickUpAndDrop("p1", 10, 20, 5);
    expect(requests).toEqual([{ type: "pick-up-and-drop", pileId: "p1", x: 10, y: 20, mergeRadius: 5 }]);
  });

  it("flip, toggleHide, shuffle, remove", () => {
    const { sync, requests } = makePeer();
    sync.flip("p1");
    sync.toggleHide("p1");
    sync.shuffle("p1");
    sync.remove("p1");
    expect(requests).toEqual([
      { type: "flip", pileId: "p1" },
      { type: "toggle-hide", pileId: "p1" },
      { type: "shuffle", pileId: "p1" },
      { type: "remove", pileId: "p1" },
    ]);
  });

  it("rotateBy, setRotation, drawTop", () => {
    const { sync, requests } = makePeer();
    sync.rotateBy("p1", 0.5);
    sync.setRotation("p1", 1.2);
    sync.drawTop("p1", 10, 0);
    expect(requests).toEqual([
      { type: "rotate-by", pileId: "p1", deltaRadians: 0.5 },
      { type: "set-rotation", pileId: "p1", radians: 1.2 },
      { type: "draw-top", pileId: "p1", offsetX: 10, offsetY: 0 },
    ]);
  });

  it("dragHint", () => {
    const { sync, requests } = makePeer();
    sync.dragHint("p1", 3, 4);
    expect(requests).toEqual([{ type: "drag-hint", pileId: "p1", x: 3, y: 4 }]);
  });

  it("rotateHint", () => {
    const { sync, requests } = makePeer();
    sync.rotateHint("p1", 2.1);
    expect(requests).toEqual([{ type: "rotate-hint", pileId: "p1", radians: 2.1 }]);
  });

  it("cursorHint", () => {
    const { sync, requests } = makePeer();
    sync.cursorHint(5, 6);
    expect(requests).toEqual([{ type: "cursor-hint", x: 5, y: 6 }]);
  });
});

describe("end-to-end: host and peer converge on the same state through the protocol", () => {
  it("a spawn, a drag-merge, and a shuffle all leave the peer's mirror identical to the host's model", () => {
    const hostModel = new TableModel();
    const peerModel = new TableModel();
    const peerSync = new PeerTableSync(peerModel, (req) => hostSync.handleRequest("peer", req));
    const hostSync = new HostTableSync(hostModel, (_recipient, event) => peerSync.applyEvent(event), () => ["peer"]);

    peerSync.spawn(DEF_A, 0, 0);
    const [hostPile] = hostModel.allPiles();
    peerSync.spawn(DEF_B, 100, 0);

    // drag DEF_A's pile onto DEF_B's pile from the peer's side
    const targetPile = hostModel.allPiles().find((p) => p.cards[0].def.id === "b")!;
    peerSync.pickUpAndDrop(hostPile.id, targetPile.x + 1, targetPile.y, 10);
    peerSync.shuffle(targetPile.id);

    expect(peerModel.allPiles()).toEqual(hostModel.allPiles());
  });
});
