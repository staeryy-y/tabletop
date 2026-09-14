// A Card's *content* — what's printed on it. Rendering/interaction lives in table.ts;
// this module just knows how to draw a face into a PixiJS container. See
// docs/GAME_DEFINITION.md "Cards are the workhorse" — a card is just a front/back pair,
// nothing more; decks/stacks are an emergent runtime behavior (see Pile in table.ts),
// not authored here.
import { Container, Graphics, Sprite, Texture, Text } from "pixi.js";

export const CARD_WIDTH = 90;
export const CARD_HEIGHT = 126;

export interface CardFace {
  title: string;
  color: number;
  text?: string;
  /** An uploaded image (data: URI — see packages/gamePackage.ts's CardFaceContent),
   * drawn in place of the color/title/text rendering below when present. `color` is
   * still always carried alongside it (RoomTable.tsx's cardSetSpawnsFromPackage always
   * fills in a fallback) so there's something reasonable to show for the brief window
   * before the image finishes decoding. */
  image?: string;
  imageFit?: "contain" | "cover";
}

export interface CardDef {
  id: string;
  front: CardFace;
  back: CardFace;
}

export interface CardDisplay {
  face: CardFace;
  /** Who has this card hidden, if anyone — never null when hiddenBy isn't, regardless
   * of whether the viewer *is* that hider. See docs/DECISIONS.md D25: everyone can see
   * *that* a card is being secretly viewed and *by whom* (a colored eye badge — see
   * engine/table.ts's redraw), even though only the hider ever actually receives its
   * true front content. */
  hiddenByPeerId: string | null;
}

/** The pure decision behind a card's appearance — no PixiJS involved, so this is
 * exhaustively unit-testable on its own. `hiddenBy` is the peerId of whoever hid the
 * card, or null if no one has. For the hider, hidden takes precedence over faceUp — a
 * hidden card always shows *them* its front (that's the point of hiding it — see
 * docs/ARCHITECTURE.md "Hiding a card"), regardless of the card's own flip state. Every
 * other viewer sees the back, also regardless of faceUp, exactly as if it were face-down
 * — this is what makes Hide correct once state is actually synced across peers (M6):
 * the host only ever sends the true front content to the hider (see
 * net/syncProtocol.ts's redaction — the back is what a non-hider's client actually
 * receives, so it never even *has* the real front to accidentally render), this
 * function just encodes the same rule for the hider's own client, which does have it.
 * `hiddenByPeerId` is returned either way (D25) — see CardDisplay's own doc comment. */
export function resolveDisplay(def: CardDef, faceUp: boolean, hiddenBy: string | null, viewerPeerId: string): CardDisplay {
  if (hiddenBy !== null) {
    return { face: hiddenBy === viewerPeerId ? def.front : def.back, hiddenByPeerId: hiddenBy };
  }
  return { face: faceUp ? def.front : def.back, hiddenByPeerId: null };
}

// Image faces are loaded once (from a data: URI — see CardFace.image) and cached by
// that string, so a card set reusing the same art (e.g. every card in a suit sharing a
// back image) or simply redrawing the same pile repeatedly doesn't redecode it every
// time. Not unit-tested directly, same as the rest of this file's actual PixiJS
// drawing — decoding an image and asserting on canvas pixels needs a real browser, not
// something a Vitest/jsdom run can meaningfully check (see pileModel.ts's doc comment
// on why pure logic is kept separate from rendering for testability; there's no pure
// logic left to extract here beyond what resolveDisplay already covers).
const imageTextureCache = new Map<string, Texture>();

/** Tags each container with a counter that bumps on every drawFace() call, so an image
 * that finishes loading *after* the container has since been redrawn for something else
 * (a flip, a different top card after a merge, ...) can tell it's stale and skip
 * applying itself — without this, a slow-loading image could paint over whatever the
 * container is showing by the time it actually finishes decoding. */
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
    console.info("[rpg-tabletop][card-image] decoded", { bytes: dataUri.length, type: dataUri.slice(5, dataUri.indexOf(";")) });
    const texture = Texture.from(img);
    imageTextureCache.set(dataUri, texture);
    onReady(texture);
  };
  img.onerror = () => {
    console.warn("[rpg-tabletop][card-image] failed to decode", { bytes: dataUri.length, prefix: dataUri.slice(0, 32) });
    // Leave whatever fallback drawFace already drew in place — a bad/corrupt data URI
    // shouldn't crash the table, just mean this one card never gets its art.
  };
  img.src = dataUri;
}

function drawColorFace(container: Container, face: CardFace): void {
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
}

/** Trading-card layout: art occupies a fixed window while title and rules text remain
 * readable on translucent gray bands. Art preserves its aspect ratio; authors can opt
 * into a cropped `cover` fit when filling the window matters more than its edges. */
