import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { recordUsageBatchCalls, releaseMilestoneCalls, resolveStaleDisputeCalls } from "@solvers/chain";
import { agentIdToBytes32, DELIST_MAX_RATING, DELIST_MIN_REVIEWS, MILESTONE_STATUS, PAUSE_FLAGS, isPaused } from "@solvers/shared";
import { TransactionReceiptNotFoundError, type Hex } from "viem";

import { reconcileSentTxs, sendServerCalls, sentTxsFor } from "./chain/lanes.js";
import { chainContext } from "./chain/index.js";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { staleDisputeDue } from "./indexer/escrow-status.js";
import { indexerJob, processTxHash, syncEscrow } from "./indexer/index.js";
import { randomId, sha256 } from "./lib/crypto.js";
import { every, type Job } from "./lib/jobs.js";
import { notifyCreator } from "./notify/telegram.js";
import { paymentsJobs } from "./payments/jobs.js";
import { publishJobs } from "./publish/reconcile.js";
import { PLATFORM_AGENT_IDS } from "./runtime/platform-agents.js";
import { callTargets, escrowOnChain, registryConfig } from "./store/chain-reads.js";
import { DISPUTE_SLA_SECS } from "./store/delivery-rules.js";
import { promoteDisputeDrafts } from "./store/dispute-drafts.js";
import { fillEscrowTexts } from "./store/escrow.js";
import { cleanupAcceptancePlansOnce } from "./store/escrow-upkeep.js";
import { cleanupSubmissionsOnce } from "./submissions/cleanup.js";

// Periodic jobs of the API process (every area's jobs are listed here; the worker has its own):
// - indexer (INDEXER_POLL_MS): eth_getLogs over the six contracts (D9).
// - payments (30 s / 10 min): charge reconciliation and float alerts.
// - publish (every minute): finishes publications whose on-chain approval was seen.
// - sent transactions (every minute): settles the nonce-lane journal (`sent_txs`): mined or expired.
// - auto release (every minute): milestones that passed their tests and whose review window is over are paid to the
//   creator. `releaseMilestone` is permissionless after the window; the server sends it from the PLATFORM key on its
//   nonce lane (RELAY pays the fee), so the creator never waits for the buyer.
// - stale disputes (every minute): `resolveStaleDispute` refunds the buyer after 7 days without a judgment (also
//   permissionless; same key and lane).
// - usage batches (every 10 min): `recordUsageBatch` with the Merkle root of the response hashes, as PLATFORM (USAGE_ROLE)
//   on the usage lane; the tx hash is journaled in `sent_txs` before broadcast.
// - guarantee texts (every minute): copies title/criteria from the purchase ledger into escrows the indexer mirrored.
// - dispute texts (every minute): promotes the dispute draft whose hash the chain shows (store/dispute-drafts.ts).
// - acceptance plans cleanup (hourly): removes `DELIVERABLES_DIR/plan-*` suites of intents that never became an escrow,
//   expired guarantee-limit holds and unsigned dispute drafts (store/escrow-upkeep.ts).
// - storefront (hourly): delists Solvers with a low rating after 10 reviews.
// - submissions cleanup (every 6 h): expires stale submissions, deletes rejected ZIPs, orphan folders and `.part` files.
// There is no escrow-closing job: nothing is stored to reclaim on Tempo (D19).

const nowSecs = () => Math.floor(Date.now() / 1000);

async function paymentsPaused(): Promise<boolean> {
  const flags = (await registryConfig())?.pauseFlags;
  return flags !== undefined && isPaused(flags, PAUSE_FLAGS.PAYMENTS);
}

