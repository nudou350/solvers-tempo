import { env } from "../env.js";
import { createCloudinaryStore } from "./cloudinary.js";
import type { ImageStore } from "./cloudinary.js";

// Where images live. The database stores only the key (public_id); the URL is built by the ImageStore,
// so switching CDNs (e.g. Cloudflare R2) means implementing the same interface and changing imageStore().

export type { ImageKind, ImageStore } from "./cloudinary.js";

let cached: ImageStore | null | undefined;

/** null when the CDN is not configured: the image routes answer 503 and the rest of the site keeps working. */
export function imageStore(): ImageStore | null {
  if (cached === undefined) {
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = env;
    cached = cloudName && apiKey && apiSecret ? createCloudinaryStore({ cloudName, apiKey, apiSecret }) : null;
  }
  return cached;
}

/** Tests only. */
export function setImageStoreForTests(store: ImageStore | null | undefined) {
  cached = store;
}
