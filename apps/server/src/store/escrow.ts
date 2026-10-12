import { Router } from "express";
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  cancelUndeliveredCalls,
  openDisputeCalls,
  releaseMilestoneCalls,
  resolveDisputeCalls,
  resolveStaleDisputeCalls,
  submitReviewCalls,
  submitReviewWithCreditsCalls,
  type MilestoneInput,
} from "@solvers/chain";
import { solversReviewsAbi } from "@solvers/contracts-client";
import {
  AGENT_STATUS,
  agentIdToBytes32,
  DELIST_MAX_RATING,
  DELIST_MIN_REVIEWS,
  FULL_LEVEL_PURCHASES,
  GUARANTEE_LIMITS_USDC,
  MAX_BUYER_DISPUTES_LOST,
  SINGLE_MILESTONE_MAX_USDC,
  splitGuaranteeUnits,
  type EscrowDetail,
  type EscrowTaskInput,
  type GuaranteeStatus,
  type TxResponse,
} from "@solvers/shared";
import type { Address, Hex } from "viem";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { chainContext, explorerUrl } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { processTxHash } from "../indexer/index.js";
import { randomId, sha256 } from "../lib/crypto.js";
import { badRequest, forbidden, h, HttpError, notFound, parse } from "../lib/http.js";
import { displayUnits, unitsFromNumber } from "../lib/money.js";
import { notifyCreator } from "../notify/telegram.js";
import { isTerminalEscrowStatus } from "../runtime/access-rules.js";
import { agentIsAvailable } from "../runtime/availability.js";
import { splitCriteria } from "../runtime/guarantee-text.js";
import { refreshLicenseOwner } from "../runtime/licenses.js";
import { assertNotPlatformAgent } from "../runtime/platform-agents.js";
import { criteriaHash, filesHash, readDeliverable, saveAcceptance } from "../verifier/deliverables.js";
import { findAgentRow, guaranteeOffer } from "./catalog.js";
import { isAdminWallet } from "../publish/admin.js";
import { agentOnChain, callTargets, deploymentOrNull, licenseOnChain, registryAdmin, registryConfig } from "./chain-reads.js";
import { promoteDisputeDrafts, saveDisputeDraft } from "./dispute-drafts.js";
import { heldGuaranteeUnits, placeHold } from "./guarantee-holds.js";
import { canCancelUndelivered, cancelUndeliveredBlock, deliveryIntact, disputeDeadlineOf, resolveDeliveryDays } from "./delivery-rules.js";
import { catalogLangOf } from "./lang-rules.js";
import { toEscrow, toReputation } from "./mappers.js";
import { assertPaymentsOpen } from "./pause-gate.js";
import { creatorWalletOf } from "./purchase-guards.js";
import { chooseReviewLicense, reviewContentHash } from "./review-rules.js";
import { buildChecked } from "./tx-build.js";

export const escrowRouter = Router();

type AgentRow = typeof schema.agents.$inferSelect;
type MilestoneRow = typeof schema.milestones.$inferSelect;
type EscrowRow = typeof schema.escrows.$inferSelect;

const EscrowIdParam = z.string().regex(/^\d{1,30}$/, "invalid guarantee id");
const Index = z.number().int().min(0).max(4);

async function loadEscrow(id: string, wallet: string) {
  const escrowId = parse(EscrowIdParam, id);
  let [row] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, escrowId));
  if (row && row.title === "" && row.purchaseId && (await fillEscrowTexts(escrowId)) > 0) {
    [row] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, escrowId));
  }
  if (!row) throw notFound("Guaranteed task not found");
  if (row.buyerWallet !== wallet.toLowerCase()) throw forbidden("This guarantee belongs to another wallet");
  const ms = await db.select().from(schema.milestones).where(eq(schema.milestones.escrowId, escrowId));
  return { row, ms };
}

const closedOf = (row: Pick<EscrowRow, "status" | "deliveryDeadline">) => ({ closed: isTerminalEscrowStatus(row.status), deliveryDeadline: row.deliveryDeadline });

