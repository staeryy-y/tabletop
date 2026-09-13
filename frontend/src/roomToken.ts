// Persist the room-scoped guest token/display name in localStorage so a reload or
// reconnect doesn't require rejoining — see docs/ARCHITECTURE.md "Room lifecycle" step 2
// and docs/DECISIONS.md D5 (ephemeral guest identity, no account needed).
import { JoinResult } from "./net/api";

function key(slug: string): string {
  return `rpg-tabletop:room-token:${slug}`;
}

// `window.localStorage`, not the bare global: under Vitest (Node + jsdom), Node's own
// native `localStorage` global shadows jsdom's working implementation unless a
// --localstorage-file flag is passed, so the bare identifier is unreliable in tests even
// though it's identical to window.localStorage in every real browser.

export function storeRoomToken(slug: string, result: JoinResult): void {
  window.localStorage.setItem(key(slug), JSON.stringify(result));
}

export function loadRoomToken(slug: string): JoinResult | null {
  const raw = window.localStorage.getItem(key(slug));
  return raw ? (JSON.parse(raw) as JoinResult) : null;
}