export async function autoReleaseOnce(): Promise<number> {
  if (!env.AUTO_RELEASE_ENABLED) return 0;
  const due = await db
    .select({ escrowId: schema.milestones.escrowId, idx: schema.milestones.idx })
    .from(schema.milestones)
    .innerJoin(schema.escrows, eq(schema.escrows.id, schema.milestones.escrowId))
    .where(
      and(
        eq(schema.milestones.status, "passed"),
        isNotNull(schema.milestones.passedAt),
        notInArray(schema.escrows.status, ["approved", "refunded"]),
        sql`${schema.milestones.passedAt} + make_interval(secs => ${schema.escrows.reviewWindowSecs}) < now()`,
      ),
    )
    // Oldest first: a group of stuck milestones never starves the older ones.
    .orderBy(asc(schema.milestones.passedAt))
    .limit(20);
  if (due.length === 0 || (await paymentsPaused())) return 0;
  let n = 0;
  for (const m of due) {
    try {
      // The contract decides: re-read the milestone; if it is no longer Passed (released or disputed meanwhile), just mirror.
      const e = await escrowOnChain(BigInt(m.escrowId));
      const ms = e?.milestones[m.idx];
      if (!e || !ms || ms.status !== MILESTONE_STATUS.Passed) {
        await syncEscrow(m.escrowId).catch(() => undefined);
        continue;
      }
      if (nowSecs() < ms.passedAt + e.reviewWindowSecs) continue;
      const { hash } = await sendServerCalls({
        signer: "platform",
        lane: "platform",
        calls: releaseMilestoneCalls(callTargets(), { escrowId: BigInt(m.escrowId), index: m.idx }),
        kind: "auto-release",
        ref: `${m.escrowId}:${m.idx}`,
      });
      await processTxHash(hash).catch(() => undefined);
      n++;
    } catch (e) {
      console.error(`[jobs] auto release ${m.escrowId}#${m.idx}:`, (e as Error).message);
    }
  }
  return n;
}

/**
 * Stale disputes: after DISPUTE_SLA_SECS (7 days) without a judgment, the buyer is refunded by `resolveStaleDispute`, which
 * anyone may call (here the PLATFORM key, the relay pays the fee). Only for a milestone that never passed its tests and
 * whose delivery deadline is over; a milestone that passed is judged only by the admin. The call only succeeds for a
 * milestone still Disputed on-chain, so a resend after an uncertain send fails harmlessly; the job re-reads the escrow
 * first and only mirrors when the dispute is already settled.
 */
export async function resolveStaleDisputesOnce(): Promise<number> {
  const due = await db
    .select({ escrowId: schema.milestones.escrowId, idx: schema.milestones.idx })
    .from(schema.milestones)
    .innerJoin(schema.escrows, eq(schema.escrows.id, schema.milestones.escrowId))
    .where(
      and(
        eq(schema.milestones.status, "disputed"),
        isNotNull(schema.milestones.disputedAt),
        isNull(schema.milestones.passedAt),
        isNotNull(schema.escrows.deliveryDeadline),
        sql`${schema.escrows.deliveryDeadline} < now()`,
        sql`${schema.milestones.disputedAt} + make_interval(secs => ${DISPUTE_SLA_SECS}) <= now()`,
      ),
    )
    .orderBy(asc(schema.milestones.disputedAt))
    .limit(10);
  let n = 0;
  for (const m of due) {
    try {
      const e = await escrowOnChain(BigInt(m.escrowId));
      const ms = e?.milestones[m.idx];
      if (!e || !ms || ms.status !== MILESTONE_STATUS.Disputed) {
        await syncEscrow(m.escrowId).catch(() => undefined);
        continue;
      }
      if (!staleDisputeDue({ disputedAt: ms.disputedAt, passedAt: ms.passedAt, deliveryDeadline: e.deliveryDeadline }, nowSecs())) continue;
      const { hash } = await sendServerCalls({
        signer: "platform",
        lane: "platform",
        calls: resolveStaleDisputeCalls(callTargets(), { escrowId: BigInt(m.escrowId), index: m.idx }),
        kind: "stale-dispute",
        ref: `${m.escrowId}:${m.idx}`,
      });
      await processTxHash(hash).catch(() => undefined);
      n++;
    } catch (e) {
      console.error(`[jobs] stale dispute ${m.escrowId}#${m.idx}:`, (e as Error).message);
    }
  }
  return n;
}

/** Simple Merkle root (sha256, sorted pairs) of the response hashes. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32);
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(sha256(Buffer.compare(a, b) <= 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a])));
    }
    level = next;
  }
  return level[0]!;
}

// ---------- Usage batches ----------
//
// Each batch is one on-chain transaction that adds `count` to `verifiedUses` and is not idempotent. The uses are reserved
// for the batch (usage_events.batch_id) BEFORE sending; `sendServerCalls` journals the tx hash in `sent_txs` before the
// broadcast. Uses are released for a new batch only when it is certain the transaction did not land (reverted, never
// signed, or past `validBefore` without a receipt). An uncertain outcome leaves the batch "pending" for the reconciler.

const USAGE_BATCH_KIND = "usage-batch";
/** A pending batch with no journaled transaction after this long was never signed: its uses go back to the pool. */
const UNSIGNED_BATCH_SECS = 120;