// ---------- Guarantee limit ----------

/** Ledger statuses of a guarantee charge that is not on-chain yet but already holds the buyer's limit. */
const PENDING_CHARGE_STATUSES = ["created", "pending_payment", "confirmed", "fulfilling"];
/** An unpaid guarantee charge stops holding the limit after this long (the payments reconcile job expires it). */
const PENDING_CHARGE_HOLD_MINUTES = 30;

/** Base units the wallet has in open guarantees: on-chain (active/disputed) + guarantee charges still being paid. */
async function openGuaranteeUnits(wallet: string, exec: Pick<typeof db, "select"> = db): Promise<bigint> {
  const [open] = await exec
    .select({ sum: sql<string>`coalesce(sum(${schema.escrows.total}), 0)` })
    .from(schema.escrows)
    .where(and(eq(schema.escrows.buyerWallet, wallet), inArray(schema.escrows.status, ["active", "disputed"])));
  const [pending] = await exec
    .select({ sum: sql<string>`coalesce(sum(${schema.paymentLedger.tokenAmount}), 0)` })
    .from(schema.paymentLedger)
    .where(
      and(
        eq(schema.paymentLedger.buyerWallet, wallet),
        eq(schema.paymentLedger.kind, "escrow"),
        inArray(schema.paymentLedger.status, PENDING_CHARGE_STATUSES),
        gt(schema.paymentLedger.createdAt, sql`now() - make_interval(mins => ${PENDING_CHARGE_HOLD_MINUTES})`),
      ),
    );
  // Intents planned a moment ago whose ledger row is not written yet (guarantee-holds.ts).
  return BigInt(open?.sum ?? "0") + BigInt(pending?.sum ?? "0") + (await heldGuaranteeUnits(wallet, exec));
}

export async function guaranteeStatus(wallet: string): Promise<GuaranteeStatus> {
  const [repRow] = await db.select().from(schema.userReputation).where(eq(schema.userReputation.wallet, wallet));
  const rep = toReputation(wallet, repRow);
  const limitUsdc = GUARANTEE_LIMITS_USDC[rep.guaranteeLevel];
  const openUsdc = displayUnits(await openGuaranteeUnits(wallet));
  return {
    level: rep.guaranteeLevel,
    limitUsdc,
    openUsdc,
    availableUsdc: Math.max(0, Math.round((limitUsdc - openUsdc) * 1e6) / 1e6),
    purchases: rep.purchases,
    purchasesToFull: rep.guaranteeLevel === "limited" ? Math.max(0, FULL_LEVEL_PURCHASES - rep.purchases) : 0,
    disputesLost: rep.disputesLost,
    maxDisputesLost: MAX_BUYER_DISPUTES_LOST,
    singleMilestoneMaxUsdc: SINGLE_MILESTONE_MAX_USDC,
  };
}

escrowRouter.get(
  "/me/guarantee",
  requireAuth,
  h(async (req) => guaranteeStatus(requireWallet(req))),
);

/// ---------- Guarantee purchase plan (installed into the payments area with setEscrowPlanner) ----------

/** What the ledger row of a guarantee charge keeps (`payment_ledger.intent.task`), JSON-safe. */
export type EscrowIntentRecord = {
  /** Folder of the acceptance suites (`DELIVERABLES_DIR/<planKey>`) and key of the guarantee-limit hold. */
  planKey?: string;
  title: string;
  description: string;
  deliveryDays: number;
  reviewWindowSecs: number;
  milestones: {
    title: string;
    criteria: string;
    verify: "tests" | "manual";
    amountUnits: string;
    criteriaHash: Hex;
    acceptancePath: string | null;
    acceptanceHash: string | null;
  }[];
};

export type EscrowPlan = {
  milestones: MilestoneInput[];
  reviewWindowSecs: number;
  deliveryDays: number;
  /** Stored by the payments area in the ledger row (`intent.task`); `fillEscrowTexts` copies it once the escrow is indexed. */
  details: EscrowIntentRecord;
};

