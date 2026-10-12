// Manual reprocessing of the indexer (recovery of transactions the poller could not index, or a mirror refresh).
//
//   pnpm --filter @solvers/server cli:reindex --dead                      puts "dead" failures back in the queue and retries now
//   pnpm --filter @solvers/server cli:reindex --tx <hash> [<hash>...]     reprocesses one or more transactions
//   pnpm --filter @solvers/server cli:reindex --from-block N [--to-block M]   rescans a block range (default up to latest)
//
// Everything is idempotent: the mirror is rebuilt from the current on-chain state (already processed events are
// re-applied as mirror refreshes; payment hooks and notifications never run twice). The poll cursor is not moved.

import { initChain } from "../chain/index.js";
import { pool } from "../db/index.js";
import { reprocessTxs, retryFailures, reviveDeadFailures } from "../indexer/processor.js";
import { scanRange } from "../indexer/poller.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type ReindexArgs = { dead: boolean; txs: string[]; fromBlock: bigint | null; toBlock: bigint | null };

/** Parses the CLI arguments (pure). Throws on malformed values. */
export function parseReindexArgs(args: readonly string[]): ReindexArgs {
  const valueOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const block = (name: string): bigint | null => {
    const v = valueOf(name);
    if (v === undefined) return null;
    if (!/^\d+$/.test(v)) throw new Error(`${name} expects a block number, got ${v ?? "nothing"}`);
    return BigInt(v);
  };
  const txs: string[] = [];
  const i = args.indexOf("--tx");
  if (i >= 0) {
    for (const a of args.slice(i + 1)) {
      if (a.startsWith("--")) break;
      if (!HASH_RE.test(a)) throw new Error(`not a transaction hash: ${a}`);
      txs.push(a.toLowerCase());
    }
    if (txs.length === 0) throw new Error("--tx expects at least one transaction hash");
  }
  return { dead: args.includes("--dead"), txs, fromBlock: block("--from-block"), toBlock: block("--to-block") };
}

async function main() {
  const args = parseReindexArgs(process.argv.slice(2));
  const c = await initChain();
  let did = false;
  if (args.dead) {
    did = true;
    console.log(`${await reviveDeadFailures()} "dead" failures back in the queue`);
    console.log(`${await retryFailures(500)} resolved now`);
  }
  if (args.txs.length) {
    did = true;
    console.log("transactions:", await reprocessTxs(args.txs));
  }
  if (args.fromBlock !== null) {
    did = true;
    const to = args.toBlock ?? (await c.publicClient.getBlockNumber({ cacheTime: 0 }));
    console.log(`blocks ${args.fromBlock}..${to}:`, await scanRange(args.fromBlock, to, { force: true }));
  }
  if (!did) console.log("usage: cli:reindex [--dead] [--tx <hash>...] [--from-block N [--to-block M]]");
}

if (process.argv[1] && /reindex\.(ts|js)$/.test(process.argv[1])) {
  try {
    await main();
  } finally {
    await pool.end();
  }
  process.exit(0);
}
