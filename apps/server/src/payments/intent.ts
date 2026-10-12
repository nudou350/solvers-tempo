import { chainMatchesApproved, type ApprovedVersion } from "../indexer/approved-version.js";
import { loadApprovedVersions, priceInReview } from "../store/fresh-price.js";
import { and, eq } from "drizzle-orm";
import { PAUSE_FLAGS, isAgentId, soldOutText, type ChargeIntent, type PurchaseIntentInput } from "@solvers/shared";

import { db, schema } from "../db/index.js";
import { HttpError, badRequest, notFound } from "../lib/http.js";
import { agentIsAvailable } from "../runtime/availability.js";
import { assertNotPlatformAgent } from "../runtime/platform-agents.js";
import { assertNotPaused } from "../store/pause-rules.js";
import { notListedBlock, purchaseBlock } from "../store/purchase-rules.js";
import { isRowSoldOut } from "../store/supply-rules.js";
import { readAgent, readMinPrice, readPauseFlags, type ChainAgent } from "./chain.js";
import { planEscrow } from "./escrow-plan.js";

// Shared guards of every purchase (POST /api/purchases/intent, POST /api/pix/charges, agent-pay orders), run BEFORE a
// ledger row is written or anybody is charged. The contracts are the real barrier; these checks give a clear answer
// early and keep the platform from charging for something the chain would refuse. On-chain values (status, price,
// supply, pause, min price) are read live; the DB row adds the platform kill switch and the catalog state.

export type AgentRow = typeof schema.agents.$inferSelect;

export type PreparedPurchase = {
  intent: ChargeIntent;
  agent: AgentRow;
  chainAgent: ChainAgent;
  /** Token units the purchase costs (license price, credits total, escrow total). */
  amount: bigint;
  /** Stored in `payment_ledger.intent` (what exactly to fulfil). */
  details: Record<string, unknown>;
};

export type PrepareDeps = {
  /** The package is loadable on this server (default: the runtime package registry). */
  hasPackage?: (agentId: string) => boolean;
  /** Approved (reviewed) versions of the agent (default: agent_published_versions). */
  approvedVersions?: (agentId: string) => Promise<ApprovedVersion[]>;
};

let defaultHasPackage: ((agentId: string) => boolean) | null = null;

async function hasPackageDefault(agentId: string): Promise<boolean> {
  if (!defaultHasPackage) {
    const mod = await import("../runtime/packages.js");
    defaultHasPackage = (id) => mod.getPackage(id) !== undefined;
  }
  return defaultHasPackage(agentId);
}

/** Replaces the package check (tests, or a deployment that serves packages from elsewhere). */
export function setPackageCheck(fn: ((agentId: string) => boolean) | null): void {
  defaultHasPackage = fn;
}

export async function findAgent(idOrSlug: string): Promise<AgentRow> {
  const [row] = await db
    .select()
    .from(schema.agents)
    .where(isAgentId(idOrSlug) ? eq(schema.agents.id, idOrSlug) : eq(schema.agents.slug, idOrSlug))
    .limit(1);
  if (!row) throw notFound("Specialist not found");
  return row;
}

/** A license of this agent the wallet still holds (indexer mirror). */
async function ownedLicenseId(wallet: string, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.licenses.id })
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, agentId), eq(schema.licenses.burned, false)))
    .limit(1);
  return row?.id ?? null;
}

async function chainOrUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error("[payments] chain read failed:", (e as Error).message);
    throw new HttpError(503, "The network is unavailable right now. Try again in a moment.", "chain_unavailable");
  }
}

/** Agent-level checks shared by every kind. Returns the DB row and the on-chain agent. */
export async function sellableAgent(idOrSlug: string, deps: PrepareDeps = {}): Promise<{ agent: AgentRow; chainAgent: ChainAgent }> {
  const agent = await findAgent(idOrSlug);
  assertNotPlatformAgent(agent);
  // Fail-open like the store (pause-rules.ts): unreadable flags do not block; the contract stays the barrier.
  assertNotPaused(await readPauseFlags().catch(() => null), PAUSE_FLAGS.ENTRIES, "purchase");
  const chainAgent = await chainOrUnavailable(() => readAgent(agent.id));
  if (!chainAgent || chainAgent.status !== 1 || !agentIsAvailable(agent)) {
    throw new HttpError(409, "This specialist is not available for purchase right now.", "agent_unavailable");
  }
  // The on-chain version and price must be a reviewed one (same rule as the store's assertFreshPrice): a creator who
  // changes the version or price on-chain without review cannot sell it through any payment path.
  const approved = await (deps.approvedVersions ?? loadApprovedVersions)(agent.id);
  if (!chainMatchesApproved({ version: chainAgent.version, versionHash: chainAgent.versionHash, price: chainAgent.price }, approved)) {
    throw priceInReview();
  }
  const hasPackage = deps.hasPackage ? deps.hasPackage(agent.id) : await hasPackageDefault(agent.id);
  const block = notListedBlock({ listed: agent.listed, hasPackage });
  if (block) throw block;
  return { agent, chainAgent };
}