/**
 * Checks and plans a guaranteed task for `buyer` (the payments area's `EscrowPlanner`: `POST /api/purchases/intent` and Pix
 * with kind "escrow"): the creator's offer, the buyer's guarantee limit (total of open guarantees, under a per-wallet
 * advisory lock), the minimum purchase, and the acceptance tests (saved under a fresh plan id; the criteria hash that goes
 * on-chain covers them). The milestones and criteria come from the creator's template; the buyer only describes the task.
 */
export async function planEscrowPurchase(input: { agent: AgentRow; buyer: string; task: EscrowTaskInput }): Promise<EscrowPlan> {
  const { agent, task } = input;
  const wallet = input.buyer.toLowerCase();
  assertNotPlatformAgent(agent); // free platform Solver: no guarantee (409 platform_agent_not_for_sale)
  if (!agentIsAvailable(agent) || !agent.listed) throw badRequest("This specialist is not available yet.");
  const offer = guaranteeOffer(agent, 1);
  const template = agent.details.guaranteeTemplate;
  if (!offer || !template) throw badRequest("This specialist doesn't offer guaranteed tasks.", "guarantee_unavailable");
  const deliveryDays = resolveDeliveryDays(task.deliveryDays);
  if ((task.acceptanceTests?.length ?? 0) > offer.milestones.length) throw badRequest("There are more acceptance test suites than steps.");
  if (task.acceptanceTests?.some((t, idx) => t && offer.milestones[idx]!.verify === "manual")) {
    throw badRequest("Manual review steps don't have an acceptance test suite.");
  }
  const total = unitsFromNumber(offer.priceUsdc);
  const amounts = splitGuaranteeUnits(total, template.milestones.map((m) => m.sharePct));

  const g = await guaranteeStatus(wallet);
  // The limit applies to the total of the wallet's open guarantees, not per guarantee.
  if (offer.priceUsdc > g.availableUsdc) {
    throw new HttpError(
      400,
      g.level === "none"
        ? "Your account can't open guaranteed tasks right now."
        : `Your current limit for open guarantees is ${g.limitUsdc} ${env.PAYMENT_TOKEN_SYMBOL} (you already have ${g.openUsdc} ${env.PAYMENT_TOKEN_SYMBOL} in progress). It grows as you make purchases in the store.`,
      "guarantee_limit",
      { guaranteeLevel: g.level, limitUsdc: g.limitUsdc, openUsdc: g.openUsdc },
    );
  }
  if (g.level === "limited" && offer.milestones.length < 2 && offer.priceUsdc > SINGLE_MILESTONE_MAX_USDC) {
    throw badRequest(`For new accounts, guarantees above ${SINGLE_MILESTONE_MAX_USDC} ${env.PAYMENT_TOKEN_SYMBOL} need at least 2 steps.`);
  }
  // Two concurrent requests cannot pass the limit together: lock per wallet, check again and write a hold in the same
  // transaction (the ledger row is written later by the payments area; the hold counts until it exists).
  const planKey = `plan-${randomId(12)}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`escrow:${wallet}`}))`);
    const open = await openGuaranteeUnits(wallet, tx);
    if (displayUnits(open + total) > g.limitUsdc) {
      throw new HttpError(400, `Your current limit for open guarantees is ${g.limitUsdc} ${env.PAYMENT_TOKEN_SYMBOL}.`, "guarantee_limit", {
        guaranteeLevel: g.level,
        limitUsdc: g.limitUsdc,
        openUsdc: displayUnits(open),
      });
    }
    await placeHold(tx, wallet, planKey, total);
  });

  // Agreed criteria: text + hash of the acceptance tests; the hash of everything goes on-chain. Saved under the plan id
  // (the escrow id only exists once the purchase is mined); the absolute path travels in the ledger record.
  const acceptance = offer.milestones.map((_, idx) => {
    const tests = task.acceptanceTests?.[idx];
    return tests ? saveAcceptance(planKey, idx, tests) : null;
  });
  const details: EscrowIntentRecord = {
    planKey,
    title: task.title,
    description: task.description,
    deliveryDays,
    reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
    milestones: offer.milestones.map((m, idx) => {
      const criteria = m.criteria.join("\n");
      return {
        title: m.title,
        criteria,
        verify: m.verify,
        amountUnits: amounts[idx]!.toString(),
        criteriaHash: `0x${criteriaHash(m.title, criteria, acceptance[idx]?.hash).toString("hex")}` as Hex,
        acceptancePath: acceptance[idx]?.path ?? null,
        acceptanceHash: acceptance[idx]?.hash ?? null,
      };
    }),
  };
  return {
    milestones: details.milestones.map((m) => ({ amount: BigInt(m.amountUnits), criteriaHash: m.criteriaHash })),
    reviewWindowSecs: details.reviewWindowSecs,
    deliveryDays,
    details,
  };
}

