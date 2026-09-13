// A Card's *content* — what's printed on it. Rendering/interaction lives in table.ts;
// this module just knows how to draw a face into a PixiJS container. See
// docs/GAME_DEFINITION.md "Cards are the workhorse" — a card is just a front/back pair,
// nothing more; decks/stacks are an emergent runtime behavior (see Pile in table.ts),
// not authored here.
import { Container, Graphics, Text } from "pixi.js";

export const CARD_WIDTH = 90;
export const CARD_HEIGHT = 126;

export interface CardFace {
  title: string;
  color: number;
  text?: string;
}

export interface CardDef {
  id: string;
  front: CardFace;
  back: CardFace;
}

export interface CardDisplay {
  face: CardFace;
  eyeBadge: boolean;
}

/** The pure decision behind a card's appearance — no PixiJS involved, so this is
 * exhaustively unit-testable on its own. `hiddenBy` is the peerId of whoever hid the
 * card, or null if no one has. For the hider, hidden takes precedence over faceUp — a
 * hidden card always shows *them* its front (that's the point of hiding it — see
 * docs/ARCHITECTURE.md "Hiding a card"), regardless of the card's own flip state. Every
 * other viewer sees the back, also regardless of faceUp, exactly as if it were face-down
 * — this is what makes Hide correct once state is actually synced across peers (M6):
 * the host only ever sends the true front content to the hider (see
 * net/syncProtocol.ts's redaction), so a non-owner's client typically never even
 * *has* the real front to accidentally render — this function just encodes the same
 * rule for the hider's own client, which does have it. */
export function resolveDisplay(def: CardDef, faceUp: boolean, hiddenBy: string | null, viewerPeerId: string): CardDisplay {
  if (hiddenBy !== null) {
    return hiddenBy === viewerPeerId ? { face: def.front, eyeBadge: true } : { face: def.back, eyeBadge: false };
  }
  return { face: faceUp ? def.front : def.back, eyeBadge: false };
}

function drawFace(container: Container, face: CardFace, badge?: string): void {
  container.removeChildren();

  const g = new Graphics();
  g.roundRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
  g.fill({ color: face.color });
  g.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(g);

  const title = new Text({
    text: face.title,
    style: { fontFamily: "monospace", fontSize: 13, fill: 0x1a1a1a, wordWrap: true, wordWrapWidth: CARD_WIDTH - 12, align: "center" },
  });
  title.anchor.set(0.5, 0);
  title.position.set(0, -CARD_HEIGHT / 2 + 10);
  container.addChild(title);

  if (face.text) {
    const body = new Text({
      text: face.text,
      style: { fontFamily: "monospace", fontSize: 9, fill: 0x1a1a1a, wordWrap: true, wordWrapWidth: CARD_WIDTH - 14, align: "center" },
    });
    body.anchor.set(0.5, 0);
    body.position.set(0, -6);
    container.addChild(body);
  }

  if (badge) {
    const b = new Graphics();
    b.circle(CARD_WIDTH / 2 - 12, -CARD_HEIGHT / 2 + 12, 10);
    b.fill({ color: 0x222222 });
    container.addChild(b);
    const bt = new Text({ text: badge, style: { fontFamily: "monospace", fontSize: 10, fill: 0xffffff } });
    bt.anchor.set(0.5);
    bt.position.set(CARD_WIDTH / 2 - 12, -CARD_HEIGHT / 2 + 12);
    container.addChild(bt);
  }
}

/** Draw a card's current appearance into `container`, per resolveDisplay() above. */
export function renderCard(container: Container, def: CardDef, faceUp: boolean, hiddenBy: string | null, viewerPeerId: string, pileCount: number): void {
  const { face, eyeBadge } = resolveDisplay(def, faceUp, hiddenBy, viewerPeerId);
  const badge = eyeBadge ? "\u{1F441}" : pileCount > 1 ? String(pileCount) : undefined;
  drawFace(container, face, badge);
}