function drawImageFace(container: Container, texture: Texture, face: CardFace): void {
  const artTop = -CARD_HEIGHT / 2 + 22;
  const artHeight = 64;
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  const scale = face.imageFit === "cover"
    ? Math.max(CARD_WIDTH / texture.width, artHeight / texture.height)
    : Math.min(CARD_WIDTH / texture.width, artHeight / texture.height);
  sprite.width = texture.width * scale;
  sprite.height = texture.height * scale;
  sprite.position.set(0, artTop + artHeight / 2);
  container.addChild(sprite);

  // Match the color-face's rounded-rect card shape, so a mixed deck (some cards with
  // art, some without) still reads as one consistent set of cards.
  const mask = new Graphics();
  mask.rect(-CARD_WIDTH / 2 + 3, artTop, CARD_WIDTH - 6, artHeight);
  mask.fill({ color: 0xffffff });
  container.addChild(mask);
  sprite.mask = mask;

  const chrome = new Graphics();
  chrome.roundRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
  chrome.fill({ color: 0x202020, alpha: 0.2 });
  chrome.rect(-CARD_WIDTH / 2 + 2, -CARD_HEIGHT / 2 + 3, CARD_WIDTH - 4, 19);
  chrome.fill({ color: 0x777777, alpha: 0.2 });
  chrome.rect(-CARD_WIDTH / 2 + 2, artTop + artHeight + 2, CARD_WIDTH - 4, CARD_HEIGHT / 2 - artHeight + 1);
  chrome.fill({ color: 0x777777, alpha: 0.2 });
  container.addChild(chrome);
  const title = new Text({ text: face.title, style: { fontFamily: "monospace", fontSize: 11, fontWeight: "bold", fill: 0xffffff, wordWrap: true, wordWrapWidth: CARD_WIDTH - 10, align: "center" } });
  title.anchor.set(0.5, 0);
  title.position.set(0, -CARD_HEIGHT / 2 + 5);
  container.addChild(title);
  if (face.text) {
    const body = new Text({ text: face.text, style: { fontFamily: "monospace", fontSize: 8, fill: 0xffffff, wordWrap: true, wordWrapWidth: CARD_WIDTH - 10, align: "center" } });
    body.anchor.set(0.5, 0);
    body.position.set(0, artTop + artHeight + 6);
    container.addChild(body);
  }
  const border = new Graphics();
  border.roundRect(-CARD_WIDTH / 2, -CARD_HEIGHT / 2, CARD_WIDTH, CARD_HEIGHT, 8);
  border.stroke({ width: 2, color: 0x1a1a1a });
  container.addChild(border);
}

interface Badge {
  text: string;
  /** The badge's circle background color — 0x222222 (a plain neutral dark) for the
   * pile-count badge, or a player's own presence color for the hidden-eye badge (D25:
   * "the eye should have the color of the player" doing the hiding), so everyone can
   * tell *whose* eye it is without it ever revealing the card's actual content. */
  color: number | string;
}

function drawBadge(container: Container, badge: Badge): void {
  const b = new Graphics();
  b.circle(CARD_WIDTH / 2 - 12, -CARD_HEIGHT / 2 + 12, 10);
  b.fill({ color: badge.color });
  container.addChild(b);
  const bt = new Text({ text: badge.text, style: { fontFamily: "monospace", fontSize: 10, fill: 0xffffff } });
  bt.anchor.set(0.5);
  bt.position.set(CARD_WIDTH / 2 - 12, -CARD_HEIGHT / 2 + 12);
  container.addChild(bt);
}

function drawFace(container: Container, face: CardFace, badge?: Badge): void {
  container.removeChildren();
  const token = bumpRenderToken(container);

  if (face.image) {
    // The color/title fallback shows immediately (there's always a color — see
    // CardFace.image's doc comment) while the image itself decodes asynchronously;
    // loadImageTexture swaps it out for the real art once ready, unless this
    // container has since moved on to showing something else entirely.
    drawColorFace(container, face);
    if (badge) drawBadge(container, badge);
    loadImageTexture(face.image, (texture) => {
      if (renderTokens.get(container) !== token) return;
      container.removeChildren();
      drawImageFace(container, texture, face);
      if (badge) drawBadge(container, badge);
    });
    return;
  }

  drawColorFace(container, face);
  if (badge) drawBadge(container, badge);
}

/** Draw a card's current appearance into `container`, per resolveDisplay() above.
 * `colorForPeer` looks up a player's current presence color for the hidden-eye badge
 * (D25) — engine/table.ts passes its own `playerColors` map; a peerId with no known
 * color (e.g. they've since left) falls back to a plain neutral gray. */
export function renderCard(
  container: Container,
  def: CardDef,
  faceUp: boolean,
  hiddenBy: string | null,
  viewerPeerId: string,
  pileCount: number,
  colorForPeer: (peerId: string) => string,
): void {
  const { face, hiddenByPeerId } = resolveDisplay(def, faceUp, hiddenBy, viewerPeerId);
  const badge: Badge | undefined =
    hiddenByPeerId !== null
      ? { text: "\u{1F441}", color: colorForPeer(hiddenByPeerId) }
      : pileCount > 1
        ? { text: String(pileCount), color: 0x222222 }
        : undefined;
  drawFace(container, face, badge);
}
