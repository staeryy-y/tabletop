import { beforeEach, describe, expect, it } from "vitest";
import { loadRoomToken, storeRoomToken } from "./roomToken";
import { JoinResult } from "./net/api";

const SAMPLE: JoinResult = { token: "tok-1", guestId: "guest-1", displayName: "Alice" };

beforeEach(() => {
  window.localStorage.clear();
});

describe("roomToken", () => {
  it("returns null for a room that was never joined", () => {
    expect(loadRoomToken("never-joined")).toBeNull();
  });

  it("round-trips a stored token", () => {
    storeRoomToken("room-a", SAMPLE);
    expect(loadRoomToken("room-a")).toEqual(SAMPLE);
  });

  it("keeps tokens for different rooms separate", () => {
    storeRoomToken("room-a", SAMPLE);
    storeRoomToken("room-b", { token: "tok-2", guestId: "guest-2", displayName: "Bob" });

    expect(loadRoomToken("room-a")!.displayName).toBe("Alice");
    expect(loadRoomToken("room-b")!.displayName).toBe("Bob");
  });

  it("overwrites a previous token for the same room", () => {
    storeRoomToken("room-a", SAMPLE);
    storeRoomToken("room-a", { token: "tok-new", guestId: "guest-new", displayName: "Alice II" });

    expect(loadRoomToken("room-a")!.token).toBe("tok-new");
  });
});