async function finalizeBatch(batchId: string, txHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(schema.usageEvents).set({ batched: true }).where(eq(schema.usageEvents.batchId, batchId));
    await tx.update(schema.usageBatches).set({ status: "confirmed", txHash, updatedAt: new Date() }).where(eq(schema.usageBatches.id, batchId));
  });
}

/** Did not land: the uses go back to the next batch. */
async function releaseBatch(batchId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.usageEvents)
      .set({ batchId: null })
      .where(and(eq(schema.usageEvents.batchId, batchId), eq(schema.usageEvents.batched, false)));
    await tx.update(schema.usageBatches).set({ status: "released", updatedAt: new Date() }).where(eq(schema.usageBatches.id, batchId));
  });
}

export type BatchVerdict = "confirmed" | "released" | "pending";

/**
 * Outcome of a batch from its journal rows (pure): a confirmed tx wins; a reverted one, or one past `validBefore` with no
 * receipt (expired, or a failed broadcast that never landed), releases; no row at all releases only after
 * `UNSIGNED_BATCH_SECS`; anything else waits.
 */
export function batchVerdict(
  journal: readonly { status: string; hasReceipt: boolean | null; receiptOk: boolean | null; validBefore: Date | null }[],
  batchAgeSecs: number,
  now: Date = new Date(),
): BatchVerdict {
  if (journal.length === 0) return batchAgeSecs > UNSIGNED_BATCH_SECS ? "released" : "pending";
  if (journal.some((j) => j.status === "confirmed" || j.receiptOk === true)) return "confirmed";
  const settled = journal.every(
    (j) =>
      j.status === "reverted" ||
      j.receiptOk === false ||
      ((j.status === "expired" || j.status === "failed" || j.status === "pending") && j.hasReceipt === false && !!j.validBefore && j.validBefore.getTime() < now.getTime() - 5_000),
  );
  return settled ? "released" : "pending";
}

/**
 * The receipt, or null when the node says it does not exist (`TransactionReceiptNotFoundError`). Any other failure
 * (timeout, RPC down, rate limit) is rethrown: "could not ask" is never "not there".
 */
export async function receiptOrMissing<T>(get: () => Promise<T>): Promise<T | null> {
  try {
    return await get();
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError || (e as { name?: unknown } | null)?.name === "TransactionReceiptNotFoundError") return null;
    throw e;
  }
}

/** Resumes stuck "pending" batches (failure after sending, process restart, receipt timeout). */
export async function reconcileUsageBatches(): Promise<number> {
  const b = schema.usageBatches;
  const rows = await db
    .select()
    .from(b)
    .where(and(eq(b.status, "pending"), sql`${b.updatedAt} < now() - interval '30 seconds'`))
    .limit(20);
  const pc = chainContext().publicClient;
  let n = 0;
  for (const row of rows) {
    try {
      const sent = await sentTxsFor(USAGE_BATCH_KIND, row.id);
      // Only "receipt not found" means missing: any other RPC error throws and the batch waits for the next tick
      // (treating it as missing could release a batch that landed and count its uses twice).
      const journal = await Promise.all(
        sent.map(async (s) => {
          const receipt = await receiptOrMissing(() => pc.getTransactionReceipt({ hash: s.txHash as Hex }));
          return { status: s.status, hasReceipt: receipt !== null, receiptOk: receipt ? receipt.status === "success" : null, validBefore: s.validBefore, txHash: s.txHash };
        }),
      );
      const verdict = batchVerdict(journal, (Date.now() - row.createdAt.getTime()) / 1000);
      if (verdict === "confirmed") {
        const ok = journal.find((j) => j.status === "confirmed" || j.receiptOk === true)!;
        await finalizeBatch(row.id, ok.txHash);
        await processTxHash(ok.txHash as Hex).catch(() => undefined);
        n += row.count;
      } else if (verdict === "released") {
        await releaseBatch(row.id);
      }
    } catch (e) {
      console.error(`[jobs] usage batch ${row.id} reconcile:`, (e as Error).message);
    }
  }
  return n;
}

