import { solversLicenseAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, normalizeAddress } from "@solvers/shared";
import { eq } from "drizzle-orm";
import { getAbiItem, type Address } from "viem";

import { chainContext } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { licenseOnChain, licenseOwnerOf } from "../store/chain-reads.js";

// License ownership for access decisions: the `licenses` table is the indexer's mirror (owner updated on every ERC-721
// `Transfer`), re-checked with `ownerOf` before granting access, plus a log-scan fallback for purchases the indexer has
// not reached yet.

/** Most blocks scanned by the fallback (Moderato refuses `eth_getLogs` ranges above 100,000). */
const MAX_SCAN_BLOCKS = 99_000n;

/**
 * Owner of a license read on-chain, written back to the mirror when it moved (transfer) or vanished (burn).
 * Returns the lowercase owner, or null when the token no longer exists. Throws on RPC errors (callers fall back to the
 * mirror, never to the wallet that asked).
 */
export async function refreshLicenseOwner(tokenId: string): Promise<string | null> {
  const owner = await licenseOwnerOf(BigInt(tokenId));
  const [row] = await db.select({ owner: schema.licenses.ownerWallet, burned: schema.licenses.burned }).from(schema.licenses).where(eq(schema.licenses.id, tokenId));
  if (row) {
    if (owner === null && !row.burned) await db.update(schema.licenses).set({ burned: true }).where(eq(schema.licenses.id, tokenId));
    else if (owner !== null && owner !== row.owner) await db.update(schema.licenses).set({ ownerWallet: owner, burned: false }).where(eq(schema.licenses.id, tokenId));
  }
  return owner;
}

/** First block the indexer has not processed yet (its cursor + 1), or the deployment block. */
async function firstUnindexedBlock(): Promise<bigint> {
  const c = chainContext();
  const [row] = await db.select({ value: schema.kv.value }).from(schema.kv).where(eq(schema.kv.key, `indexer:evm:${env.CHAIN_ID}`));
  const block = (row?.value as { block?: string | number } | undefined)?.block;
  return block !== undefined && block !== null ? BigInt(block) + 1n : c.deployment.deployBlock;
}

const transferEvent = getAbiItem({ abi: solversLicenseAbi, name: "Transfer" });

/**
 * Licenses of `agentId` that `wallet` holds on-chain but the mirror does not show yet (bought or received after the
 * indexer's cursor). Cheap when the wallet holds no license (`balanceOf` = 0); otherwise scans the License `Transfer`
 * logs to the wallet after the cursor and writes the rows it confirms. Returns token ids (decimal strings).
 */
export async function findUnindexedLicenses(wallet: string, agentId: string): Promise<string[]> {
  const c = chainContext();
  const owner = normalizeAddress(wallet);
  const balance = await c.publicClient.readContract({ address: c.deployment.license, abi: solversLicenseAbi, functionName: "balanceOf", args: [owner] });
  if (balance === 0n) return [];
  const latest = await c.publicClient.getBlockNumber();
  let from = await firstUnindexedBlock();
  if (from > latest) return [];
  if (latest - from > MAX_SCAN_BLOCKS) from = latest - MAX_SCAN_BLOCKS;
  const logs = await c.publicClient.getLogs({ address: c.deployment.license, event: transferEvent, args: { to: owner }, fromBlock: from, toBlock: latest });
  const want = agentIdToBytes32(agentId);
  const found: string[] = [];
  for (const log of logs) {
    const tokenId = log.args.tokenId;
    if (tokenId === undefined) continue;
    const id = tokenId.toString();
    if (found.includes(id)) continue;
    const [lic, current] = await Promise.all([licenseOnChain(tokenId), licenseOwnerOf(tokenId)]);
    if (!lic || lic.agentId !== want || current !== owner) continue;
    await db
      .insert(schema.licenses)
      .values({
        id,
        agentId,
        ownerWallet: owner as Address,
        originalPrice: lic.originalPrice,
        acquiredAt: new Date(lic.mintedAt * 1000),
        txHash: log.transactionHash?.toLowerCase() ?? null,
      })
      .onConflictDoUpdate({ target: schema.licenses.id, set: { ownerWallet: owner as Address, burned: false } });
    found.push(id);
  }
  return found;
}
