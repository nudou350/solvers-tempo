import { closeSync, createWriteStream, openSync, readSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { SUBMISSION_OPEN_STATUSES } from "@solvers/shared";
import { requireAuth } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { randomId } from "../lib/crypto.js";
import { HttpError, forbidden } from "../lib/http.js";
import { adminMessage, notifyAdmin } from "./notify.js";
import { SUBMISSION_ID_RE, submissionDir, zipPathOf, zipRelPath } from "./paths.js";
import { canResubmit, creatorNotReady, uploadLimitProblem } from "./rules.js";

// POST /api/creator/submissions: receives the ZIP as a raw body (`application/zip`) and streams it to
// SUBMISSIONS_DIR/<id>/package.zip, without buffering in memory (PACKAGE_SPEC.md 13, 14.4 and 16). Responds 202: extraction,
// scans and validation run in the worker. Mounted in app.ts BEFORE express.json (which has a 256 KB cap), with its
// own authentication, and the order of the checks is deliberate: login, profile/invite/terms, limits and declared size
// BEFORE reading the first byte of the body.
//
// Resubmission after `changes_requested`: POST ...?resubmit=<id> replaces the ZIP of the SAME submission and goes back to `validating`.

const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);
const PK_HEADERS = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];

const err = (status: number, message: string, code: string, extra?: Record<string, unknown>) => new HttpError(status, message, code, extra);

/** Counts how many submissions the creator has in progress and how many they made in the last 24 h. */
async function uploadCounts(wallet: string): Promise<{ pending: number; last24h: number }> {
  const mine = eq(schema.packageSubmissions.creatorWallet, wallet);
  const [p] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.packageSubmissions)
    .where(and(mine, inArray(schema.packageSubmissions.status, [...SUBMISSION_OPEN_STATUSES])));
  const [d] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.packageSubmissions)
    .where(and(mine, gt(schema.packageSubmissions.createdAt, sql`now() - interval '24 hours'`)));
  return { pending: p?.n ?? 0, last24h: d?.n ?? 0 };
}

/** The first bytes are a ZIP's (local file signature, or the central directory of an empty ZIP). */
function looksLikeZip(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    return n === 4 && PK_HEADERS.some((h) => h.equals(head));
  } finally {
    closeSync(fd);
  }
}

/** Streams the body to `dest`, aborting once it exceeds `max` bytes (Content-Length may be missing or lie). */
async function receiveBody(req: Request, dest: string, max: number): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max) return cb(err(413, `The ZIP exceeds the ${Math.floor(max / (1024 * 1024))} MB limit.`, "payload_too_large", { maxBytes: max }));
      cb(null, chunk);
    },
  });
  await pipeline(req, counter, createWriteStream(dest, { flags: "wx", mode: 0o640 }));
  return size;
}

/**
 * Responded without reading the body (rejected before the upload): closes the connection instead of swallowing gigabytes nobody will use.
 * The "Connection: close" header tells Node to end after the response; the timer kills whatever is still open.
 */
const closeUnreadBody: RequestHandler = (req, res, next) => {
  res.setHeader("Connection", "close");
  res.once("finish", () => {
    if (req.readableEnded) return;
    const t = setTimeout(() => req.socket.destroy(), 5000);
    t.unref();
    res.once("close", () => clearTimeout(t));
  });
  next();
};

async function kick(id: string) {
  if (!env.SUBMISSIONS_INLINE) return;
  // Inline mode (local QA without PM2): processes inside this process, outside the request cycle.
  setImmediate(() => {
    void import("./process.js")
      .then((m) => m.processSubmission(id))
      .catch((e) => console.error("[submissions] inline processing failed:", e));
  });
}

