import type { ChargeStatus } from "@solvers/shared";

// Charge lifecycle (plan §5). Pure: no env, database or chain, tested in test/payments-rules.test.ts.
//
//   created -> pending_payment -> confirmed -> fulfilling -> fulfilled
//                     |               |            |
//                     v               v            v
//              expired / failed    refunding -> refunded
//
// Two transitions come from facts that cannot be undone and therefore override the normal order:
// - the chain shows the sale (`SaleAuthorized` / `purchaseRef != 0`): any open or abandoned charge becomes `fulfilled`;
// - the payment provider proves a late payment (e.g. Pix paid right after the local expiry): `expired -> confirmed`.

const NEXT: Readonly<Record<ChargeStatus, readonly ChargeStatus[]>> = {
  created: ["pending_payment", "confirmed", "failed", "expired"],
  pending_payment: ["confirmed", "expired", "failed"],
  confirmed: ["fulfilling", "refunding"],
  fulfilling: ["fulfilled", "confirmed", "refunding", "failed"],
  fulfilled: [],
  refunding: ["refunded"],
  refunded: [],
  expired: ["confirmed"],
  failed: [],
};

export function canTransition(from: ChargeStatus, to: ChargeStatus): boolean {
  return NEXT[from].includes(to);
}

/** Statuses from which `to` is reachable (used as the WHERE clause of conditional updates). */
export function sourcesOf(to: ChargeStatus): ChargeStatus[] {
  return (Object.keys(NEXT) as ChargeStatus[]).filter((from) => NEXT[from].includes(to));
}

/** Statuses the on-chain sale overrides (everything still open or abandoned). A refunded charge needs a human. */
export const CHAIN_FULFILS: readonly ChargeStatus[] = ["created", "pending_payment", "confirmed", "fulfilling", "expired", "failed"];

/** Statuses the reconcile job still has to move. */
export const OPEN_STATUSES: readonly ChargeStatus[] = ["created", "pending_payment", "confirmed", "fulfilling", "refunding"];

export const TERMINAL_STATUSES: readonly ChargeStatus[] = ["fulfilled", "refunded", "expired", "failed"];

/**
 * Contract errors that prove a platform fulfilment can never succeed for this charge, so the buyer is refunded.
 * `Paused` and infrastructure errors are transient (the charge stays `confirmed` and is retried). Names are the custom
 * errors of `contracts/src` (escrow parameters, stake gate, zero buyer) that a retry cannot change.
 */
export const UNFULFILLABLE_ERRORS: ReadonlySet<string> = new Set([
  "SoldOut",
  "PriceChanged",
  "AgentNotActive",
  "AgentNotFound",
  "AgentRetired",
  "PayPerUseDisabled",
  "BuyerNotEligible",
  "SelfPurchase",
  "PriceTooLow",
  "InsufficientStake",
  "InvalidMilestones",
  "InvalidReviewWindow",
  "InvalidDeliveryDays",
  "InvalidAmount",
  "InvalidAgentId",
  "ZeroAddress",
]);

/**
 * A confirmed charge whose fulfilment keeps failing is not retried forever: after this many on-chain refusals that are
 * not in UNFULFILLABLE_ERRORS (an unknown deterministic revert), or once it has been paid for this long without being
 * fulfilled, the admins are alerted and the buyer is refunded.
 */
export const MAX_FULFIL_ATTEMPTS = 5;
export const MAX_FULFIL_AGE_MS = 24 * 3600_000;

/** Whether a failing fulfilment should stop retrying and be refunded (pure). */
export function shouldGiveUp(input: { attempts: number; paidAt: Date | null; now: Date }): boolean {
  if (input.attempts >= MAX_FULFIL_ATTEMPTS) return true;
  return input.paidAt !== null && input.now.getTime() - input.paidAt.getTime() >= MAX_FULFIL_AGE_MS;
}

/** Errors meaning the platform float cannot pay (alert the admin; retry after a top-up). */
export const FLOAT_ERRORS: ReadonlySet<string> = new Set(["InsufficientBalance", "InsufficientAllowance"]);

export type FulfilVerdict =
  | { action: "send"; price: bigint }
  | { action: "refund"; reason: "agent_unavailable" | "sold_out" | "price_changed" | "pay_per_use_disabled" }
  | { action: "wait"; reason: "paused" };

/**
 * What the platform does with a confirmed charge given the agent's current on-chain state (pure). `charged` is what the
 * buyer paid in token units: a license whose price went up beyond it is refunded; a lower price is honoured at the new
 * price (the difference stays recorded on the ledger as `priceDelta`). Credits use `maxTotal` the same way; escrows have
 * fixed milestone amounts.
 */
export function fulfilVerdict(input: {
  kind: "license" | "credits" | "escrow";
  charged: bigint;
  creditsAmount?: number;
  agent: { status: number; price: bigint; pricePerUse: bigint; totalSales: number; maxSupply: number };
  entriesPaused: boolean;
}): FulfilVerdict {
  const a = input.agent;
  if (a.status !== 1) return { action: "refund", reason: "agent_unavailable" };
  if (input.entriesPaused) return { action: "wait", reason: "paused" };
  if (input.kind === "license") {
    if (a.maxSupply !== 0 && a.totalSales >= a.maxSupply) return { action: "refund", reason: "sold_out" };
    if (a.price > input.charged) return { action: "refund", reason: "price_changed" };
    return { action: "send", price: a.price };
  }
  if (input.kind === "credits") {
    if (a.pricePerUse === 0n) return { action: "refund", reason: "pay_per_use_disabled" };
    const total = a.pricePerUse * BigInt(input.creditsAmount ?? 0);
    if (total > input.charged) return { action: "refund", reason: "price_changed" };
    return { action: "send", price: total };
  }
  return { action: "send", price: input.charged };
}

/** Splits `purchaseRef` (`kind << 248 | ref`) into the purchase kind code and the 248-bit reference. */
export function decodePurchaseRef(ref: bigint | `0x${string}`): { kind: number; value: bigint } {
  const v = typeof ref === "bigint" ? ref : BigInt(ref);
  return { kind: Number(v >> 248n), value: v & ((1n << 248n) - 1n) };
}

/** `kind << 248 | value` as a 0x-prefixed bytes32, the format `purchaseRef` returns. */
export function encodePurchaseRef(kind: number, value: bigint): `0x${string}` {
  return `0x${((BigInt(kind) << 248n) | value).toString(16).padStart(64, "0")}`;
}
