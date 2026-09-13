// A Piece's *content* — what it looks like on the table. See docs/GAME_DEFINITION.md
// "Pieces: board tiles, terrain, and anything else you place rather than stack": unlike
// a Card (card.ts), a Piece has no front/back pair to flip between and no Hide concept
// — it's just one fixed appearance (an uploaded image, or a short text/emoji symbol),
// always visible to everyone, everywhere. Rendering/interaction logic lives in
// table.ts, same split as card.ts/pileModel.ts.
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";

export const PIECE_SIZE = 64;

export interface PieceDef {
  id: string;
  /** Either an uploaded image (data: URI — see packages/gamePackage.ts's PieceEntry)
   * or a short symbol (an emoji or a couple of unicode characters) — never both; see
   * gamePackage.ts's validatePackage for that constraint. */
  image?: string;
  symbol?: string;
}

// Reuse the same image-loading/caching/staleness-token approach card.ts already built
// — same reasoning applies unchanged (see card.ts's own comments): cache by data URI so
// a piece set reusing one image doesn't redecode it per instance, and guard against a
// slow-loading image applying itself to a container that's since been redrawn for
// something else.
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
    // Leave whatever fallback is already drawn — a bad/corrupt data URI shouldn't
    // crash the table, just mean this one piece never gets its art.
  };
  img.src = dataUri;
}

function drawSymbolFace(container: Container, symbol: string): void {
  const g = new Graphics();
  g.circle(0, 0, PIECE_SIZE / 2);
  g.fill({ color: 0x6b6f7a });
  g.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(g);

  const text = new Text({ text: symbol, style: { fontFamily: "monospace", fontSize: 24, fill: 0xffffff } });
  text.anchor.set(0.5);
  container.addChild(text);
}

/** Round, not the card's rounded-rect — visually distinct at a glance from a card pile,
 * matching the "token/tile" framing docs/GAME_DEFINITION.md describes pieces with. */
function drawImageFace(container: Container, texture: Texture): void {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.width = PIECE_SIZE;
  sprite.height = PIECE_SIZE;

  const mask = new Graphics();
  mask.circle(0, 0, PIECE_SIZE / 2);
  mask.fill({ color: 0xffffff });
  container.addChild(mask);
  sprite.mask = mask;
  container.addChild(sprite);

  const border = new Graphics();
  border.circle(0, 0, PIECE_SIZE / 2);
  border.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(border);
}

/** Draw a piece's (fixed, always-visible) appearance into `container` — no flip/hide
 * state to resolve, unlike renderCard, so there's nothing here but the content itself. */
export function renderPiece(container: Container, def: PieceDef): void {
  container.removeChildren();
  const token = bumpRenderToken(container);

  if (def.image) {
    loadImageTexture(def.image, (texture) => {
      if (renderTokens.get(container) !== token) return;
      container.removeChildren();
      drawImageFace(container, texture);
    });
    return;
  }

  drawSymbolFace(container, def.symbol ?? "?");
}
