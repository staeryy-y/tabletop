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
 * exhaustively unit-testable on its own. Hidden takes precedence over faceUp: a hidden
 * card always shows you its front (that's the point of hiding it — see
 * docs/ARCHITECTURE.md "Hiding a card"), regardless of whether it's "face up" per its
 * own flip state. In this single-tab sandbox (ahead of the P2P sync in M6) there's no
 * "other player" to show the back to instead; once that lands, only the hider's own
 * client would take the `hidden` branch at all. */
export function resolveDisplay(def: CardDef, faceUp: boolean, hidden: boolean): CardDisplay {
  if (hidden) return { face: def.front, eyeBadge: true };
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
export function renderCard(container: Container, def: CardDef, faceUp: boolean, hidden: boolean, pileCount: number): void {
  const { face, eyeBadge } = resolveDisplay(def, faceUp, hidden);
  const badge = eyeBadge ? "\u{1F441}" : pileCount > 1 ? String(pileCount) : undefined;
  drawFace(container, face, badge);
}
