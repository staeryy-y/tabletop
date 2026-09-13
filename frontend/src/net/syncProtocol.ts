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
import { MatDef } from "../engine/mat";
import { CardInstance, MatState, PieceState, PileState, TableModel } from "../engine/pileModel";
import { PieceDef } from "../engine/piece";

export type TableRequest =
  | { type: "spawn"; def: CardDef; x: number; y: number }
  /** Spawns several cards as one already-stacked pile (TableModel.spawnStack) — e.g. a
   * game package's whole card set appearing as a single shufflable stack, not N
   * separate piles, when a room starts. */
  | { type: "spawn-stack"; defs: CardDef[]; x: number; y: number }
  | { type: "pick-up-and-drop"; pileId: string; x: number; y: number; mergeRadius: number }
  /** Moves an existing pile straight to (x, y) — TableModel.movePile's no-split,
   * no-merge semantics. Used for a multi-select group drag (engine/table.ts): every
   * selected pile gets one of these, keeping their relative positions, rather than
   * "pick-up-and-drop"'s single-card-off-a-stack behavior which doesn't make sense
   * applied to several piles being dragged together. */
  | { type: "move-pile"; pileId: string; x: number; y: number }
  /** "Collapse into a deck" for a multi-select group — combines every listed pile's
   * cards into one new pile at (x, y); see TableModel.collapseIntoStack. */
  | { type: "collapse-into-stack"; pileIds: string[]; x: number; y: number }
  | { type: "flip"; pileId: string }
  | { type: "toggle-hide"; pileId: string }
  | { type: "rotate-by"; pileId: string; deltaRadians: number }
  | { type: "set-rotation"; pileId: string; radians: number }
  | { type: "shuffle"; pileId: string }
  | { type: "draw-top"; pileId: string; offsetX: number; offsetY: number }
  | { type: "remove"; pileId: string }
  /** Spawn a standalone Piece (TableModel.spawnPiece) — see engine/pileModel.ts's
   * PieceState doc comment for how/why this is a wholly separate family of table
   * object from Cards/Piles: no stacking, no flip, no hide, no merge-on-drop. */
  | { type: "spawn-piece"; def: PieceDef; x: number; y: number }
  /** A plain reposition — the *only* way a Piece ever changes position, since there's
   * no pick-up-and-drop equivalent for something that never merges (see
   * TableModel.movePiece). */
  | { type: "move-piece"; pieceId: string; x: number; y: number }
  | { type: "rotate-piece-by"; pieceId: string; deltaRadians: number }
  | { type: "set-piece-rotation"; pieceId: string; radians: number }
  | { type: "remove-piece"; pieceId: string }
  /** Spawn a standalone Mat (TableModel.spawnMat) — see engine/mat.ts's doc comment
   * and docs/DECISIONS.md D26: a Mat is a Piece-shaped object that always renders
   * beneath every Card/Piece, and can optionally start locked. */
  | { type: "spawn-mat"; def: MatDef; x: number; y: number; locked?: boolean }
  /** Every mutating Mat request below is rejected outright by HostTableSync (a silent
   * no-op — see canModifyMat) if the mat is currently locked and the sender isn't the
   * room's GM (docs/DECISIONS.md D26: "locked mats can only be moved by the GM") —
   * unlike every other request in this file, which anyone can send per the
   * no-ownership-lock trust model (docs/NETWORKING.md "Trust model"). */
  | { type: "move-mat"; matId: string; x: number; y: number }
  | { type: "rotate-mat-by"; matId: string; deltaRadians: number }
  | { type: "set-mat-rotation"; matId: string; radians: number }
  | { type: "remove-mat"; matId: string }
  /** Locking/unlocking itself is *always* GM-only, regardless of the mat's current
   * state — otherwise any player could simply unlock a GM-locked mat and then move it,
   * making the lock meaningless. */
  | { type: "set-mat-locked"; matId: string; locked: boolean }
  /** A coarse, throttled "here's roughly where I'm dragging this" update — purely
   * cosmetic, so other players see something moving during the gesture instead of it
   * teleporting on drop. Deliberately kept out of the touched/emitTouched machinery
   * below: it never touches the model (the drop is still what's authoritative — see
   * "pick-up-and-drop"), so there's nothing here for a late-joining peer to catch up
   * on, and no reason to hold up an actual state change behind it. */
  | { type: "drag-hint"; pileId: string; x: number; y: number }
  /** The rotate-handle's equivalent of drag-hint — same cosmetic-only treatment, for
   * the same reason: the eventual "set-rotation" request is what's authoritative. */
  | { type: "rotate-hint"; pileId: string; radians: number }
  /** Where this peer's pointer currently is — not tied to a pile at all, unlike the two
   * hints above. Sent continuously (throttled) while connected, not just during a
   * gesture, so every other player's cursor is always visible ("to make it feel more
   * alive") rather than only appearing mid-drag. No pileId here since there's nothing
   * being manipulated; it's purely presence. */
  | { type: "cursor-hint"; x: number; y: number };

