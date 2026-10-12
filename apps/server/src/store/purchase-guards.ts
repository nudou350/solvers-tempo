import { and, eq } from "drizzle-orm";
import type { ChargeKind } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { badRequest } from "../lib/http.js";
import { agentIsAvailable } from "../runtime/availability.js";
import { refreshLicenseOwner } from "../runtime/licenses.js";
import { assertNotPlatformAgent } from "../runtime/platform-agents.js";
import { getPackage } from "../runtime/packages.js";
import { assertFreshPrice } from "./fresh-price.js";
import { assertEntriesOpen } from "./pause-gate.js";
import { notListedBlock, purchaseBlock } from "./purchase-rules.js";
import { assertSupplyOpen } from "./supply.js";

type AgentRow = typeof schema.agents.$inferSelect;

/** A license of the Solver the wallet still holds (owner re-checked on-chain; a transferred license does not count). */
async function ownedLicenseId(wallet: string, agentId: string): Promise<string | null> {
  const rows = await db
    .select({ id: schema.licenses.id, owner: schema.licenses.ownerWallet })
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, agentId), eq(schema.licenses.burned, false)));
  for (const r of rows) {
    // RPC down: the mirror's owner counts (refusing a duplicate purchase costs less than charging twice).
    const owner = await refreshLicenseOwner(r.id).catch(() => r.owner);
    if (owner === wallet) return r.id;
  }
  return null;
}

/** Creator wallet of a Solver (from the creators table), lowercase, or null. */
export async function creatorWalletOf(agent: Pick<AgentRow, "creatorId">): Promise<string | null> {
  const [creator] = await db.select({ wallet: schema.creators.wallet }).from(schema.creators).where(eq(schema.creators.id, agent.creatorId));
  return creator?.wallet ?? null;
}

/**
 * License purchase guards (purchase intents, Pix and agent-pay, before any charge): 409 `already_owned` (with
 * `licenseId`) or 400 `creator_cannot_buy`.
 */
export async function assertCanPurchase(wallet: string, agent: AgentRow): Promise<void> {
  assertNotPlatformAgent(agent); // free platform Solver: there is no license to sell (409 platform_agent_not_for_sale)
  const block = purchaseBlock({ wallet, creatorWallet: await creatorWalletOf(agent), ownedLicenseId: await ownedLicenseId(wallet, agent.id) });
  if (block) throw block;
}

/** Any purchase (license, credits, guarantee): the Solver must be listed and loadable (409 `agent_not_listed`). */
export function assertListedAndLoadable(agent: Pick<AgentRow, "id" | "listed">): void {
  const block = notListedBlock({ listed: agent.listed, hasPackage: getPackage(agent.id) !== undefined });
  if (block) throw block;
}

/**
 * Every precheck of a new sale, in the order the old purchase route ran them, for the payments area (purchase intents,
 * Pix charges, agent-pay) to call BEFORE writing a ledger row:
 * pause (ENTRIES) → platform Solver → availability (on-chain status + kill switch) → cap (license) → listed/loadable →
 * on-chain price and approval → ownership / creator (license) or self-purchase (credits).
 * Guarantees also need `planEscrowPurchase` (store/escrow.ts) for the limits and milestones.
 */
export async function assertPurchasable(wallet: string, agent: AgentRow, kind: ChargeKind): Promise<void> {
  await assertEntriesOpen(kind);
  assertNotPlatformAgent(agent);
  // Suspended by the platform (platformStatus) does not sell either: `status` is only the on-chain mirror.
  if (!agentIsAvailable(agent)) throw badRequest("This specialist is not available for purchase right now.", "agent_unavailable");
  if (kind === "license") assertSupplyOpen(agent);
  assertListedAndLoadable(agent);
  await assertFreshPrice(agent);
  if (kind === "license") await assertCanPurchase(wallet, agent);
  if (kind === "credits") {
    // X11: credits also allow reviews, so a creator cannot buy credits of their own Solver either.
    const creator = await creatorWalletOf(agent);
    if (creator && creator === wallet.toLowerCase()) throw badRequest("The specialist's creator can't buy their own credits.", "creator_cannot_buy");
    if (agent.pricePerUse <= 0n) throw badRequest("This specialist does not sell pay-per-use credits.", "pay_per_use_disabled");
  }
}
