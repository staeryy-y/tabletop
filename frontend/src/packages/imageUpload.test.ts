import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_IMAGE_BYTES, ImageTooLargeError, readImageAsDataUrl } from "./imageUpload";

function makeFile(bytes: number, type = "image/png"): File {
  return new File([new Uint8Array(bytes)], "test.png", { type });
}

describe("readImageAsDataUrl", () => {
  it("resolves to a data: URI for a small file", async () => {
    const url = await readImageAsDataUrl(makeFile(10));
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects a file over the default size limit", async () => {
    await expect(readImageAsDataUrl(makeFile(DEFAULT_MAX_IMAGE_BYTES + 1))).rejects.toBeInstanceOf(ImageTooLargeError);
  });

  it("accepts a file exactly at the limit", async () => {
    await expect(readImageAsDataUrl(makeFile(DEFAULT_MAX_IMAGE_BYTES))).resolves.toContain("data:");
  });

  it("honors a custom size limit", async () => {
    await expect(readImageAsDataUrl(makeFile(200), 100)).rejects.toBeInstanceOf(ImageTooLargeError);
    await expect(readImageAsDataUrl(makeFile(50), 100)).resolves.toContain("data:");
  });

  it("the error message mentions the limit in megabytes", () => {
    const err = new ImageTooLargeError(2 * 1024 * 1024);
    expect(err.message).toContain("2.0MB");
  });
});
