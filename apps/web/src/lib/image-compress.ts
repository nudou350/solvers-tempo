// Shrinks a photo in the browser before upload: the production nginx accepts bodies up to 2 MB and a phone photo
// easily exceeds that. Resizes (longest side 1600 px, never upscaling) and exports WebP; without WebP, JPEG.
// The server re-encodes anyway, so the goal here is only to fit the limit and save bandwidth.
import { localText } from "./local-text";

const MAX_SIDE = 1600;
/** Below the 2 MB nginx limit, with room for the headers. */
const MAX_BYTES = Math.floor(1.8 * 1024 * 1024);
const QUALITIES = [0.85, 0.75, 0.65, 0.55];
const SIDES = [MAX_SIDE, 1280, 1024, 800];

/** Error with a message ready to show to the person (already in the page language). */
export class ImageCompressError extends Error {}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    // "from-image": honours the rotation recorded by the camera (the canvas keeps no EXIF).
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new ImageCompressError(localText("image.unreadable"));
    }
  }
}

/**
 * Returns a WebP (or JPEG) Blob of at most ~1.8 MB. `blob.type` is what goes in the upload Content-Type.
 * Throws ImageCompressError when the image cannot be read or does not fit even when reduced.
 */
export async function compressImage(file: Blob): Promise<Blob> {
  const bitmap = await decode(file);
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageCompressError(localText("image.noCanvas"));
    // A browser without a WebP encoder returns PNG: then JPEG is used (white background instead of transparency).
    let type = "image/webp";
    for (const side of SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      for (const q of QUALITIES) {
        if (type === "image/jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let blob = await encode(canvas, type, q);
        if (blob && type === "image/webp" && blob.type !== "image/webp") {
          type = "image/jpeg";
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          blob = await encode(canvas, type, q);
        }
        if (blob && blob.size <= MAX_BYTES) return blob;
      }
    }
    throw new ImageCompressError(localText("image.tooLarge"));
  } finally {
    bitmap.close();
  }
}
