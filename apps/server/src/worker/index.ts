import { pathToFileURL } from "node:url";
import { and, asc, inArray, notInArray } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { warmEmbeddings } from "../knowledge/embeddings.js";
import { notifyAdmin } from "../submissions/notify.js";
import { MAX_ATTEMPTS, processSubmission, requestStop, WorkerStopping } from "../submissions/process.js";
import { botUsername, telegramApi } from "../telegram/client.js";
import { redeemLinkCode } from "../telegram/link-store.js";
import { runTelegramPolling } from "../telegram/poller.js";

// Dedicated PM2 process (solvers-tempo-worker; PACKAGE_SPEC.md 16): extracts the ZIP, validates, scans and ingests the knowledge
// into staging, one submission at a time, with checkpoints in ingest_jobs. It runs outside solvers-tempo-api so it doesn't compete
// with MCP and payments. Compiled entry point: dist/worker/index.js (infra/worker-run.sh).
//
// It also runs the Telegram linking bot (src/telegram/poller.ts: /vincular and /start with the code from the site).
//
// Resuming: the CI deploy restarts the process on every push. `validating` counts as pending: what was already validated is
// not repeated and ingestion restarts from the last completed file. A submission that fails on a system error (database,
// disk, embeddings model) is retried after an interval, without blocking the others.

const POLL_MS = 3000;
const RETRY_AFTER_MS = 60_000;

const sleep = (ms: number, stopped: () => boolean) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const tick = setInterval(() => {
      if (stopped()) {
        clearTimeout(t);
        clearInterval(tick);
        resolve();
      }
    }, 250);
    t.unref();
    setTimeout(() => clearInterval(tick), ms + 300).unref();
  });

/** Pending ids, oldest first, excluding those in `skip` (the ones in backoff don't take up queue slots). */
export async function pendingSubmissionIds(limit = 20, skip: readonly string[] = []): Promise<string[]> {
  const where = skip.length
    ? and(inArray(schema.packageSubmissions.status, ["submitted", "validating"]), notInArray(schema.packageSubmissions.id, [...skip]))
    : inArray(schema.packageSubmissions.status, ["submitted", "validating"]);
  const rows = await db.select({ id: schema.packageSubmissions.id }).from(schema.packageSubmissions).where(where).orderBy(asc(schema.packageSubmissions.createdAt)).limit(limit);
  return rows.map((r) => r.id);
}

/** One pass: processes each pending submission (outside backoff). Returns how many were processed. */
export async function workOnce(failedAt: Map<string, number> = new Map(), now: () => number = Date.now): Promise<number> {
  let done = 0;
  const inBackoff = [...failedAt].filter(([, at]) => now() - at < RETRY_AFTER_MS).map(([id]) => id);
  for (const id of await pendingSubmissionIds(20, inBackoff)) {
    const failed = failedAt.get(id);
    if (failed !== undefined && now() - failed < RETRY_AFTER_MS) continue;
    try {
      const out = await processSubmission(id);
      if (out !== "skipped") done += 1;
      failedAt.delete(id);
    } catch (e) {
      if (e instanceof WorkerStopping) return done;
      console.error(`[worker] failed to process ${id}:`, e);
      // Alerts the admin only on the first failure (later ones only go to the log).
      if (failedAt.get(id) === undefined) await notifyAdmin(`Solvers: the worker failed to process submission ${id}: ${(e as Error).message.slice(0, 300)}. It will retry in 1 minute (at most ${MAX_ATTEMPTS} attempts).`);
      failedAt.set(id, now());
    }
  }
  return done;
}

export async function runWorker(stopped: () => boolean = () => false): Promise<void> {
  const failedAt = new Map<string, number>();
  console.log("[worker] listening for submissions");
  while (!stopped()) {
    let did = 0;
    try {
      did = await workOnce(failedAt);
    } catch (e) {
      console.error("[worker] loop error:", e);
    }
    if (did === 0) await sleep(POLL_MS, stopped);
  }
}

async function main() {
  let stop = false;
  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal}: finishing the current file and exiting`);
    stop = true;
    requestStop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  warmEmbeddings();
  // The Telegram linking bot runs here, alongside the queue: this is the only process that calls getUpdates.
  const api = telegramApi();
  const bot = runTelegramPolling(() => stop, { api, redeem: redeemLinkCode, botUsername: await botUsername(api) });
  await Promise.all([runWorker(() => stop), bot.catch((e) => console.error("[telegram] the bot loop crashed:", (e as Error).message))]);
  await pool.end().catch(() => undefined);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[worker] fatal failure", e);
    process.exit(1);
  });
}
