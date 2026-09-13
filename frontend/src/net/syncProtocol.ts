// The host-authoritative sync protocol from docs/NETWORKING.md, transport-agnostic by
// design (docs/PLAN.md's M6: "this milestone is transport-only, no message-shape
// changes" — meaning the protocol below was meant to be built first and stay identical
// whether it rides the WS-relay fallback or a real WebRTC data channel; see
// net/peerLink.ts for the PeerLink abstraction that lets it not care which).
//
// Two message families:
// - Request: a peer asks the host to do something (spawn, drag-and-drop, flip, ...).
//   The host is the only one that ever calls TableModel's id-allocating methods
//   (spawnCard/pickUpTop/drawTop) — see pileModel.ts's setPile()/loadSnapshot() for why.
// - Event: the host tells every peer (itself included, for one uniform code path) what
//   actually happened, as a complete resulting PileState they can apply directly.
//
// Redaction lives here, not in the renderer: per docs/ARCHITECTURE.md "Hiding a card"
// and NETWORKING.md's Trust model, a hidden card's true front must never even reach a
// non-owning peer, so HostTableSync computes a *different* event per recipient when a
// pile's top card is hidden, swapping its front for its back before sending — a
// redacted pile is indistinguishable from an ordinary face-down one to whoever receives
// it, the same way a physical secret is "secure" only because no one hands it around.
import { CardDef } from "../engine/card";
import { CardInstance, PileState, TableModel } from "../engine/pileModel";

export type TableRequest =
  | { type: "spawn"; def: CardDef; x: number; y: number }
  | { type: "pick-up-and-drop"; pileId: string; x: number; y: number; mergeRadius: number }
  | { type: "flip"; pileId: string }
  | { type: "toggle-hide"; pileId: string }
  | { type: "rotate-by"; pileId: string; deltaRadians: number }
  | { type: "set-rotation"; pileId: string; radians: number }
  | { type: "shuffle"; pileId: string }
  | { type: "draw-top"; pileId: string; offsetX: number; offsetY: number }
  | { type: "remove"; pileId: string }
  /** A coarse, throttled "here's roughly where I'm dragging this" update — purely
   * cosmetic, so other players see something moving during the gesture instead of it
   * teleporting on drop. Deliberately kept out of the touched/emitTouched machinery
   * below: it never touches the model (the drop is still what's authoritative — see
   * "pick-up-and-drop"), so there's nothing here for a late-joining peer to catch up
   * on, and no reason to hold up an actual state change behind it. */
  | { type: "drag-hint"; pileId: string; x: number; y: number };

export type TableEvent =
  | { type: "pile-upserted"; pile: PileState }
  | { type: "pile-removed"; pileId: string }
  | { type: "snapshot"; piles: PileState[] }
  | { type: "drag-hint"; pileId: string; x: number; y: number; byPeerId: string };

/** A pile as it should appear to `recipientPeerId` — unchanged unless the top card is
 * hidden from them, in which case its front is replaced by its back (and faceUp forced
 * false) so the payload itself carries no trace of the real content or even of the fact
 * that it's specially hidden, not just naturally face-down.
 *
 * Known limitation, not solved here: a newly-promoted host (see NETWORKING.md "Host
 * migration") resumes from the *previous* host's snapshot, which necessarily contains
 * unredacted truth — the old host had to know everything to redact correctly for
 * everyone else. So migration can reveal a secret to the new host that wasn't
 * previously theirs to see. This is an inherent consequence of one peer being
 * authoritative for everyone else's view (see docs/DECISIONS.md D3) rather than a gap
 * to patch here; avoiding it entirely would need per-owner encryption, which the
 * project's cooperating-players trust model deliberately does not build (see
 * NETWORKING.md "Trust model"). */
export function redactPileFor(pile: PileState, recipientPeerId: string): PileState {
  if (pile.cards.length === 0) return pile;
  const top = pile.cards[pile.cards.length - 1];
  if (top.hiddenBy === null || top.hiddenBy === recipientPeerId) return pile;

  const redactedTop: CardInstance = { def: { ...top.def, front: top.def.back }, faceUp: false, hiddenBy: null };
  return { ...pile, cards: [...pile.cards.slice(0, -1), redactedTop] };
}

export type Broadcast = (recipientPeerId: string, event: TableEvent) => void;

/** Runs on the host's browser: owns the canonical TableModel, applies every peer's (and
 * its own) requests to it, and broadcasts the outcome. */
export class HostTableSync {
  constructor(
    private model: TableModel,
    private broadcast: Broadcast,
    /** Every currently-connected peerId, host included — who a broadcast reaches. */
    private recipients: () => string[],
  ) {}

