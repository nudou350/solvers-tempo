// Escrow mirror rules (pure functions), identical to `SolversEscrow._statusOf` / `autoReleaseAt`.
// DB names: milestones pending | passed | approved | disputed | refunded (plus the off-chain "submitted");
// escrows active | approved | disputed | refunded (`approved` = the contract's `Completed`, as the API names it).

import { DISPUTE_SLA_SECS } from "../store/delivery-rules.js";

export type MilestoneStatusName = "pending" | "passed" | "approved" | "disputed" | "refunded";
export type EscrowStatusName = "active" | "approved" | "disputed" | "refunded";

/** Contract `MilestoneStatus` code → DB name. */
export const MILESTONE_STATUS: Record<number, MilestoneStatusName> = { 0: "pending", 1: "passed", 2: "approved", 3: "disputed", 4: "refunded" };

/**
 * Is the dispute past its judgment deadline so the buyer must be refunded (`resolveStaleDispute`)? Contract rules: a
 * milestone that NEVER passed (passedAt == 0), the delivery deadline is over (now > deliveryDeadline) and
 * disputedAt + 7 days has elapsed. A milestone that passed the tests is judged only by the admin. Unix seconds; 0 = absent.
 */
export function staleDisputeDue(
  m: { disputedAt: bigint | number; passedAt: bigint | number; deliveryDeadline: bigint | number },
  nowSecs: number,
): boolean {
  const disputedAt = Number(m.disputedAt);
  return disputedAt > 0 && Number(m.passedAt) === 0 && nowSecs > Number(m.deliveryDeadline) && nowSecs >= disputedAt + DISPUTE_SLA_SECS;
}

/** Escrow status from its milestones, exactly as `SolversEscrow._statusOf` (an escrow without milestones is active). */
export function escrowStatusFromMilestones(statuses: readonly string[]): EscrowStatusName {
  if (statuses.length === 0) return "active";
  if (statuses.every((s) => s === "refunded")) return "refunded";
  if (statuses.every((s) => s === "approved" || s === "refunded")) return "approved";
  if (statuses.some((s) => s === "disputed")) return "disputed";
  return "active";
}

/**
 * When the most recently passed milestone becomes releasable by anyone (`SolversEscrow.autoReleaseAt`), in unix
 * seconds; 0 when no milestone is Passed.
 */
export function autoReleaseAtOf(milestones: readonly { status: string; passedAt: bigint | number }[], reviewWindowSecs: number): number {
  let at = 0;
  for (const m of milestones) {
    if (m.status !== "passed") continue;
    const t = Number(m.passedAt) + reviewWindowSecs;
    if (t > at) at = t;
  }
  return at;
}

/**
 * Milestone status to store: "submitted" is an off-chain state (deliverable received, verification running) that a
 * chain "pending" must not erase; every other chain status wins.
 */
export function mirroredMilestoneStatus(chain: MilestoneStatusName, current: string | null | undefined): string {
  return chain === "pending" && current === "submitted" ? "submitted" : chain;
}
