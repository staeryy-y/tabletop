// PackageStore uses the browser's localStorage, which jsdom provides for these tests.
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyPackage } from "./gamePackage";
import { PackageStore, newPackageId } from "./packageStore";

beforeEach(() => {
  localStorage.clear();
});

describe("newPackageId", () => {
  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newPackageId()));
    expect(ids.size).toBe(50);
  });
});

describe("PackageStore", () => {
  it("list() is empty before anything is saved", async () => {
    expect(await new PackageStore().list()).toEqual([]);
  });

  it("get() returns undefined for an id that was never saved", async () => {
    expect(await new PackageStore().get("nope")).toBeUndefined();
  });

  it("save() then get() round-trips the package", async () => {
    const store = new PackageStore();
    const pkg = createEmptyPackage("My Game");
    await store.save("id-1", pkg);

    const fetched = await store.get("id-1");
    expect(fetched?.pkg).toEqual(pkg);
    expect(fetched?.id).toBe("id-1");
    expect(typeof fetched?.updatedAt).toBe("string");
  });

  it("saving the same id twice overwrites, not duplicates", async () => {
    const store = new PackageStore();
    await store.save("id-1", createEmptyPackage("First"));
    await store.save("id-1", createEmptyPackage("Second"));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].pkg.name).toBe("Second");
  });

  it("list() returns every saved package", async () => {
    const store = new PackageStore();
    await store.save("id-1", createEmptyPackage("A"));
    await store.save("id-2", createEmptyPackage("B"));

    const all = await store.list();
    expect(all.map((r) => r.pkg.name).sort()).toEqual(["A", "B"]);
  });

  it("list() orders most-recently-updated first", async () => {
    const store = new PackageStore();
    await store.save("older", createEmptyPackage("Older"));
    await new Promise((r) => setTimeout(r, 5));
    await store.save("newer", createEmptyPackage("Newer"));

    const all = await store.list();
    expect(all[0].id).toBe("newer");
    expect(all[1].id).toBe("older");
  });

  it("delete() removes a package", async () => {
    const store = new PackageStore();
    await store.save("id-1", createEmptyPackage("Gone Soon"));
    await store.delete("id-1");

    expect(await store.get("id-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("delete() on an id that was never saved does not throw", async () => {
    await expect(new PackageStore().delete("never-existed")).resolves.toBeUndefined();
  });

  it("round-trips a package containing an embedded image data URI", async () => {
    const store = new PackageStore();
    const pkg = createEmptyPackage("Cards");
    pkg.cardSets.push({
      key: "deck",
      entries: [{ id: "c1", front: { title: "", image: "data:image/png;base64,AAAA" } }],
    });
    await store.save("id-1", pkg);

    const fetched = await store.get("id-1");
    expect(fetched?.pkg.cardSets[0].entries[0].front.image).toBe("data:image/png;base64,AAAA");
  });
});
