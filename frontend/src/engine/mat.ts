// A Mat's *content* — a flat playmat-style surface (a battle mat, a card-game
// playmat, a zone marker) that always renders beneath every Card/Piece on the table —
// see engine/table.ts's dedicated `matsLayer`, added to the world before any Card/Piece
// view ever is, so draw order alone (not per-frame sorting) keeps mats on the bottom
// regardless of what's spawned later. Otherwise as simple as a Piece (engine/piece.ts):
// an uploaded image or a short symbol, no flip, no hide, no stack/merge — plus one
// addition neither Card nor Piece has: it can be locked, in which case only the GM can
// move/rotate/remove it (see docs/DECISIONS.md D26 and pileModel.ts's MatState).
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";

export const MAT_WIDTH = 220;
export const MAT_HEIGHT = 160;

export interface MatDef {
  id: string;
  image?: string;
  symbol?: string;
}

// Same image-loading/caching/staleness-token approach as card.ts/piece.ts — see
// either's doc comments for the reasoning, unchanged here.
const imageTextureCache = new Map<string, Texture>();
const renderTokens = new WeakMap<Container, number>();

function bumpRenderToken(container: Container): number {
  const next = (renderTokens.get(container) ?? 0) + 1;
  renderTokens.set(container, next);
  return next;
}

function loadImageTexture(dataUri: string, onReady: (texture: Texture) => void): void {
  const cached = imageTextureCache.get(dataUri);
  if (cached) {
    onReady(cached);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const texture = Texture.from(img);
    imageTextureCache.set(dataUri, texture);
    onReady(texture);
  };
  img.onerror = () => {
    // A bad/corrupt data URI shouldn't crash the table — just leave the symbol/blank
    // fallback already drawn in place.
  };
  img.src = dataUri;
}

function drawSymbolFace(container: Container, symbol: string): void {
  const g = new Graphics();
  g.roundRect(-MAT_WIDTH / 2, -MAT_HEIGHT / 2, MAT_WIDTH, MAT_HEIGHT, 6);
  g.fill({ color: 0x3d4a3d });
  g.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(g);

  if (symbol) {
    const text = new Text({ text: symbol, style: { fontFamily: "monospace", fontSize: 28, fill: 0xffffff } });
    text.anchor.set(0.5);
    text.alpha = 0.85;
    container.addChild(text);
  }
}

/** A plain rectangle (not a card's rounded corners at card scale, not a piece's
 * circle) — visually distinct at a glance as "a surface you place things on," matching
 * the "flat mat" framing. */
function drawImageFace(container: Container, texture: Texture): void {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.width = MAT_WIDTH;
  sprite.height = MAT_HEIGHT;

  const mask = new Graphics();
  mask.roundRect(-MAT_WIDTH / 2, -MAT_HEIGHT / 2, MAT_WIDTH, MAT_HEIGHT, 6);
  mask.fill({ color: 0xffffff });
  container.addChild(mask);
  sprite.mask = mask;
  container.addChild(sprite);

  const border = new Graphics();
  border.roundRect(-MAT_WIDTH / 2, -MAT_HEIGHT / 2, MAT_WIDTH, MAT_HEIGHT, 6);
  border.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(border);
}

/** A small padlock badge, shown only while locked — the only visual cue that a mat
 * currently can't be moved/rotated/removed by anyone but the GM (see
 * docs/DECISIONS.md D26). */
function drawLockBadge(container: Container, locked: boolean): void {
  if (!locked) return;
  const g = new Graphics();
  g.circle(MAT_WIDTH / 2 - 14, -MAT_HEIGHT / 2 + 14, 11);
  g.fill({ color: 0x222222 });
  g.stroke({ width: 1, color: 0xffffff, alpha: 0.4 });
  container.addChild(g);
  const t = new Text({ text: "\u{1F512}", style: { fontFamily: "monospace", fontSize: 12 } });
  t.anchor.set(0.5);
  t.position.set(MAT_WIDTH / 2 - 14, -MAT_HEIGHT / 2 + 14);
  container.addChild(t);
}

/** Draw a mat's appearance (content + lock badge) into `container`. */
export function renderMat(container: Container, def: MatDef, locked: boolean): void {
  container.removeChildren();
  const token = bumpRenderToken(container);

  if (def.image) {
    // The plain symbol/blank fallback shows immediately while the image decodes
    // asynchronously, same as card.ts/piece.ts.
    drawSymbolFace(container, def.symbol ?? "");
    drawLockBadge(container, locked);
    loadImageTexture(def.image, (texture) => {
      if (renderTokens.get(container) !== token) return;
      container.removeChildren();
      drawImageFace(container, texture);
      drawLockBadge(container, locked);
    });
    return;
  }

  drawSymbolFace(container, def.symbol ?? "");
  drawLockBadge(container, locked);
}