const handler: RequestHandler = async (req, res) => {
  const wallet = req.wallet!;
  const [creator] = await db.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
  const notReady = creatorNotReady(creator);
  if (notReady) {
    throw forbidden(notReady);
  }

  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ZIP_TYPES.has(type)) {
    throw err(415, "Send the ZIP as the raw request body with Content-Type: application/zip.", "unsupported_media_type");
  }

  const resubmit = typeof req.query.resubmit === "string" ? req.query.resubmit : undefined;
  let existing: typeof schema.packageSubmissions.$inferSelect | undefined;
  if (resubmit !== undefined) {
    if (!SUBMISSION_ID_RE.test(resubmit)) throw err(400, "Invalid submission identifier.", "bad_request");
    [existing] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, resubmit));
    if (!existing || existing.creatorWallet !== wallet) throw err(404, "Submission not found.", "not_found");
    if (!canResubmit(existing.status)) throw err(409, "You can only resubmit a package on which the reviewer requested changes.", "not_resubmittable", { status: existing.status });
  } else {
    const limited = uploadLimitProblem(await uploadCounts(wallet), { maxPending: env.SUBMISSION_MAX_PENDING, maxPerDay: env.SUBMISSION_MAX_PER_DAY });
    if (limited) throw err(429, limited.message, limited.code);
  }

  const max = env.SUBMISSION_MAX_ZIP_BYTES;
  const declared = req.headers["content-length"] === undefined ? undefined : Number(req.headers["content-length"]);
  if (declared !== undefined && (!Number.isFinite(declared) || declared < 0)) throw err(400, "Invalid Content-Length.", "bad_request");
  if (declared !== undefined && declared > max) {
    throw err(413, `The ZIP exceeds the ${Math.floor(max / (1024 * 1024))} MB limit.`, "payload_too_large", { maxBytes: max });
  }
  if (declared === 0) throw err(400, "The request body is empty.", "empty_body");

  const id = existing?.id ?? randomId(12);
  const dir = submissionDir(id);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  // Unique name per request: simultaneous resubmissions of the same submission do not write to the same file (the cleanup deletes old `.part` files).
  const part = `${zipPathOf(id)}.${randomId(6)}.part`;
  const cleanup = async () => {
    await rm(part, { force: true });
    if (!existing) await rm(dir, { recursive: true, force: true });
  };
  let size: number;
  try {
    size = await receiveBody(req, part, max);
    if (size === 0) throw err(400, "The request body is empty.", "empty_body");
    if (!looksLikeZip(part)) throw err(400, "The uploaded file is not a ZIP.", "not_a_zip");
  } catch (e) {
    await cleanup();
    throw e;
  }

  // Resubmission: with the row locked and still in `changes_requested`, the new ZIP replaces the old one (atomic rename) and the
  // row goes back to `validating` in the same transaction. Two simultaneous resubmissions (each with its own `.part`) do not
  // trample each other: the second waits for the lock, sees the new state and gets 409 without having touched `package.zip`.
  if (existing) {
    let replaced: boolean;
    try {
      replaced = await db.transaction(async (tx) => {
        const locked = await tx.execute<{ status: string }>(sql`select status from package_submissions where id = ${id} for update`);
        if (locked.rows[0]?.status !== "changes_requested") return false;
        await rename(part, zipPathOf(id));
        await tx
          .update(schema.packageSubmissions)
          .set({ status: "validating", sizeBytes: size, zipPath: zipRelPath(id), manifest: null, validation: null, scans: null, error: null, attempts: 0, updatedAt: new Date() })
          .where(and(eq(schema.packageSubmissions.id, id), eq(schema.packageSubmissions.status, "changes_requested")));
        return true;
      });
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    if (!replaced) {
      await rm(part, { force: true });
      throw err(409, "This submission no longer accepts a new ZIP.", "not_resubmittable");
    }
    await notifyAdmin(adminMessage("resubmitted", { id, slug: existing.slug, version: existing.version, creatorWallet: wallet, name: (existing.manifest?.name as string | undefined) ?? null }));
    void kick(id);
    res.status(202).json({ id, status: "validating" });
    return;
  }

  try {
    await rename(part, zipPathOf(id));
    // Recount under a per-creator lock: two simultaneous uploads cannot get past the pending limit.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`creator-upload:${wallet}`}, 0))`);
      const mine = eq(schema.packageSubmissions.creatorWallet, wallet);
      const [p] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.packageSubmissions).where(and(mine, inArray(schema.packageSubmissions.status, [...SUBMISSION_OPEN_STATUSES])));
      const [d] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.packageSubmissions).where(and(mine, gt(schema.packageSubmissions.createdAt, sql`now() - interval '24 hours'`)));
      const limited = uploadLimitProblem({ pending: p?.n ?? 0, last24h: d?.n ?? 0 }, { maxPending: env.SUBMISSION_MAX_PENDING, maxPerDay: env.SUBMISSION_MAX_PER_DAY });
      if (limited) throw err(429, limited.message, limited.code);
      // The final slug, version and agentId are only known after opening the ZIP: the worker fills them in.
      await tx.insert(schema.packageSubmissions).values({ id, creatorWallet: wallet, agentId: randomId(16), slug: "", version: "", status: "submitted", zipPath: zipRelPath(id), sizeBytes: size });
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  await notifyAdmin(adminMessage("submitted", { id, slug: "", version: "", creatorWallet: wallet }));
  void kick(id);
  res.status(202).json({ id, status: "submitted" });
};

/** Route chain: cookie -> login -> handler. CORS and the per-IP limit come from app.ts (where `webCors` and `byIp` exist). */
export const submissionUploadHandlers: RequestHandler[] = [closeUnreadBody, cookieParser(), requireAuth, handler];
