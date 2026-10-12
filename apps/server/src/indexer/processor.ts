// Applies decoded Solvers events to the mirror (D9), one database transaction per event:
//   processed_events(tx_hash, log_index) is inserted in the SAME transaction as the event's effects, so an event is
//   applied exactly once even when the poller, `processTxHash` and a reindex race on it.
// Events are processed in (blockNumber, logIndex) order. A failing transaction goes to `indexer_failures` and is
// retried with backoff without blocking the cursor; infrastructure errors (RPC down) never spend attempts.

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { TransactionReceiptNotFoundError, type Hex, type Log } from "viem";
import { parseSolversEvents, type SolversLog } from "@solvers/chain";
import { chainContext } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { planEvent, type EventContext } from "./handlers.js";
import { groupByTx, sortEvents } from "./order.js";
import { INFRA_RETRY_SECS, IndexerRetryableError, MAX_ATTEMPTS, MAX_INFRA_AGE_DAYS, backoffSecs, isInfraError } from "./retry-policy.js";
import { newReads, type Reads } from "./sync.js";

export { IndexerRetryableError };

type Listener = (ev: SolversLog, txHash: Hex) => void | Promise<void>;
const listeners: Listener[] = [];

/** Lets other modules (publication reconcile, notifications) react to newly indexed events, once each, after commit. */
export function onChainEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export type ProcessOptions = {
  /** Re-apply the mirror effects of events already processed (reindex). Side effects still run only once. */
  force?: boolean;
  /** RPC read memo shared by one run. */
  reads?: Reads;
};

export type ProcessStats = { events: number; applied: number; failedTxs: number };

/** Read memo + cached block timestamps for one run. */
export function eventContext(reads: Reads = newReads()): EventContext {
  const times = new Map<bigint, Promise<Date | null>>();
  return {
    reads,
    blockTime: (n) => {
      let p = times.get(n);
      if (!p) {
        p = chainContext()
          .publicClient.getBlock({ blockNumber: n })
          .then((b) => new Date(Number(b.timestamp) * 1000));
        times.set(n, p);
        p.catch(() => times.delete(n));
      }
      return p;
    },
  };
}

async function alreadyProcessed(txHash: string, logIndex: number): Promise<boolean> {
  const [row] = await db
    .select({ n: schema.processedEvents.logIndex })
    .from(schema.processedEvents)
    .where(and(eq(schema.processedEvents.txHash, txHash), eq(schema.processedEvents.logIndex, logIndex)));
  return !!row;
}

/**
 * Applies one event. Returns true when it was new (first time processed). `siblings`: every Solvers event of the same
 * transaction (default: just this one).
 */
export async function processEvent(ev: SolversLog, c: EventContext, o: ProcessOptions = {}, siblings?: readonly SolversLog[]): Promise<boolean> {
  const txHash = ev.transactionHash.toLowerCase();
  const logIndex = ev.logIndex;
  if (!o.force && (await alreadyProcessed(txHash, logIndex))) return false;
  // Every RPC read happens here, before the transaction opens.
  const plan = await planEvent(ev, c, siblings ?? [ev]);
  const fresh = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.processedEvents)
      .values({ txHash, logIndex, blockNumber: ev.blockNumber, name: ev.eventName })
      .onConflictDoNothing()
      .returning({ txHash: schema.processedEvents.txHash });
    const isNew = inserted.length > 0;
    // Someone else applied it in the meantime: nothing to do (unless forcing a mirror refresh).
    if (!isNew && !o.force) return false;
    for (const effect of plan.effects) await effect(tx);
    // In-transaction side effects (the payments hook) run only the first time.
    if (isNew) for (const effect of plan.once) await effect(tx);
    return isNew;
  });
  if (fresh) {
    for (const fn of plan.after) fn().catch((e) => console.error(`[indexer] after ${ev.eventName}:`, (e as Error).message));
    for (const l of listeners) Promise.resolve(l(ev, txHash as Hex)).catch((e) => console.error("[indexer] listener:", (e as Error).message));
  }
  return fresh;
}

/** Applies all events of one transaction in order; throws on the first failure (the rest is retried with it). */
async function applyTxEvents(events: readonly SolversLog[], c: EventContext, o: ProcessOptions): Promise<number> {
  let applied = 0;
  for (const ev of events) if (await processEvent(ev, c, o, events)) applied++;
  return applied;
}

/**
 * Applies raw logs (any order, any address: foreign logs are dropped). A failing transaction is recorded in
 * `indexer_failures` and the others continue. Throws only if the database itself fails.
 */
export async function processLogs(logs: readonly Log[], o: ProcessOptions = {}): Promise<ProcessStats> {
  const events = sortEvents(parseSolversEvents(logs, chainContext().deployment));
  const c = eventContext(o.reads);
  const stats: ProcessStats = { events: events.length, applied: 0, failedTxs: 0 };
  for (const [hash, evs] of groupByTx(events)) {
    try {
      stats.applied += await applyTxEvents(evs, c, o);
      await clearFailure(hash);
    } catch (e) {
      console.error(`[indexer] failed on ${hash}:`, (e as Error).message);
      await recordFailure(hash, e);
      stats.failedTxs++;
    }
  }
  return stats;
}

