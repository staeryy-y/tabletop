import { beforeEach, describe, expect, it } from "vitest";
import { getRememberedRoomPackageId, rememberRoomPackageId } from "./roomPackageChoice";

beforeEach(() => {
  window.localStorage.clear();
});

describe("roomPackageChoice", () => {
  it("returns null for a room with no remembered package", () => {
    expect(getRememberedRoomPackageId("never-set")).toBeNull();
  });

  it("round-trips a remembered package id", () => {
    rememberRoomPackageId("room-a", "pkg-123");
    expect(getRememberedRoomPackageId("room-a")).toBe("pkg-123");
  });

  it("keeps different rooms' choices separate", () => {
    rememberRoomPackageId("room-a", "pkg-1");
    rememberRoomPackageId("room-b", "pkg-2");
    expect(getRememberedRoomPackageId("room-a")).toBe("pkg-1");
    expect(getRememberedRoomPackageId("room-b")).toBe("pkg-2");
  });

  it("overwrites a previous choice for the same room", () => {
    rememberRoomPackageId("room-a", "pkg-1");
    rememberRoomPackageId("room-a", "pkg-2");
    expect(getRememberedRoomPackageId("room-a")).toBe("pkg-2");
  });
});
