// Turning an uploaded image file into the data: URI a CardFaceContent/PieceEntry
// embeds — see gamePackage.ts. A single small pure-ish function so the size-limit rule
// (the one piece of actual logic here) is testable without needing to drive a real
// <input type="file"> through a browser.

export class ImageTooLargeError extends Error {
  constructor(public maxBytes: number) {
    super(`Image is larger than the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit`);
  }
}

export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a card/piece face, keeps packages small enough to export/import comfortably

export function readImageAsDataUrl(file: File, maxBytes = DEFAULT_MAX_IMAGE_BYTES): Promise<string> {
  if (file.size > maxBytes) {
    return Promise.reject(new ImageTooLargeError(maxBytes));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read image"));
    reader.readAsDataURL(file);
  });
}
