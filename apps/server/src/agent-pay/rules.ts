import { keccak256, stringToBytes } from "viem";

// Pure rules of agent payments (no env, database or network), tested in test/agent-pay-rules.test.ts.

/** Placeholder buyer of an order whose payment has not arrived yet (the license goes to whoever pays). */
export const UNKNOWN_BUYER = "0x0000000000000000000000000000000000000000";

/** Open (unpaid) orders per client IP. */
export const MAX_OPEN_ORDERS_PER_IP = 5;

/**
 * After the order's expiry the payment may still land for a moment (the challenge expiry is checked right before the
 * broadcast), so an order is closed only after this grace period.
 */
export const ORDER_EXPIRY_GRACE_MS = 120_000;

/**
 * How long a credential's claim on an order (`settling`) blocks another credential for the same order. It covers the
 * broadcast and the receipt wait of one payment; a second payment after it is still caught and refunded by
 * `markSettled` (a settlement other than the recorded one is a duplicate).
 */
export const SETTLING_LOCK_MS = 120_000;

/** Orders whose settlements the reconcile job still looks for: open for the TTL, the grace period and this margin. */
export const SETTLEMENT_SCAN_MARGIN_MS = 30 * 60_000;

/** Created after this instant = still scanned for settlements (pure). */
export function scanWindowStart(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() - ttlMs - ORDER_EXPIRY_GRACE_MS - SETTLEMENT_SCAN_MARGIN_MS);
}

export type PriceBounds = { min: bigint; max: bigint };

/** Accepted price range in base units: the env bounds, never below the contracts' `minPrice`. */
export function priceBounds(env: { minUnits: bigint; maxUnits: bigint }, onchainMin: bigint): PriceBounds {
  return { min: env.minUnits > onchainMin ? env.minUnits : onchainMin, max: env.maxUnits };
}

export function priceInBounds(price: bigint, b: PriceBounds): boolean {
  return price >= b.min && price <= b.max;
}

/**
 * Whether a TIP-20 memo is the MPP attribution memo bound to `challengeId`: tag keccak256("mpp")[0..3], version 1, and
 * bytes 25..31 = keccak256(challengeId)[0..6] (mppx `Attribution`, which the package does not export).
 */
export function memoBoundTo(memo: string, challengeId: string): boolean {
  const nonce = memoNonce(memo);
  return nonce !== null && nonce === challengeNonce(challengeId);
}

/** keccak256(challengeId)[0..6] as hex: the part of an MPP memo that binds it to one challenge (see `memoBoundTo`). */
export function challengeNonce(challengeId: string): string {
  return keccak256(stringToBytes(challengeId)).slice(2, 16);
}

/** The challenge nonce carried by an MPP memo, or null when the memo is not an MPP attribution memo. */
export function memoNonce(memo: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) return null;
  const tag = keccak256(stringToBytes("mpp")).slice(2, 10);
  if (memo.slice(2, 10).toLowerCase() !== tag || memo.slice(10, 12) !== "01") return null;
  return memo.slice(2 + 50).toLowerCase();
}

/** `externalId` (our charge id) of an `Authorization: Payment <credential>` header, without trusting anything else. */
export function chargeIdOfCredential(credential: { challenge?: { request?: unknown } } | null): string | null {
  const req = credential?.challenge?.request as { externalId?: unknown } | undefined;
  return typeof req?.externalId === "string" && /^ap_[0-9a-f]{24}$/.test(req.externalId) ? req.externalId : null;
}
