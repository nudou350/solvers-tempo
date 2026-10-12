// Poll cursor of the indexer (D9), pure part: key, encoding and the range/rewind decisions.
//
// The cursor is the last FULLY processed block and its hash: `kv['indexer:evm:<chainId>'] = { block, blockHash }`.
// No cursor = nothing processed yet (scan from the start block). If the stored hash no longer matches the chain at that
// height, the cursor rewinds 32 blocks (reorg safety; Tempo has deterministic finality, so this only fires after a node
// or chain reset). Re-scanning is harmless: `processed_events` makes every log apply once.

import type { Hex } from "viem";

export type Cursor = { block: bigint; blockHash: Hex };

export const REWIND_BLOCKS = 32n;

export function cursorKey(chainId: number): string {
  return `indexer:evm:${chainId}`;
}

/** jsonb cannot hold a bigint: the block number is stored as a decimal string. */
export function encodeCursor(c: Cursor): { block: string; blockHash: string } {
  return { block: c.block.toString(), blockHash: c.blockHash.toLowerCase() };
}

export function decodeCursor(value: unknown): Cursor | null {
  const v = value as { block?: unknown; blockHash?: unknown } | null;
  if (!v || typeof v !== "object") return null;
  if ((typeof v.block !== "string" && typeof v.block !== "number") || !/^\d+$/.test(String(v.block))) return null;
  if (typeof v.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.blockHash)) return null;
  return { block: BigInt(v.block), blockHash: v.blockHash.toLowerCase() as Hex };
}

/**
 * Next block range to scan, or null when the indexer is up to date. `toBlock = latest − confirmations`, at most
 * `batch` blocks per range; never before `startBlock` (also when the start block was moved past an old cursor).
 */
export function nextRange(
  cursor: Cursor | null,
  o: { latest: bigint; confirmations: number; batch: number; startBlock: bigint },
): { from: bigint; to: bigint } | null {
  const target = o.latest - BigInt(Math.max(0, o.confirmations));
  let from = cursor ? cursor.block + 1n : o.startBlock;
  if (from < o.startBlock) from = o.startBlock;
  if (target < 0n || from > target) return null;
  const span = BigInt(Math.max(1, o.batch)) - 1n;
  const to = from + span < target ? from + span : target;
  return { from, to };
}

/** Is the stored cursor still on the chain? (`chainHash` null = the block does not exist any more.) */
export function cursorMatches(cursor: Cursor, chainHash: string | null | undefined): boolean {
  return !!chainHash && chainHash.toLowerCase() === cursor.blockHash.toLowerCase();
}

/** Block to rewind to after a hash mismatch; null = no cursor (rescan from the start block). */
export function rewindBlock(cursorBlock: bigint, startBlock: bigint, depth: bigint = REWIND_BLOCKS): bigint | null {
  const b = cursorBlock - depth;
  return b < startBlock ? null : b;
}