/** License-specific guards: already owned, creator buying their own Solver, sold out, price moved. */
export async function assertLicenseSellable(
  agent: AgentRow,
  chainAgent: ChainAgent,
  buyer: string,
  expectedPrice?: bigint,
): Promise<void> {
  const block = purchaseBlock({ wallet: buyer, creatorWallet: chainAgent.creator, ownedLicenseId: await ownedLicenseId(buyer, agent.id) });
  if (block) throw block;
  if (isRowSoldOut({ totalSales: chainAgent.totalSales, maxLicenses: chainAgent.maxSupply === 0 ? null : chainAgent.maxSupply })) {
    throw new HttpError(409, soldOutText(agent.name), "sold_out");
  }
  if (expectedPrice !== undefined && expectedPrice !== chainAgent.price) {
    throw new HttpError(409, "The price changed. Review the new price and try again.", "price_changed", { priceUnits: chainAgent.price.toString() });
  }
}

/** Validates what the session wallet wants to buy and computes exactly what will be charged. */
export async function preparePurchase(input: PurchaseIntentInput, buyerWallet: string, deps: PrepareDeps = {}): Promise<PreparedPurchase> {
  const buyer = buyerWallet.toLowerCase() as `0x${string}`;
  const { agent, chainAgent } = await sellableAgent(input.agentId, deps);
  let prepared: Omit<PreparedPurchase, "agent" | "chainAgent">;
  if (input.kind === "license") {
    const expected = input.expectedPriceUnits !== undefined ? BigInt(input.expectedPriceUnits) : undefined;
    await assertLicenseSellable(agent, chainAgent, buyer, expected);
    prepared = {
      intent: { kind: "license", agentId: agent.id, buyer, expectedPrice: chainAgent.price },
      amount: chainAgent.price,
      details: { expectedPrice: chainAgent.price.toString() },
    };
  } else if (input.kind === "credits") {
    if (chainAgent.creator === buyer) throw badRequest("The specialist's creator can't buy their own credits.", "creator_cannot_buy");
    if (chainAgent.pricePerUse === 0n) throw badRequest("This Solver does not sell pay-per-use credits.", "pay_per_use_disabled");
    const total = chainAgent.pricePerUse * BigInt(input.amount);
    prepared = {
      intent: { kind: "credits", agentId: agent.id, buyer, amount: input.amount, maxTotal: total },
      amount: total,
      details: { amount: input.amount, maxTotal: total.toString() },
    };
  } else {
    const plan = await planEscrow({ agent, buyer, task: input.task });
    const total = plan.milestones.reduce((s, m) => s + m.amount, 0n);
    prepared = {
      intent: {
        kind: "escrow",
        agentId: agent.id,
        buyer,
        milestones: plan.milestones,
        reviewWindowSecs: plan.reviewWindowSecs,
        deliveryDays: plan.deliveryDays,
      },
      amount: total,
      details: {
        milestones: plan.milestones.map((m) => ({ amount: m.amount.toString(), criteriaHash: m.criteriaHash })),
        reviewWindowSecs: plan.reviewWindowSecs,
        deliveryDays: plan.deliveryDays,
        task: plan.details,
      },
    };
  }
  const minPrice = await chainOrUnavailable(readMinPrice);
  if (prepared.amount < minPrice) {
    throw badRequest("The amount is below the minimum purchase.", "below_min_price", { minPriceUnits: minPrice.toString() });
  }
  return { ...prepared, agent, chainAgent };
}

/** Rebuilds the `ChargeIntent` of a ledger row (its `intent` jsonb holds what is not in the columns). */
export function intentOfRow(row: { kind: string; agentId: string; buyerWallet: string; tokenAmount: bigint; intent: Record<string, unknown> }): ChargeIntent {
  const buyer = row.buyerWallet as `0x${string}`;
  const d = row.intent;
  if (row.kind === "license") return { kind: "license", agentId: row.agentId, buyer, expectedPrice: row.tokenAmount };
  if (row.kind === "credits") return { kind: "credits", agentId: row.agentId, buyer, amount: Number(d.amount), maxTotal: row.tokenAmount };
  const ms = (d.milestones as { amount: string; criteriaHash: `0x${string}` }[]) ?? [];
  return {
    kind: "escrow",
    agentId: row.agentId,
    buyer,
    milestones: ms.map((m) => ({ amount: BigInt(m.amount), criteriaHash: m.criteriaHash })),
    reviewWindowSecs: Number(d.reviewWindowSecs),
    deliveryDays: Number(d.deliveryDays ?? 0),
  };
}

/** `details` (ledger `intent` jsonb) of a `ChargeIntent` built elsewhere (tests, fake provider). */
export function detailsOfIntent(intent: ChargeIntent): Record<string, unknown> {
  if (intent.kind === "license") return { expectedPrice: intent.expectedPrice.toString() };
  if (intent.kind === "credits") return { amount: intent.amount, maxTotal: intent.maxTotal.toString() };
  return {
    milestones: intent.milestones.map((m) => ({ amount: m.amount.toString(), criteriaHash: m.criteriaHash })),
    reviewWindowSecs: intent.reviewWindowSecs,
    deliveryDays: intent.deliveryDays,
  };
}

export function amountOfIntent(intent: ChargeIntent): bigint {
  if (intent.kind === "license") return intent.expectedPrice;
  if (intent.kind === "credits") return intent.maxTotal;
  return intent.milestones.reduce((s, m) => s + m.amount, 0n);
}