  /** `fromPeerId` is whoever asked for this — needed for toggle-hide (who's hiding it)
   * and to compute redaction on the resulting broadcast. */
  handleRequest(fromPeerId: string, req: TableRequest): void {
    if (req.type === "drag-hint") {
      // Relayed as-is to everyone *except* the dragger (who's already moving it
      // locally, with no round trip) — never touches the model, never goes through
      // emitTouched, so it can't be mistaken for (or delay) an actual state change.
      for (const recipient of this.recipients()) {
        if (recipient === fromPeerId) continue;
        this.broadcast(recipient, { type: "drag-hint", pileId: req.pileId, x: req.x, y: req.y, byPeerId: fromPeerId });
      }
      return;
    }

    const touched = new Set<string>();

    switch (req.type) {
      case "spawn": {
        const pile = this.model.spawnCard(req.def, req.x, req.y);
        touched.add(pile.id);
        break;
      }
      case "pick-up-and-drop": {
        const floating = this.model.pickUpTop(req.pileId);
        if (!floating) return; // the pile was already gone (a race with another request) — nothing to do
        const result = this.model.dropPile(floating, req.x, req.y, req.mergeRadius);
        touched.add(req.pileId).add(floating.id);
        touched.add(result.kind === "merged" ? result.targetId : result.pile.id);
        break;
      }
      case "flip":
        this.model.flip(req.pileId);
        touched.add(req.pileId);
        break;
      case "toggle-hide":
        this.model.toggleHide(req.pileId, fromPeerId);
        touched.add(req.pileId);
        break;
      case "rotate-by":
        this.model.rotateBy(req.pileId, req.deltaRadians);
        touched.add(req.pileId);
        break;
      case "set-rotation":
        this.model.setRotation(req.pileId, req.radians);
        touched.add(req.pileId);
        break;
      case "shuffle":
        // Resolved once, here, by the host — never by each peer independently — so
        // everyone ends up agreeing on the same order; see docs/GAME_DEFINITION.md
        // "Stack operations".
        this.model.shuffle(req.pileId);
        touched.add(req.pileId);
        break;
      case "draw-top": {
        const drawn = this.model.drawTop(req.pileId, req.offsetX, req.offsetY);
        touched.add(req.pileId);
        if (drawn) touched.add(drawn.id);
        break;
      }
      case "remove":
        this.model.removePile(req.pileId);
        touched.add(req.pileId);
        break;
    }

    this.emitTouched(touched);
  }

  private emitTouched(pileIds: Iterable<string>): void {
    for (const pileId of pileIds) {
      const pile = this.model.getPile(pileId);
      for (const recipient of this.recipients()) {
        this.broadcast(recipient, pile ? { type: "pile-upserted", pile: redactPileFor(pile, recipient) } : { type: "pile-removed", pileId });
      }
    }
  }

  /** The full current state, redacted per-recipient — for a newly-joined peer, or
   * re-sent after a shuffle/host-migration-adjacent event. */
  sendSnapshotTo(recipientPeerId: string): void {
    const piles = this.model.allPiles().map((p) => redactPileFor(p, recipientPeerId));
    this.broadcast(recipientPeerId, { type: "snapshot", piles });
  }
}

/** Runs on every non-host browser: mirrors whatever the host broadcasts into a local
 * TableModel (never mutated any other way — see pileModel.ts's setPile/loadSnapshot),
 * and turns UI-driven intent into requests sent to the host. */
export class PeerTableSync {
  constructor(private model: TableModel, private sendToHost: (req: TableRequest) => void) {}

  applyEvent(event: TableEvent): void {
    switch (event.type) {
      case "pile-upserted":
        this.model.setPile(event.pile);
        break;
      case "pile-removed":
        this.model.removePile(event.pileId);
        break;
      case "snapshot":
        this.model.loadSnapshot(event.piles);
        break;
      case "drag-hint":
        break; // cosmetic only — see TableEvent's doc comment; nothing to mirror into the model
    }
  }

  spawn(def: CardDef, x: number, y: number): void {
    this.sendToHost({ type: "spawn", def, x, y });
  }
  pickUpAndDrop(pileId: string, x: number, y: number, mergeRadius: number): void {
    this.sendToHost({ type: "pick-up-and-drop", pileId, x, y, mergeRadius });
  }
  flip(pileId: string): void {
    this.sendToHost({ type: "flip", pileId });
  }
  toggleHide(pileId: string): void {
    this.sendToHost({ type: "toggle-hide", pileId });
  }
  rotateBy(pileId: string, deltaRadians: number): void {
    this.sendToHost({ type: "rotate-by", pileId, deltaRadians });
  }
  setRotation(pileId: string, radians: number): void {
    this.sendToHost({ type: "set-rotation", pileId, radians });
  }
  shuffle(pileId: string): void {
    this.sendToHost({ type: "shuffle", pileId });
  }
  drawTop(pileId: string, offsetX: number, offsetY: number): void {
    this.sendToHost({ type: "draw-top", pileId, offsetX, offsetY });
  }
  remove(pileId: string): void {
    this.sendToHost({ type: "remove", pileId });
  }
  dragHint(pileId: string, x: number, y: number): void {
    this.sendToHost({ type: "drag-hint", pileId, x, y });
  }
}