function isIntentRecord(v: unknown): v is EscrowIntentRecord {
  const r = v as EscrowIntentRecord | null;
  return (
    !!r &&
    typeof r.title === "string" &&
    typeof r.description === "string" &&
    Array.isArray(r.milestones) &&
    r.milestones.every((m) => !!m && typeof m.title === "string" && typeof m.criteriaHash === "string")
  );
}

/**
 * Copies the off-chain texts of guaranteed tasks (title, description and per-milestone title, criteria, verify mode and
 * acceptance tests) from the ledger row of their purchase into the rows the indexer mirrored from `EscrowCreated` (it
 * writes placeholders and never touches off-chain data). A milestone is filled only when its on-chain criteria hash is
 * the planned one. Idempotent; runs after `/tx/confirm`, on the guarantee pages and as a job. Returns rows filled.
 *
 * The ledger row is found by the escrow id the payments module recorded when it matched the sale to the charge by
 * (payer, purchaseId) (`provider_payload.escrowId`, set from `SaleAuthorized` / `purchaseRef`), plus the same buyer,
 * purchase id and kind. A purchase id alone is public: another wallet reusing it in its own `createEscrow` must never
 * inherit the texts (or the private acceptance tests) of someone else's guarantee. Escrows created on-chain without an
 * intent have no such ledger row and are never selected, so they cannot crowd out the ones that do (newest first).
 * Call it with an escrow id to fill that one escrow (e.g. before showing or verifying it).
 */
export async function fillEscrowTexts(escrowId?: string): Promise<number> {
  const e = schema.escrows;
  const l = schema.paymentLedger;
  const rows = await db
    .select({ id: e.id, intent: l.intent })
    .from(e)
    .innerJoin(
      l,
      and(
        sql`(${l.providerPayload} ->> 'escrowId') = ${e.id}`,
        eq(l.kind, "escrow"),
        eq(l.buyerWallet, e.buyerWallet),
        eq(l.purchaseId, e.purchaseId),
        eq(l.status, "fulfilled"),
      ),
    )
    .where(and(eq(e.title, ""), escrowId ? eq(e.id, escrowId) : undefined))
    .orderBy(desc(e.createdAt))
    .limit(50);
  let filled = 0;
  for (const r of rows) {
    const rec = (r.intent as { task?: unknown } | undefined)?.task;
    if (!isIntentRecord(rec)) {
      console.warn(`[escrow] ledger record of escrow ${r.id} has no usable texts; skipped`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.update(schema.escrows).set({ title: rec.title, description: rec.description }).where(and(eq(schema.escrows.id, r.id), eq(schema.escrows.title, "")));
      for (const [idx, m] of rec.milestones.entries()) {
        await tx
          .update(schema.milestones)
          .set({ title: m.title, criteria: m.criteria, verify: m.verify, acceptancePath: m.acceptancePath, acceptanceHash: m.acceptanceHash })
          .where(and(eq(schema.milestones.escrowId, r.id), eq(schema.milestones.idx, idx), eq(schema.milestones.criteriaHash, m.criteriaHash.toLowerCase())));
      }
    });
    filled++;
  }
  return filled;
}

