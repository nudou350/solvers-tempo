// License rows of the mirror (`licenses`, id = ERC-721 tokenId as a decimal string). Database only: the caller reads
// the chain (`licenseOf`, `ownerOf`) and passes the values. Idempotent and safe to replay out of order: the owner and
// review always come from the CURRENT chain state; mint data (tx hash, version at mint) is written once.

import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Q } from "./db-types.js";

export type LicenseRowInput = {
  tokenId: string;
  agentId: string;
  /** Current owner; null = burned. */
  owner: string | null;
  /** Owner to store when a burned token was never mirrored (the `from` of the burn). */
  lastOwner?: string | null;
  originalPrice: bigint;
  /** Review the license backs on-chain (reviewId), null when unused. */
  reviewId: string | null;
  /** When the current owner got it (block time of the transfer that gave it to them). */
  acquiredAt: Date;
  /** Mint transaction (only from the mint event). */
  txHash?: string | null;
  /** Agent versionHash current at mint (only from the mint event). */
  versionHash?: string | null;
};

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Upserts a license. When the OWNER changes, `acquired_at` takes the new value; otherwise it is kept. A burned token
 * keeps its last owner and gets `burned = true`. `tx_hash` and `version_hash` are only filled when still empty.
 */
export async function upsertLicenseRow(q: Q, v: LicenseRowInput): Promise<void> {
  const t = schema.licenses;
  const burned = v.owner === null;
  const owner = (v.owner ?? v.lastOwner ?? ZERO).toLowerCase();
  const changed = sql`${t.ownerWallet} <> excluded.owner_wallet`;
  await q
    .insert(t)
    .values({
      id: v.tokenId,
      agentId: v.agentId,
      ownerWallet: owner,
      originalPrice: v.originalPrice,
      reviewId: v.reviewId,
      burned,
      acquiredAt: v.acquiredAt,
      type: "permanent",
      txHash: v.txHash?.toLowerCase() ?? null,
      versionHash: v.versionHash?.toLowerCase().replace(/^0x/, "") ?? null,
    })
    .onConflictDoUpdate({
      target: t.id,
      set: {
        agentId: sql`excluded.agent_id`,
        // A burn keeps the last known owner.
        ownerWallet: burned ? sql`${t.ownerWallet}` : sql`excluded.owner_wallet`,
        acquiredAt: burned ? sql`${t.acquiredAt}` : sql`case when ${changed} then excluded.acquired_at else ${t.acquiredAt} end`,
        originalPrice: sql`excluded.original_price`,
        reviewId: sql`excluded.review_id`,
        burned: sql`excluded.burned`,
        txHash: sql`coalesce(${t.txHash}, excluded.tx_hash)`,
        versionHash: sql`coalesce(${t.versionHash}, excluded.version_hash)`,
      },
    });
}

/** Marks a license as burned (the row stays: the cap slot is never freed and the history remains). */
export async function markLicenseBurned(q: Q, tokenId: string): Promise<void> {
  await q.update(schema.licenses).set({ burned: true }).where(eq(schema.licenses.id, tokenId));
}

/** Records the review a license backs (`LicenseReviewed`). */
export async function setLicenseReview(q: Q, tokenId: string, reviewId: string | null): Promise<void> {
  await q.update(schema.licenses).set({ reviewId }).where(eq(schema.licenses.id, tokenId));
}
