import { createHash } from "node:crypto";
import { numberToUnits, splitGuaranteeUnits, type EscrowMilestoneIntent, type EscrowTaskInput } from "@solvers/shared";

import { env } from "../env.js";
import { HttpError, badRequest } from "../lib/http.js";
import type { schema } from "../db/index.js";

// Milestones of a guarantee bought through a payment intent. The guarantees area owns the business rules (wallet limits,
// acceptance-test storage, task text); it installs its planner with `setEscrowPlanner` at boot. The default planner below
// only derives the milestones from the creator's template and refuses acceptance tests (they need the verifier's storage).

type AgentRow = typeof schema.agents.$inferSelect;

export type EscrowPlan = {
  milestones: EscrowMilestoneIntent[];
  reviewWindowSecs: number;
  /** 0 = contract default (14 days). */
  deliveryDays: number;
  /** Stored in `payment_ledger.intent` so the guarantees area can fill its rows when the escrow is created on-chain. */
  details: Record<string, unknown>;
};

export type EscrowPlanner = (input: { agent: AgentRow; buyer: string; task: EscrowTaskInput }) => Promise<EscrowPlan>;

/** sha256(title \n criteria) as bytes32: the same layout the verifier uses without an acceptance suite. */
export function criteriaHashOf(title: string, criteria: string): `0x${string}` {
  return `0x${createHash("sha256").update(`${title}\n${criteria}`).digest("hex")}`;
}

/** Whether the creator's guarantee offer is open for this agent (template + sales and rating thresholds). */
export function guaranteeOpen(row: AgentRow): boolean {
  if (!row.guaranteeAvailable || !row.details.guaranteeTemplate) return false;
  if (Number(row.totalSales) < env.GUARANTEE_MIN_SALES) return false;
  if (env.GUARANTEE_MIN_RATING > 0 && (row.ratingCount === 0 || Number(row.ratingSum) / row.ratingCount < env.GUARANTEE_MIN_RATING)) return false;
  return true;
}

export const defaultEscrowPlanner: EscrowPlanner = async ({ agent, task }) => {
  const t = agent.details.guaranteeTemplate;
  if (!t || !guaranteeOpen(agent)) throw badRequest("This specialist doesn't offer guaranteed tasks.", "guarantee_unavailable");
  if (task.acceptanceTests?.some((x) => x !== null)) {
    throw new HttpError(501, "Acceptance test suites are not available for this purchase yet.", "acceptance_tests_unavailable");
  }
  const units = splitGuaranteeUnits(
    numberToUnits(t.priceUsdc, env.PAYMENT_TOKEN_DECIMALS),
    t.milestones.map((m) => m.sharePct),
  );
  const milestones = t.milestones.map((m, i) => ({
    amount: units[i]!,
    criteriaHash: criteriaHashOf(m.title, m.criteria.join("\n")),
  }));
  return {
    milestones,
    reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
    deliveryDays: task.deliveryDays ?? 0,
    // Same shape as the store planner's record (EscrowIntentRecord), so fillEscrowTexts can copy it.
    details: {
      title: task.title,
      description: task.description,
      deliveryDays: task.deliveryDays ?? 0,
      reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
      milestones: t.milestones.map((m, i) => ({
        title: m.title,
        criteria: m.criteria.join("\n"),
        verify: m.verify ?? "tests",
        amountUnits: units[i]!.toString(),
        criteriaHash: milestones[i]!.criteriaHash,
        acceptancePath: null,
        acceptanceHash: null,
      })),
    },
  };
};

let planner: EscrowPlanner = defaultEscrowPlanner;

export function setEscrowPlanner(p: EscrowPlanner): void {
  planner = p;
}

export function planEscrow(input: Parameters<EscrowPlanner>[0]): Promise<EscrowPlan> {
  return planner(input);
}
