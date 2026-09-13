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

/** Render a card's current appearance: face-up shows the front, face-down the back —
 * except when hidden, which (in this single-tab sandbox, ahead of the P2P sync in M6)
 * always shows you the front plus an eye badge, since there's no "other player" to hide
 * it from yet. Once M6 lands, only the hider's own client would take this branch; every
 * other peer would render the back regardless of hidden/faceUp state — see
 * docs/ARCHITECTURE.md "Hiding a card". */
export function renderCard(container: Container, def: CardDef, faceUp: boolean, hidden: boolean, pileCount: number): void {
  const badge = pileCount > 1 ? String(pileCount) : undefined;
  if (hidden) {
    drawFace(container, def.front, "\u{1F441}"); // eye
  } else if (faceUp) {
    drawFace(container, def.front, badge);
  } else {
    drawFace(container, def.back, badge);
  }
}
