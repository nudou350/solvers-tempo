import { unitsToNumber } from "@solvers/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { SYNC_OK, SYNC_UNAPPROVED, chainMatchesApproved, type ApprovedVersion, type ChainVersion } from "../indexer/approved-version.js";
import { HttpError } from "../lib/http.js";
import { assertNotPlatformAgent } from "../runtime/platform-agents.js";
import { agentOnChain } from "./chain-reads.js";

type PricedAgent = Pick<typeof schema.agents.$inferSelect, "id" | "price"> & { syncFlag?: string };

/** What `assertFreshPrice` needs from outside (RPC and database); injectable in tests. */
export type FreshPriceDeps = {
  /** Version and price on-chain, or null when the Solver is not registered on-chain. */
  readChain: (agentId: string) => Promise<ChainVersion | null>;
  approvedVersions: (agentId: string) => Promise<ApprovedVersion[]>;
  /** Mirrors the verdict in the database (price and version when approved, only the flag when not). */
  sync: (agentId: string, onchain: ChainVersion, approved: boolean) => Promise<unknown>;
};

/** Versions that passed review (`agent_published_versions`): the chain is checked against them (PACKAGE_SPEC.md 15.4). */
export async function loadApprovedVersions(agentId: string): Promise<ApprovedVersion[]> {
  return db
    .select({ version: schema.agentPublishedVersions.version, versionHash: schema.agentPublishedVersions.versionHash, priceUsdc: schema.agentPublishedVersions.priceUsdc })
    .from(schema.agentPublishedVersions)
    .where(eq(schema.agentPublishedVersions.agentId, agentId));
}

const realDeps: FreshPriceDeps = {
  async readChain(agentId) {
    const a = await agentOnChain(agentId);
    return a ? { version: a.version, versionHash: a.versionHash, price: a.price } : null;
  },
  approvedVersions: loadApprovedVersions,
  async sync(agentId, onchain, approved) {
    // Same rule as the indexer's mirror (`withApprovalFlag`): an unapproved chain version never reaches the price columns.
    await db
      .update(schema.agents)
      .set(
        approved
          ? { version: onchain.version, versionHash: onchain.versionHash.replace(/^0x/, ""), price: onchain.price, syncFlag: SYNC_OK, updatedAt: new Date() }
          : { syncFlag: SYNC_UNAPPROVED, updatedAt: new Date() },
      )
      .where(eq(schema.agents.id, agentId));
  },
};

/** 409 `price_in_review`: the chain has a version/price that review has not approved yet (PACKAGE_SPEC.md 15.4). */
export function priceInReview(): HttpError {
  return new HttpError(409, "This specialist is under review and not for sale right now. Please try again later.", "price_in_review");
}

/**
 * Re-reads the on-chain price before a purchase is built. The mirror may lag behind a `PricingUpdated` the indexer has
 * not processed yet; if the price differs, mirror it and answer 409 with the new price, so the buyer confirms the real
 * amount instead of the purchase reverting with `PriceChanged`.
 *
 * A chain version/price that review did not approve (the creator called `updateVersion`/`updatePricing` directly) blocks
 * the sale with 409 `price_in_review` instead of `price_changed` (the "new" price is not what the platform approved, and
 * the database keeps showing the approved one). Sales resume when the chain reverts or a new approval covers that hash.
 */
export async function assertFreshPrice(row: PricedAgent, deps: FreshPriceDeps = realDeps): Promise<void> {
  // A platform Solver has no on-chain record nor price: 409 platform_agent_not_for_sale before any RPC.
  assertNotPlatformAgent(row);
  const onchain = await deps.readChain(row.id);
  if (!onchain) return;
  const approved = chainMatchesApproved(onchain, await deps.approvedVersions(row.id));
  const flagged = row.syncFlag !== undefined && row.syncFlag !== SYNC_OK;
  if (!approved) {
    // Mirror the flag (storefront and dashboard); the decision comes from the live check, not from the mirror.
    if (!flagged) await deps.sync(row.id, onchain, false);
    throw priceInReview();
  }
  if (flagged || onchain.price !== row.price) await deps.sync(row.id, onchain, true);
  if (onchain.price === row.price) return;
  throw new HttpError(409, "This specialist's price has changed. Check the new amount to continue.", "price_changed", {
    priceUnits: onchain.price.toString(),
    priceUsdc: unitsToNumber(onchain.price, env.PAYMENT_TOKEN_DECIMALS),
    previousPriceUsdc: unitsToNumber(row.price, env.PAYMENT_TOKEN_DECIMALS),
  });
}