// ---------- Release / dispute / cancel ----------

escrowRouter.post(
  "/tx/escrow/:id/release",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { index } = parse(z.object({ index: Index }), req.body);
    const { row, ms } = await loadEscrow(String(req.params.id), wallet);
    const m = ms.find((x) => x.idx === index);
    if (!m || !["pending", "submitted", "passed"].includes(m.status)) throw badRequest("This step can't be approved right now.");
    await assertPaymentsOpen("release");
    return buildChecked(wallet, releaseMilestoneCalls(callTargets(), { escrowId: BigInt(row.id), index }), "release");
  }),
);

/** Cancel an undelivered milestone after the deadline: the buyer gets the milestone's amount back, without a fee. */
async function buildCancelUndelivered(idParam: string, wallet: Address, index: number): Promise<TxResponse> {
  const { row, ms } = await loadEscrow(idParam, wallet);
  const m = ms.find((x) => x.idx === index);
  if (!m) throw notFound("Step not found");
  const blocked = cancelUndeliveredBlock(closedOf(row), m, new Date());
  if (blocked) throw badRequest(blocked, "cancel_not_allowed");
  return buildChecked(wallet, cancelUndeliveredCalls(callTargets(), { escrowId: BigInt(row.id), index }), "cancel-undelivered");
}

escrowRouter.post(
  "/tx/escrow/:id/cancel-undelivered",
  requireAuth,
  h(async (req) => {
    const { index } = parse(z.object({ index: Index }), req.body);
    return buildCancelUndelivered(String(req.params.id), requireWallet(req) as Address, index);
  }),
);

// Same action with the index in the URL.
escrowRouter.post(
  "/tx/escrows/:id/milestones/:index/cancel-undelivered",
  requireAuth,
  h(async (req) => {
    const { index } = parse(z.object({ index: z.coerce.number().int().min(0).max(4) }), req.params);
    return buildCancelUndelivered(String(req.params.id), requireWallet(req) as Address, index);
  }),
);

/** Stale dispute (never passed, deadline over, 7 days without a judgment): the buyer can trigger the refund themselves. */
escrowRouter.post(
  "/tx/escrow/:id/stale-dispute",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { index } = parse(z.object({ index: Index }), req.body);
    const { row, ms } = await loadEscrow(String(req.params.id), wallet);
    const m = ms.find((x) => x.idx === index);
    if (!m || m.status !== "disputed") throw badRequest("This step is not in dispute.", "not_disputed");
    const due = disputeDeadlineOf(m, row.deliveryDeadline);
    if (!due) throw badRequest("This step passed its tests; only the platform can decide the dispute.", "needs_judgment");
    if (due.getTime() > Date.now()) throw badRequest(`The automatic refund is only available from ${due.toISOString()}.`, "dispute_sla_not_reached");
    return buildChecked(wallet, resolveStaleDisputeCalls(callTargets(), { escrowId: BigInt(row.id), index }), "stale-dispute");
  }),
);

escrowRouter.post(
  "/tx/escrow/:id/dispute",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const body = parse(
      z.object({
        index: Index,
        /** Which agreed criterion failed (required). */
        criterion: z.string().min(2).max(1000),
        reason: z.string().min(5).max(2000),
      }),
      req.body,
    );
    const { row, ms } = await loadEscrow(String(req.params.id), wallet);
    const m = ms.find((x) => x.idx === body.index);
    if (!m || !["pending", "submitted", "passed"].includes(m.status)) throw badRequest("This step can't be disputed right now.");
    if (m.status === "passed" && m.passedAt && Date.now() > m.passedAt.getTime() + row.reviewWindowSecs * 1000) {
      throw badRequest("The deadline to dispute this step has passed.");
    }
    const criteria = splitCriteria(m.criteria);
    if (!criteria.includes(body.criterion.trim())) {
      throw badRequest("Indicate which of the agreed criteria failed.", "invalid_criterion", { criteria });
    }
    const reasonHash = `0x${sha256(`${body.criterion}\n${body.reason}`).toString("hex")}` as Hex;
    // Simulate before storing criterion/reason: a dispute the contract would refuse leaves no draft.
    const built = await buildChecked(wallet, openDisputeCalls(callTargets(), { escrowId: BigInt(row.id), index: body.index, reasonHash }), "dispute");
    // Draft keyed by the reason hash; promoted to the milestone only when the chain shows this hash (dispute-drafts.ts).
    await saveDisputeDraft({ escrowId: row.id, idx: body.index, reasonHash, wallet, criterion: body.criterion, reason: body.reason });
    return built;
  }),
);