/** Uses by license, guarantee or free trial, recorded on-chain in batches (`recordUsageBatch`). */
export async function recordUsageBatchOnce(): Promise<number> {
  let total = await reconcileUsageBatches();
  const rows = await db
    .select({ id: schema.usageEvents.id, agentId: schema.usageEvents.agentId, hash: schema.usageEvents.responseHash })
    .from(schema.usageEvents)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.usageEvents.sessionId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.usageEvents.agentId))
    .where(
      and(
        eq(schema.usageEvents.tool, "activate_solver"),
        eq(schema.usageEvents.batched, false),
        isNull(schema.usageEvents.batchId),
        inArray(schema.sessions.access, ["license", "guarantee", "trial"]),
        // Platform Solvers have no on-chain record: never batched (the "platform" session is already out; double guard).
        notInArray(schema.usageEvents.agentId, [...PLATFORM_AGENT_IDS]),
        // Only Solvers registered on-chain.
        isNotNull(schema.agents.chainIndex),
        lt(schema.usageEvents.createdAt, sql`now() - interval '10 seconds'`),
      ),
    )
    .limit(1000);
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) if (r.agentId && !PLATFORM_AGENT_IDS.includes(r.agentId)) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  for (const [agentId, list] of byAgent) {
    const batchId = `batch_${randomId(8)}`;
    const ids = list.map((l) => l.id);
    const root = merkleRoot(list.map((l) => Buffer.from((l.hash ?? "").replace(/^0x/, ""), "hex")));
    try {
      // Reserve the uses and create the batch at once: without the reservation nothing is sent.
      await db.transaction(async (dbtx) => {
        const claimed = await dbtx
          .update(schema.usageEvents)
          .set({ batchId })
          .where(and(inArray(schema.usageEvents.id, ids), isNull(schema.usageEvents.batchId), eq(schema.usageEvents.batched, false)))
          .returning({ id: schema.usageEvents.id });
        if (claimed.length !== ids.length) throw new Error("uses already reserved by another batch");
        await dbtx.insert(schema.usageBatches).values({ id: batchId, agentId, count: list.length, merkleRoot: `0x${root.toString("hex")}` });
      });
    } catch (e) {
      // Nothing sent nor reserved: the next round tries again.
      console.error(`[jobs] usage batch prepare ${agentId}:`, (e as Error).message);
      continue;
    }
    try {
      const { hash } = await sendServerCalls({
        signer: "platform",
        lane: "usage",
        calls: recordUsageBatchCalls(callTargets(), { agentId: agentIdToBytes32(agentId), count: BigInt(list.length), merkleRoot: `0x${root.toString("hex")}` }),
        kind: USAGE_BATCH_KIND,
        ref: batchId,
      });
      await finalizeBatch(batchId, hash);
      await processTxHash(hash).catch(() => undefined);
      total += list.length;
    } catch (e) {
      // Reverted, failed or uncertain: the batch stays "pending" and reconcileUsageBatches decides from the journal.
      console.error(`[jobs] usage batch ${agentId} (${batchId}):`, (e as Error).message);
    }
  }
  return total;
}

/**
 * Storefront quality: a Solver whose average rating is below DELIST_MAX_RATING after DELIST_MIN_REVIEWS reviews leaves
 * the storefront (it keeps working for whoever already bought it).
 */
export async function delistLowRatedOnce(): Promise<number> {
  const rows = await db
    .update(schema.agents)
    .set({ listed: false, updatedAt: new Date() })
    .where(
      and(
        eq(schema.agents.listed, true),
        sql`${schema.agents.ratingCount} >= ${DELIST_MIN_REVIEWS}`,
        sql`${schema.agents.ratingSum}::float / nullif(${schema.agents.ratingCount}, 0) < ${DELIST_MAX_RATING}`,
      ),
    )
    .returning({ id: schema.agents.id, name: schema.agents.name });
  for (const r of rows) {
    void notifyCreator(r.id, `Solvers: "${r.name}" was removed from the storefront because its average rating dropped below ${DELIST_MAX_RATING}. People who already bought it can keep using it normally.`);
  }
  return rows.length;
}

/** Jobs of this area (exported for tests); `jobs` below adds every other area's. */
export const storeJobs: Job[] = [
  every(60_000, "sent transactions", () => reconcileSentTxs()),
  every(60_000, "auto release", autoReleaseOnce),
  every(60_000, "stale disputes", resolveStaleDisputesOnce),
  every(10 * 60_000, "usage batches", recordUsageBatchOnce),
  every(60_000, "guarantee texts", () => fillEscrowTexts()),
  every(60_000, "dispute texts", () => promoteDisputeDrafts()),
  every(60 * 60_000, "acceptance plans cleanup", async () => (await cleanupAcceptancePlansOnce()).length),
  every(60 * 60_000, "storefront: low rating", delistLowRatedOnce),
  every(6 * 60 * 60_000, "submissions cleanup", cleanupSubmissionsOnce),
];

export const jobs: Job[] = [indexerJob, ...paymentsJobs, ...publishJobs, ...storeJobs];
