// Persist the room-scoped guest token/display name in localStorage so a reload or
// reconnect doesn't require rejoining — see docs/ARCHITECTURE.md "Room lifecycle" step 2
// and docs/DECISIONS.md D5 (ephemeral guest identity, no account needed).
import { JoinResult } from "./net/api";

function key(slug: string): string {
  return `rpg-tabletop:room-token:${slug}`;
}

export function storeRoomToken(slug: string, result: JoinResult): void {
  localStorage.setItem(key(slug), JSON.stringify(result));
}

export function loadRoomToken(slug: string): JoinResult | null {
  const raw = localStorage.getItem(key(slug));
  return raw ? (JSON.parse(raw) as JoinResult) : null;
}