// ---------- Queries ----------

function milestoneExtras(m: MilestoneRow, row: EscrowRow): EscrowDetail["milestones"][number] {
  const report = (m.verifierReport ?? null) as { numPassed?: number; numTests?: number; mode?: string } | null;
  return {
    index: m.idx,
    amountUsdc: displayUnits(m.amount),
    passedAt: m.passedAt?.toISOString() ?? null,
    autoReleaseAt: m.passedAt && m.status === "passed" ? new Date(m.passedAt.getTime() + row.reviewWindowSecs * 1000).toISOString() : null,
    previewUrl: m.status === "passed" || m.status === "approved" ? m.previewUrl : null,
    tests: report ? { passed: report.numPassed ?? 0, total: report.numTests ?? 0, mode: report.mode ?? "docker" } : null,
    criteria: splitCriteria(m.criteria),
    verify: m.verify === "manual" ? "manual" : "tests",
    hasAcceptanceTests: !!m.acceptanceHash,
    disputeCriterion: m.disputeCriterion,
    downloadable: m.status === "approved" && !!m.deliverablePath,
    disputedAt: m.disputedAt?.toISOString() ?? null,
    disputeDeadline: disputeDeadlineOf(m, row.deliveryDeadline)?.toISOString() ?? null,
    canCancelUndelivered: canCancelUndelivered(closedOf(row), m, new Date()),
  };
}

escrowRouter.get(
  "/me/escrows",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    let rows = await db.select().from(schema.escrows).where(eq(schema.escrows.buyerWallet, wallet)).orderBy(desc(schema.escrows.createdAt));
    if (rows.some((r) => r.title === "" && r.purchaseId)) {
      for (const r of rows) if (r.title === "" && r.purchaseId) await fillEscrowTexts(r.id);
      rows = await db.select().from(schema.escrows).where(eq(schema.escrows.buyerWallet, wallet)).orderBy(desc(schema.escrows.createdAt));
    }
    if (rows.length === 0) return [];
    const ms = await db.select().from(schema.milestones).where(inArray(schema.milestones.escrowId, rows.map((r) => r.id)));
    return rows.map((r) => toEscrow(r, ms.filter((m) => m.escrowId === r.id)));
  }),
);

escrowRouter.get(
  "/me/escrows/:id",
  requireAuth,
  h(async (req, res): Promise<EscrowDetail> => {
    const { row, ms } = await loadEscrow(String(req.params.id), requireWallet(req));
    const agent = await findAgentRow(row.agentId);
    const escrowContract = deploymentOrNull()?.escrow;
    return {
      escrow: toEscrow(row, ms),
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      agent: { id: agent.id, slug: agent.slug, name: (catalogLangOf(req, res) === "pt" ? agent.translations?.pt?.name : undefined) || agent.name },
      milestones: ms.sort((a, b) => a.idx - b.idx).map((m) => milestoneExtras(m, row)),
      // The creation transaction when known, else the escrow contract.
      explorerUrl: (row.txHash ? explorerUrl(row.txHash) : escrowContract ? explorerUrl(escrowContract) : null) ?? "",
    };
  }),
);