/** Fetches the receipt and applies its events. Throws (without recording) on any failure. */
async function applyTx(hash: Hex, o: ProcessOptions = {}): Promise<ProcessStats> {
  let receipt;
  try {
    receipt = await chainContext().publicClient.getTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) throw new IndexerRetryableError(`transaction ${hash} not visible on the RPC yet`);
    throw e;
  }
  if (receipt.status !== "success") return { events: 0, applied: 0, failedTxs: 0 };
  const events = sortEvents(parseSolversEvents(receipt.logs, chainContext().deployment));
  const applied = await applyTxEvents(events, eventContext(o.reads), o);
  return { events: events.length, applied, failedTxs: 0 };
}

/**
 * Applies every Solvers event of one transaction right after it was sent (server or user tx). Idempotent: events the
 * poller already applied are skipped. On failure the transaction is queued for retry and the error is rethrown.
 */
export async function processTxHash(hash: Hex, o: ProcessOptions = {}): Promise<ProcessStats> {
  const h = hash.toLowerCase() as Hex;
  try {
    const stats = await applyTx(h, o);
    await clearFailure(h);
    return stats;
  } catch (e) {
    await recordFailure(h, e);
    throw e;
  }
}

// ---------- failures and retries ----------

/**
 * Records a failure for retry without blocking the poll cursor. Exponential backoff (30 s up to 6 h). An
 * infrastructure failure (RPC down, rate limit) spends no attempts and is retried every minute. After MAX_ATTEMPTS real
 * failures (or MAX_INFRA_AGE_DAYS days of infrastructure failures) the transaction is "dead": logged, and waits for a
 * manual reprocess (`cli:reindex --dead`).
 */
export async function recordFailure(txHash: string, error: unknown): Promise<void> {
  const message = ((error as Error)?.message ?? String(error)).slice(0, 1000);
  const f = schema.indexerFailures;
  const infra = isInfraError(error);
  const raw = (n: number) => sql.raw(String(n));
  const [row] = await db
    .insert(f)
    .values({
      txHash: txHash.toLowerCase(),
      attempts: infra ? 0 : 1,
      lastError: message,
      nextAttemptAt: new Date(Date.now() + (infra ? INFRA_RETRY_SECS : backoffSecs(1)) * 1000),
    })
    .onConflictDoUpdate({
      target: f.txHash,
      set: infra
        ? {
            lastError: message,
            nextAttemptAt: sql`now() + make_interval(secs => ${raw(INFRA_RETRY_SECS)})`,
            status: sql`case when ${f.createdAt} < now() - make_interval(days => ${raw(MAX_INFRA_AGE_DAYS)}) then 'dead' else ${f.status} end`,
            updatedAt: new Date(),
          }
        : {
            attempts: sql`${f.attempts} + 1`,
            lastError: message,
            nextAttemptAt: sql`now() + make_interval(secs => least(${raw(backoffSecs(99))}, ${raw(backoffSecs(1))} * power(2, ${f.attempts})))`,
            status: sql`case when ${f.attempts} + 1 >= ${raw(MAX_ATTEMPTS)} then 'dead' else 'pending' end`,
            updatedAt: new Date(),
          },
    })
    .returning({ status: f.status, attempts: f.attempts });
  if (row?.status === "dead") {
    console.error(`[indexer] GAVE UP on ${txHash} (${row.attempts} failures): ${message}. Reprocess with: pnpm --filter @solvers/server cli:reindex --dead`);
  }
}

/** The transaction was indexed: delete its pending failure, if any. */
export async function clearFailure(txHash: string): Promise<void> {
  await db.delete(schema.indexerFailures).where(eq(schema.indexerFailures.txHash, txHash.toLowerCase()));
}

/** Retries the failures that are due. Returns how many were resolved. */
export async function retryFailures(limit = 20, o: { txHashes?: readonly string[] } = {}): Promise<number> {
  const f = schema.indexerFailures;
  const rows = await db
    .select()
    .from(f)
    .where(and(eq(f.status, "pending"), lte(f.nextAttemptAt, sql`now()`), o.txHashes ? inArray(f.txHash, [...o.txHashes]) : undefined))
    .orderBy(asc(f.nextAttemptAt))
    .limit(limit);
  let ok = 0;
  let infraStreak = 0;
  for (const r of rows) {
    try {
      await applyTx(r.txHash as Hex);
      await clearFailure(r.txHash);
      ok++;
      infraStreak = 0;
    } catch (e) {
      await recordFailure(r.txHash, e);
      // RPC down: no point hammering the others; the next round retries.
      if (isInfraError(e) && ++infraStreak >= 3) break;
    }
  }
  return ok;
}

/** Puts the "dead" failures back in the queue (attempts reset). Returns how many. */
export async function reviveDeadFailures(): Promise<number> {
  const f = schema.indexerFailures;
  const rows = await db
    .update(f)
    .set({ status: "pending", attempts: 0, nextAttemptAt: sql`now()`, updatedAt: new Date() })
    .where(eq(f.status, "dead"))
    .returning({ txHash: f.txHash });
  return rows.length;
}

/** Reprocesses transactions now (manual or reconciliation), refreshing the mirror (`force`). */
export async function reprocessTxs(hashes: readonly string[], o: { force?: boolean } = { force: true }): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const reads = newReads();
  for (const h of hashes) {
    try {
      await processTxHash(h as Hex, { force: o.force, reads });
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}