export type TableEvent =
  | { type: "pile-upserted"; pile: PileState }
  | { type: "pile-removed"; pileId: string }
  | { type: "piece-upserted"; piece: PieceState }
  | { type: "piece-removed"; pieceId: string }
  | { type: "mat-upserted"; mat: MatState }
  | { type: "mat-removed"; matId: string }
  /** `pieces`/`mats` are optional (not just possibly-empty) purely so every
   * pre-existing literal of this event (tests, older code) that only ever knew about
   * piles keeps type-checking unchanged — see PeerTableSync.applyEvent's `?? []` and
   * TableModel.loadSnapshot's matching default parameters. */
  | { type: "snapshot"; piles: PileState[]; pieces?: PieceState[]; mats?: MatState[] }
  | { type: "drag-hint"; pileId: string; x: number; y: number; byPeerId: string }
  | { type: "rotate-hint"; pileId: string; radians: number; byPeerId: string }
  | { type: "cursor-hint"; x: number; y: number; byPeerId: string };

/** A pile as it should appear to `recipientPeerId` — unchanged unless the top card is
 * hidden from them, in which case its front is replaced by its back (and faceUp forced
 * false) so the payload itself never carries the real content to anyone but the hider.
 *
 * `hiddenBy` itself, unlike the front content, is deliberately *kept* rather than
 * scrubbed (D25): everyone can see *that* a card is being secretly viewed and *by
 * whom* (engine/table.ts draws a colored eye badge from it, tinted with that player's
 * presence color), so the rest of the table knows when something's being kept from
 * them and by whom, without the content itself ever leaking. This is a narrower
 * privacy guarantee than the original "no trace at all" design — see D25 for why that
 * was walked back.
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

  const redactedTop: CardInstance = { def: { ...top.def, front: top.def.back }, faceUp: false, hiddenBy: top.hiddenBy };
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
    /** The room's current GM peerId, or null if unknown/there isn't one (e.g. an
     * anonymous room — D19) — used only to gate locked-Mat requests (D26). Defaults to
     * "no GM known" so every pre-existing HostTableSync construction site (tests
     * included) that never mentions Mats keeps working unchanged; with no GM known, a
     * locked mat simply can't be moved by anyone, which is the safe direction to fail
     * in rather than "everyone can." */
    private getGmPeerId: () => string | null = () => null,
  ) {}

  /** `fromPeerId` is whoever asked for this — needed for toggle-hide (who's hiding it)
   * and to compute redaction on the resulting broadcast. */
  handleRequest(fromPeerId: string, req: TableRequest): void {
    if (req.type === "drag-hint") {
      this.relayHint(fromPeerId, { type: "drag-hint", pileId: req.pileId, x: req.x, y: req.y, byPeerId: fromPeerId });
      return;
    }
    if (req.type === "rotate-hint") {
      this.relayHint(fromPeerId, { type: "rotate-hint", pileId: req.pileId, radians: req.radians, byPeerId: fromPeerId });
      return;
    }
    if (req.type === "cursor-hint") {
      this.relayHint(fromPeerId, { type: "cursor-hint", x: req.x, y: req.y, byPeerId: fromPeerId });
      return;
    }

    const touched = new Set<string>();
    const touchedPieces = new Set<string>();
    const touchedMats = new Set<string>();

    switch (req.type) {
      case "spawn": {
        const pile = this.model.spawnCard(req.def, req.x, req.y);
        touched.add(pile.id);
        break;
      }
      case "spawn-stack": {
        const pile = this.model.spawnStack(req.defs, req.x, req.y);
        if (pile) touched.add(pile.id);
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
      case "move-pile":
        this.model.movePile(req.pileId, req.x, req.y);
        touched.add(req.pileId);
        break;
      case "collapse-into-stack": {
        const pile = this.model.collapseIntoStack(req.pileIds, req.x, req.y);
        for (const id of req.pileIds) touched.add(id); // any that no longer exist emit pile-removed
        if (pile) touched.add(pile.id);
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
      case "spawn-piece": {
        const piece = this.model.spawnPiece(req.def, req.x, req.y);
        touchedPieces.add(piece.id);
        break;
      }
      case "move-piece":
        this.model.movePiece(req.pieceId, req.x, req.y);
        touchedPieces.add(req.pieceId);
        break;
      case "rotate-piece-by":
        this.model.rotatePieceBy(req.pieceId, req.deltaRadians);
        touchedPieces.add(req.pieceId);
        break;
      case "set-piece-rotation":
        this.model.setPieceRotation(req.pieceId, req.radians);
        touchedPieces.add(req.pieceId);
        break;
      case "remove-piece":
        this.model.removePiece(req.pieceId);
        touchedPieces.add(req.pieceId);
        break;
      case "spawn-mat": {
        const mat = this.model.spawnMat(req.def, req.x, req.y, req.locked ?? false);
        touchedMats.add(mat.id);
        break;
      }
      case "move-mat":
        if (!this.canModifyMat(req.matId, fromPeerId)) return;
        this.model.moveMat(req.matId, req.x, req.y);
        touchedMats.add(req.matId);
        break;
      case "rotate-mat-by":
        if (!this.canModifyMat(req.matId, fromPeerId)) return;
        this.model.rotateMatBy(req.matId, req.deltaRadians);
        touchedMats.add(req.matId);
        break;
      case "set-mat-rotation":
        if (!this.canModifyMat(req.matId, fromPeerId)) return;
        this.model.setMatRotation(req.matId, req.radians);
        touchedMats.add(req.matId);
        break;
      case "remove-mat":
        if (!this.canModifyMat(req.matId, fromPeerId)) return;
        this.model.removeMat(req.matId);
        touchedMats.add(req.matId);
        break;
      case "set-mat-locked":
        // Locking/unlocking is always GM-only, regardless of current state — see this
        // request's own doc comment in TableRequest.
        if (fromPeerId !== this.getGmPeerId()) return;
        this.model.setMatLocked(req.matId, req.locked);
        touchedMats.add(req.matId);
        break;
    }

    this.emitTouched(touched);
    this.emitTouchedPieces(touchedPieces);
    this.emitTouchedMats(touchedMats);
  }

  /** True unless the mat is both real and locked by someone other than the GM — see
   * this class's `getGmPeerId` doc comment. A mat that doesn't exist at all (a race
   * with something else removing it) is treated as *modifiable*: there's no lock to
   * enforce, and letting the request through is what lets emitTouchedMats correctly
   * report it as already-removed to the caller, the same way every other object type's
   * "mutate a nonexistent id" case works. */
  private canModifyMat(matId: string, fromPeerId: string): boolean {
    const mat = this.model.getMat(matId);
    if (!mat) return true;
    return !mat.locked || fromPeerId === this.getGmPeerId();
  }

  /** Relayed as-is to everyone *except* the sender (who's already showing it locally,
   * with no round trip) — never touches the model, never goes through emitTouched, so
   * it can't be mistaken for (or delay) an actual state change. Shared by drag-hint and
   * rotate-hint, the two purely-cosmetic TableEvent variants. */
  private relayHint(fromPeerId: string, event: TableEvent): void {
    for (const recipient of this.recipients()) {
      if (recipient === fromPeerId) continue;
      this.broadcast(recipient, event);
    }
  }

  private emitTouched(pileIds: Iterable<string>): void {
    for (const pileId of pileIds) {
      const pile = this.model.getPile(pileId);
      for (const recipient of this.recipients()) {
        this.broadcast(recipient, pile ? { type: "pile-upserted", pile: redactPileFor(pile, recipient) } : { type: "pile-removed", pileId });
      }
    }
  }

  /** Same idea as emitTouched, for Pieces — no per-recipient redaction needed, since a
   * Piece has no Hide concept at all (see PieceState's doc comment), so every recipient
   * gets the identical event. */
  private emitTouchedPieces(pieceIds: Iterable<string>): void {
    for (const pieceId of pieceIds) {
      const piece = this.model.getPiece(pieceId);
      for (const recipient of this.recipients()) {
        this.broadcast(recipient, piece ? { type: "piece-upserted", piece } : { type: "piece-removed", pieceId });
      }
    }
  }

  /** Same idea again, for Mats — no redaction (a Mat has no Hide concept either), so
   * every recipient gets the identical event, same as emitTouchedPieces. */
  private emitTouchedMats(matIds: Iterable<string>): void {
    for (const matId of matIds) {
      const mat = this.model.getMat(matId);
      for (const recipient of this.recipients()) {
        this.broadcast(recipient, mat ? { type: "mat-upserted", mat } : { type: "mat-removed", matId });
      }
    }
  }

  /** The full current state, redacted per-recipient — for a newly-joined peer, or
   * re-sent after a shuffle/host-migration-adjacent event. */
  sendSnapshotTo(recipientPeerId: string): void {
    const piles = this.model.allPiles().map((p) => redactPileFor(p, recipientPeerId));
    const pieces = this.model.allPieces();
    const mats = this.model.allMats();
    this.broadcast(recipientPeerId, { type: "snapshot", piles, pieces, mats });
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
      case "piece-upserted":
        this.model.setPiece(event.piece);
        break;
      case "piece-removed":
        this.model.removePiece(event.pieceId);
        break;
      case "mat-upserted":
        this.model.setMat(event.mat);
        break;
      case "mat-removed":
        this.model.removeMat(event.matId);
        break;
      case "snapshot":
        this.model.loadSnapshot(event.piles, event.pieces ?? [], event.mats ?? []);
        break;
      case "drag-hint":
      case "rotate-hint":
      case "cursor-hint":
        break; // cosmetic only — see TableEvent's doc comment; nothing to mirror into the model
    }
  }

  spawn(def: CardDef, x: number, y: number): void {
    this.sendToHost({ type: "spawn", def, x, y });
  }
  spawnStack(defs: CardDef[], x: number, y: number): void {
    this.sendToHost({ type: "spawn-stack", defs, x, y });
  }
  pickUpAndDrop(pileId: string, x: number, y: number, mergeRadius: number): void {
    this.sendToHost({ type: "pick-up-and-drop", pileId, x, y, mergeRadius });
  }
  movePile(pileId: string, x: number, y: number): void {
    this.sendToHost({ type: "move-pile", pileId, x, y });
  }
  collapseIntoStack(pileIds: string[], x: number, y: number): void {
    this.sendToHost({ type: "collapse-into-stack", pileIds, x, y });
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
  spawnPiece(def: PieceDef, x: number, y: number): void {
    this.sendToHost({ type: "spawn-piece", def, x, y });
  }
  movePiece(pieceId: string, x: number, y: number): void {
    this.sendToHost({ type: "move-piece", pieceId, x, y });
  }
  rotatePieceBy(pieceId: string, deltaRadians: number): void {
    this.sendToHost({ type: "rotate-piece-by", pieceId, deltaRadians });
  }
  setPieceRotation(pieceId: string, radians: number): void {
    this.sendToHost({ type: "set-piece-rotation", pieceId, radians });
  }
  removePiece(pieceId: string): void {
    this.sendToHost({ type: "remove-piece", pieceId });
  }
  spawnMat(def: MatDef, x: number, y: number, locked = false): void {
    this.sendToHost({ type: "spawn-mat", def, x, y, locked });
  }
  moveMat(matId: string, x: number, y: number): void {
    this.sendToHost({ type: "move-mat", matId, x, y });
  }
  rotateMatBy(matId: string, deltaRadians: number): void {
    this.sendToHost({ type: "rotate-mat-by", matId, deltaRadians });
  }
  setMatRotation(matId: string, radians: number): void {
    this.sendToHost({ type: "set-mat-rotation", matId, radians });
  }
  setMatLocked(matId: string, locked: boolean): void {
    this.sendToHost({ type: "set-mat-locked", matId, locked });
  }
  removeMat(matId: string): void {
    this.sendToHost({ type: "remove-mat", matId });
  }
  dragHint(pileId: string, x: number, y: number): void {
    this.sendToHost({ type: "drag-hint", pileId, x, y });
  }
  rotateHint(pileId: string, radians: number): void {
    this.sendToHost({ type: "rotate-hint", pileId, radians });
  }
  cursorHint(x: number, y: number): void {
    this.sendToHost({ type: "cursor-hint", x, y });
  }
}
