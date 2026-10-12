// Poller (D9): `eth_getLogs` over the six contract addresses every INDEXER_POLL_MS, up to `latest − INDEXER_CONFIRMATIONS`,
// in ranges of at most INDEXER_BLOCK_BATCH blocks (Moderato caps a range at 100,000). No webhook.

import { eq } from "drizzle-orm";
import { BlockNotFoundError, type Address } from "viem";
import { CONTRACT_KEYS } from "@solvers/contracts-client";
import { chainContext } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { every, type Job } from "../lib/jobs.js";
import { cursorKey, cursorMatches, decodeCursor, encodeCursor, nextRange, rewindBlock, type Cursor } from "./cursor.js";
import { processLogs, retryFailures } from "./processor.js";
import { getLogsSplitting } from "./retry-policy.js";
import { newReads } from "./sync.js";

export type PollOptions = {
  /** kv key of the cursor (default `indexer:evm:<CHAIN_ID>`; tests use their own). */
  cursorKey?: string;
  /** First block to scan (default INDEXER_START_BLOCK, else the deployment's deployBlock). */
  startBlock?: bigint;
  confirmations?: number;
  batch?: number;
  /** Ranges per call (a far-behind indexer catches up over several ticks). */
  maxRanges?: number;
  /** Retry due failures at the end (default true). */
  retry?: boolean;
};

export type PollResult = {
  from: bigint | null;
  to: bigint | null;
  ranges: number;
  events: number;
  applied: number;
  failedTxs: number;
  /** Set when the cursor's block hash no longer matched: the block the cursor went back to (null = the start block). */
  rewoundTo?: bigint | null;
  retried: number;
};

export async function readCursor(key: string): Promise<Cursor | null> {
  const [row] = await db.select().from(schema.kv).where(eq(schema.kv.key, key));
  return row ? decodeCursor(row.value) : null;
}

export async function writeCursor(key: string, c: Cursor | null): Promise<void> {
  if (!c) {
    await db.delete(schema.kv).where(eq(schema.kv.key, key));
    return;
  }
  const value = encodeCursor(c);
  await db.insert(schema.kv).values({ key, value }).onConflictDoUpdate({ target: schema.kv.key, set: { value, updatedAt: new Date() } });
}

async function blockHash(n: bigint): Promise<string | null> {
  try {
    return (await chainContext().publicClient.getBlock({ blockNumber: n })).hash;
  } catch (e) {
    if (e instanceof BlockNotFoundError) return null;
    throw e;
  }
}

export function defaultStartBlock(): bigint {
  return env.INDEXER_START_BLOCK !== undefined ? BigInt(env.INDEXER_START_BLOCK) : chainContext().deployment.deployBlock;
}

/** The six contract addresses whose logs are indexed. */
export function indexedAddresses(): Address[] {
  const d = chainContext().deployment;
  return CONTRACT_KEYS.map((k) => d[k]);
}

/** Logs of the indexed contracts in [from, to]; a range the RPC refuses as too large is halved and retried. */
export function indexedLogs(from: bigint, to: bigint) {
  const pc = chainContext().publicClient;
  const address = indexedAddresses();
  return getLogsSplitting((f, t) => pc.getLogs({ address, fromBlock: f, toBlock: t }), from, to);
}

/**
 * Scans and applies the given block range without touching the cursor (reindex). With `force`, the mirror effects of
 * already processed events are re-applied.
 */
export async function scanRange(from: bigint, to: bigint, o: { batch?: number; force?: boolean } = {}): Promise<{ events: number; applied: number; failedTxs: number }> {
  const batch = BigInt(Math.max(1, o.batch ?? env.INDEXER_BLOCK_BATCH));
  const reads = newReads();
  const total = { events: 0, applied: 0, failedTxs: 0 };
  for (let f = from; f <= to; f += batch) {
    const t = f + batch - 1n < to ? f + batch - 1n : to;
    const logs = await indexedLogs(f, t);
    const s = await processLogs(logs, { force: o.force, reads });
    total.events += s.events;
    total.applied += s.applied;
    total.failedTxs += s.failedTxs;
  }
  return total;
}

/** One poll round: verify the cursor (rewind on a hash mismatch), scan new ranges, advance the cursor, retry failures. */
export async function pollOnce(o: PollOptions = {}): Promise<PollResult> {
  const c = chainContext();
  const pc = c.publicClient;
  const key = o.cursorKey ?? cursorKey(env.CHAIN_ID);
  const startBlock = o.startBlock ?? defaultStartBlock();
  const result: PollResult = { from: null, to: null, ranges: 0, events: 0, applied: 0, failedTxs: 0, retried: 0 };

  let cursor = await readCursor(key);
  // Reorg / chain reset safety: walk back 32 blocks at a time until the stored hash is on the chain again.
  for (let i = 0; cursor && i < 64; i++) {
    if (cursorMatches(cursor, await blockHash(cursor.block))) break;
    const back = rewindBlock(cursor.block, startBlock);
    const hash = back === null ? null : await blockHash(back);
    console.warn(`[indexer] cursor block ${cursor.block} no longer matches the chain; rewinding to ${back ?? `start ${startBlock}`}`);
    cursor = back !== null && hash ? { block: back, blockHash: hash as Cursor["blockHash"] } : back !== null ? { block: back, blockHash: `0x${"0".repeat(64)}` } : null;
    result.rewoundTo = cursor ? cursor.block : null;
    await writeCursor(key, cursor);
  }

  // cacheTime 0: viem otherwise reuses the block number for its polling interval (a stale `latest`).
  const latest = await pc.getBlockNumber({ cacheTime: 0 });
  const reads = newReads();
  const maxRanges = o.maxRanges ?? 50;
  for (; result.ranges < maxRanges; result.ranges++) {
    const range = nextRange(cursor, {
      latest,
      confirmations: o.confirmations ?? env.INDEXER_CONFIRMATIONS,
      batch: o.batch ?? env.INDEXER_BLOCK_BATCH,
      startBlock,
    });
    if (!range) break;
    const logs = await indexedLogs(range.from, range.to);
    const s = await processLogs(logs, { reads });
    result.events += s.events;
    result.applied += s.applied;
    result.failedTxs += s.failedTxs;
    result.from ??= range.from;
    result.to = range.to;
    const hash = await blockHash(range.to);
    if (!hash) break; // the chain moved under us; the next round re-checks the cursor
    cursor = { block: range.to, blockHash: hash as Cursor["blockHash"] };
    await writeCursor(key, cursor);
  }
  if (o.retry ?? true) result.retried = await retryFailures();
  return result;
}

/** The periodic poll (src/jobs.ts lists it). Does nothing when INDEXER_ENABLED is off. */
const job = every(env.INDEXER_POLL_MS, "indexer", async () => (await pollOnce()).applied);

export const indexerJob: Job = {
  name: job.name,
  start() {
    if (env.INDEXER_ENABLED) job.start();
  },
  stop() {
    job.stop();
  },
};

export const startIndexer = (): void => indexerJob.start();
export const stopIndexer = (): void => indexerJob.stop();
