import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_REVIEW_IMAGES, type ImageRef } from "@solvers/shared";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { ImageError, processImage } from "../images/process.js";
import { toImageRefs } from "../images/refs.js";
import { imageStore, type ImageStore } from "../images/store.js";
import { forbidden, h, HttpError, notFound } from "../lib/http.js";
import { findAgentRow } from "./catalog.js";
import { firstFreePosition } from "./image-rules.js";

// Review photos: up to 3 per review, only from license holders. A photo is attached after the review exists (the
// review is confirmed on-chain first); images are OUTSIDE the review's hash.

export const imagesRouter = Router();

const uploadLimit = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many image uploads. Please wait a moment and try again.", code: "rate_limited" },
  keyGenerator: (req) => req.wallet ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
});

const rawImage = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_IMAGE_UPLOAD_BYTES });

const LIMIT_MSG = `Each review accepts up to ${MAX_REVIEW_IMAGES} photos.`;

function requireStore(): ImageStore {
  const store = imageStore();
  if (!store) throw new HttpError(503, "Image upload is not available right now.", "image_unavailable");
  return store;
}

/** My confirmed review of this specialist, and only while I still hold the license. */
async function myReview(wallet: string, idOrSlug: string) {
  const agent = await findAgentRow(idOrSlug);
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.agentId, agent.id), eq(schema.reviews.authorWallet, wallet), eq(schema.reviews.onchain, true)));
  if (!review) throw new HttpError(409, "Publish your review before attaching photos.", "review_required");
  const [license] = await db
    .select({ id: schema.licenses.id })
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, agent.id), eq(schema.licenses.burned, false)));
  if (!license) throw forbidden("Only people who bought this specialist can attach photos.");
  return review;
}

async function usedPositions(reviewId: string): Promise<number[]> {
  const rows = await db.select({ position: schema.reviewImages.position }).from(schema.reviewImages).where(eq(schema.reviewImages.reviewId, reviewId));
  return rows.map((r) => r.position);
}

async function listMine(reviewId: string): Promise<ImageRef[]> {
  const rows = await db.select().from(schema.reviewImages).where(eq(schema.reviewImages.reviewId, reviewId)).orderBy(asc(schema.reviewImages.position));
  return toImageRefs(rows);
}

/** Drizzle wraps the pg error: the Postgres code is in `cause`. */
const isUniqueViolation = (e: unknown) => [e, (e as { cause?: unknown })?.cause].some((x) => (x as { code?: string } | undefined)?.code === "23505");

/**
 * Writes at the lowest free position. The unique index (review_id, position) enforces the limit: if two photos race
 * for the same position, the loser recomputes (at most MAX attempts: each lost round is a taken slot).
 */
async function insertAtFreePosition(reviewId: string, img: { key: string; width: number; height: number }) {
  for (let attempt = 0; attempt <= MAX_REVIEW_IMAGES; attempt++) {
    const position = firstFreePosition(await usedPositions(reviewId), MAX_REVIEW_IMAGES);
    if (position === null) break;
    try {
      await db.insert(schema.reviewImages).values({ id: randomBytes(8).toString("hex"), reviewId, position, ...img });
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new HttpError(409, LIMIT_MSG, "image_limit");
}

imagesRouter.post(
  "/agents/:idOrSlug/reviews/mine/images",
  requireAuth,
  uploadLimit,
  rawImage,
  h(async (req) => {
    const store = requireStore();
    const review = await myReview(requireWallet(req), String(req.params.idOrSlug));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ImageError("Send a JPG, PNG or WebP image.");
    if (firstFreePosition(await usedPositions(review.id), MAX_REVIEW_IMAGES) === null) throw new HttpError(409, LIMIT_MSG, "image_limit");

    const img = await processImage(req.body);
    const key = `solvers/reviews/${review.agentId}/${randomBytes(12).toString("hex")}`;
    await store.put(key, img.data);
    try {
      await insertAtFreePosition(review.id, { key, width: img.width, height: img.height });
    } catch (e) {
      await store.delete(key).catch((err) => console.error("[images] could not remove orphan", key, err));
      throw e;
    }
    return listMine(review.id);
  }),
);

imagesRouter.delete(
  "/agents/:idOrSlug/reviews/mine/images/:imageId",
  requireAuth,
  h(async (req) => {
    const review = await myReview(requireWallet(req), String(req.params.idOrSlug));
    const [img] = await db
      .delete(schema.reviewImages)
      .where(and(eq(schema.reviewImages.id, String(req.params.imageId)), eq(schema.reviewImages.reviewId, review.id)))
      .returning();
    if (!img) throw notFound("Photo not found");
    const store = imageStore();
    if (store) await store.delete(img.key).catch((err) => console.error("[images] could not remove from the CDN", img.key, err));
    return listMine(review.id);
  }),
);
