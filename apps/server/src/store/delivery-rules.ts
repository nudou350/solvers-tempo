import { badRequest } from "../lib/http.js";

// Pure delivery and deadline rules (no env/database), tested in test/guarantee.test.ts.
// The constants mirror SolversEscrow (DEFAULT_DELIVERY_DAYS, MAX_DELIVERY_DAYS, DISPUTE_SLA); the contract decides.
// `closed` in the inputs below means a terminal escrow (approved or refunded): there is no stored flag on-chain (D19).

export const DEFAULT_DELIVERY_DAYS = 14;
export const MAX_DELIVERY_DAYS = 60;
/** Deadline to judge a dispute on a milestone that never passed its tests (see disputeDeadlineOf). */
export const DISPUTE_SLA_SECS = 7 * 86400;

/** Integrity of the approved deliverable's download: are the files on disk the ones that were verified and approved? */
export function deliveryIntact(fileCount: number, actualHashHex: string, expectedHashHex: string | null): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^0x/, "");
  return fileCount > 0 && !!expectedHashHex && bare(actualHashHex) === bare(expectedHashHex);
}

/** Delivery deadline asked at creation: missing or 0 means the default; an integer from 1 to MAX_DELIVERY_DAYS. */
export function resolveDeliveryDays(days: number | undefined): number {
  if (days === undefined || days === 0) return DEFAULT_DELIVERY_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > MAX_DELIVERY_DAYS) {
    throw badRequest(`The delivery deadline must be between 1 and ${MAX_DELIVERY_DAYS} days (or omitted, for ${DEFAULT_DELIVERY_DAYS} days).`, "invalid_delivery_days");
  }
  return days;
}

export const deliveryDeadlineFrom = (now: Date, days: number) => new Date(now.getTime() + days * 86400 * 1000);

/**
 * Until when the buyer waits for a judgment before the automatic refund of a stale dispute. The automatic refund only
 * applies to a milestone that NEVER passed its tests (passedAt null) and needs the delivery deadline passed AND
 * disputedAt + 7 days: the later of the two counts. A milestone that passed its tests and was disputed is judged only by
 * the admin (null, no automatic refund). Also null without a dispute.
 */
export function disputeDeadlineOf(
  milestone: { disputedAt: Date | null | undefined; passedAt: Date | null | undefined },
  deliveryDeadline: Date | null | undefined,
): Date | null {
  if (!milestone.disputedAt || milestone.passedAt) return null;
  const sla = milestone.disputedAt.getTime() + DISPUTE_SLA_SECS * 1000;
  return new Date(deliveryDeadline ? Math.max(sla, deliveryDeadline.getTime()) : sla);
}

/** Pending milestone, task open and delivery deadline passed: the buyer can cancel and get the amount back. */
export function canCancelUndelivered(
  escrow: { closed: boolean; deliveryDeadline: Date | null },
  milestone: { status: string },
  now: Date,
): boolean {
  return !escrow.closed && milestone.status === "pending" && !!escrow.deliveryDeadline && now.getTime() > escrow.deliveryDeadline.getTime();
}

/** Date and time in UTC (YYYY-MM-DD HH:MM UTC, no format ambiguity), for messages to the user and the AI. */
export const formatDeadline = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Why the milestone cannot be cancelled now (null: it can). */
export function cancelUndeliveredBlock(
  escrow: { closed: boolean; deliveryDeadline: Date | null },
  milestone: { status: string },
  now: Date,
): string | null {
  if (escrow.closed) return "This task is already closed.";
  if (milestone.status !== "pending") return "Only a step that hasn't been delivered yet can be canceled.";
  if (!escrow.deliveryDeadline) return "This task was created without a delivery deadline, so it has no cancellation for late delivery.";
  if (now.getTime() <= escrow.deliveryDeadline.getTime()) return `The delivery deadline only passes on ${formatDeadline(escrow.deliveryDeadline)}. After that you can cancel and get a refund.`;
  return null;
}