escrowRouter.get(
  "/me/escrows/:id/milestones/:idx/download",
  requireAuth,
  h(async (req) => {
    const { ms } = await loadEscrow(String(req.params.id), requireWallet(req));
    const m = ms.find((x) => x.idx === Number(req.params.idx));
    if (!m?.deliverablePath) throw notFound("Delivery not found");
    if (m.status !== "approved") throw forbidden("The final file becomes available after approval.");
    // The files on disk must be what was verified and approved (the hash was stored at submission).
    const files = readDeliverable(m.deliverablePath);
    if (!deliveryIntact(Object.keys(files).length, filesHash(files).toString("hex"), m.deliverableHash)) {
      console.error(`[download] deliverable differs from the approved hash (${m.escrowId}/${m.idx})`);
      throw new HttpError(409, "The files of this delivery don't match what was approved, so the download was blocked. Please contact support.", "deliverable_changed");
    }
    return { files };
  }),
);

// ---------- Reviews ----------

/** Id of the wallet's own review of the agent on-chain (0 when none). */
async function myReviewId(agentId: string, wallet: Address): Promise<bigint> {
  const c = chainContext();
  const r = await c.publicClient.readContract({
    address: c.deployment.reviews,
    abi: solversReviewsAbi,
    functionName: "reviewOf",
    args: [agentIdToBytes32(agentId), wallet],
  });
  return BigInt(r.id);
}

escrowRouter.post(
  "/tx/review",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const body = parse(z.object({ agentId: z.string(), rating: z.number().int().min(1).max(5), text: z.string().max(2000).default("") }), req.body);
    const agent = await findAgentRow(body.agentId);
    if (agent.chainIndex === null) throw badRequest("This specialist is not available for reviews yet.");
    // D12/X11: the creator never reviews their own Solver (the contract refuses it with SelfReview).
    if ((await creatorWalletOf(agent)) === wallet) throw forbidden("Creators cannot review their own specialist.");
    const lic = await db
      .select({ id: schema.licenses.id })
      .from(schema.licenses)
      .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, agent.id), eq(schema.licenses.burned, false)));
    // Licenses the wallet really holds (on-chain). A license backs at most one author's review (X12): a transferred
    // license whose previous owner already reviewed cannot back a new author's review.
    const owned: string[] = [];
    for (const l of lic) if ((await refreshLicenseOwner(l.id).catch(() => null)) === wallet) owned.push(l.id);
    const mine = owned.length ? await myReviewId(agent.id, wallet) : 0n;
    const used = await Promise.all(
      owned.map(async (id) => {
        const reviewId = (await licenseOnChain(BigInt(id)))?.reviewId ?? 0n;
        return { id, used: reviewId !== 0n && reviewId !== mine };
      }),
    );
    const [cred] = await db
      .select()
      .from(schema.credits)
      .where(and(eq(schema.credits.ownerWallet, wallet), eq(schema.credits.agentId, agent.id)));
    const hasCredits = !!cred && cred.purchased > 0;
    const choice = chooseReviewLicense(used, false);
    if (choice.kind === "all_used" && !hasCredits) {
      throw badRequest(
        "This license was already used to review this specialist by a previous owner. Each license can only back one review, so you can't review with it.",
        "license_already_reviewed",
      );
    }
    if (choice.kind !== "use" && !hasCredits) throw forbidden("Only people who hold this specialist's license can review it.");
    const contentHash = reviewContentHash(body.text);
    const d = callTargets();
    const agentId = agentIdToBytes32(agent.id);
    const calls =
      choice.kind === "use"
        ? submitReviewCalls(d, { agentId, tokenId: BigInt(choice.asset), rating: body.rating, contentHash })
        : submitReviewWithCreditsCalls(d, { agentId, rating: body.rating, contentHash });
    // Simulate before storing the draft (e.g. the license already backs another review).
    const built = await buildChecked(wallet, calls, "review");
    // The text stays off-chain, only as a draft by hash: nothing public changes before the signature. The indexer
    // promotes the draft when the same hash is confirmed on-chain.
    await db
      .insert(schema.reviewDrafts)
      .values({ agentId: agent.id, authorWallet: wallet, contentHash, rating: body.rating, text: body.text })
      .onConflictDoUpdate({
        target: [schema.reviewDrafts.agentId, schema.reviewDrafts.authorWallet, schema.reviewDrafts.contentHash],
        set: { rating: body.rating, text: body.text, createdAt: new Date() },
      });
    // Old drafts never signed are not kept.
    await db
      .delete(schema.reviewDrafts)
      .where(and(eq(schema.reviewDrafts.authorWallet, wallet), lt(schema.reviewDrafts.createdAt, sql`now() - interval '1 day'`)));
    return built;
  }),
);

// ---------- Admin (moderation and disputes; development only: needs the admin key on the server) ----------

async function requireAdmin(wallet: string): Promise<void> {
  const admin = chainContext().accounts.admin;
  if (!admin || admin.address.toLowerCase() !== wallet.toLowerCase()) throw forbidden("Admin key is not configured on this server");
  if ((await registryAdmin()) !== wallet.toLowerCase()) throw forbidden("Admin only");
}

escrowRouter.get(
  "/admin/disputes",
  requireAuth,
  h(async (req) => {
    await requireAdmin(requireWallet(req));
    await promoteDisputeDrafts().catch((e: unknown) => console.warn("[admin] dispute drafts:", (e as Error).message));
    const ms = await db.select().from(schema.milestones).where(eq(schema.milestones.status, "disputed"));
    return ms.map((m) => ({ escrowId: m.escrowId, index: m.idx, title: m.title, criteria: m.criteria, criterion: m.disputeCriterion, reason: m.disputeReason }));
  }),
);

escrowRouter.post(
  "/admin/escrow/:id/resolve",
  requireAuth,
  h(async (req) => {
    await requireAdmin(requireWallet(req));
    const escrowId = parse(EscrowIdParam, String(req.params.id));
    const { index, refund } = parse(z.object({ index: Index, refund: z.boolean() }), req.body);
    await assertPaymentsOpen("resolve");
    const { hash } = await sendServerCalls({
      signer: "admin",
      lane: "admin",
      calls: resolveDisputeCalls(callTargets(), { escrowId: BigInt(escrowId), index, refund }),
      kind: "admin-resolve-dispute",
      ref: `${escrowId}:${index}`,
    });
    await processTxHash(hash).catch((e: unknown) => console.error("[admin] index", hash, (e as Error).message));
    const [row] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, escrowId));
    if (row) void notifyCreator(row.agentId, `Solvers: dispute for step ${index + 1} resolved (${refund ? "refund to the buyer" : "payment to the creator"}).`);
    return { txHash: hash, explorerUrl: explorerUrl(hash) };
  }),
);

/**
 * Puts a Solver back in the storefront (database only). Approving on the site signs NOTHING on-chain: the on-chain
 * `approveAgent` is `cli:approve` with the cold admin key. A Solver that is not Active on-chain is refused (409
 * `onchain_approval_required`) instead of being listed.
 */
escrowRouter.post(
  "/admin/agents/:id/approve",
  requireAuth,
  h(async (req) => {
    if (!isAdminWallet(requireWallet(req))) throw forbidden("Admin only");
    const agent = await findAgentRow(String(req.params.id));
    const onchain = await agentOnChain(agent.id);
    if (!onchain || onchain.status !== AGENT_STATUS.Active) {
      throw new HttpError(409, "This Solver is not active on the network. Approve it with cli:approve (cold admin key); the site never signs it.", "onchain_approval_required");
    }
    const [row] = await db
      .update(schema.agents)
      // Back in the storefront, unless the rating is still below the minimum (the delist job would remove it again).
      .set({ listed: sql`not (${schema.agents.ratingCount} >= ${DELIST_MIN_REVIEWS} and ${schema.agents.ratingSum}::float / nullif(${schema.agents.ratingCount}, 0) < ${DELIST_MAX_RATING})` })
      .where(eq(schema.agents.id, agent.id))
      .returning({ listed: schema.agents.listed });
    return { agentId: agent.id, listed: row?.listed ?? false };
  }),
);
