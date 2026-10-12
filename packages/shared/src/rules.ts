import { DEFAULT_TOKEN_DECIMALS, numberToUnits, unitsToNumber } from "./money.js";
import type { GuaranteeLevel } from "./schemas.js";

// Pure business rules shared by server and web: scores, reputation, guarantee limits. Money helpers live in money.ts.

/** Free-trial activations when the manifest does not set `trial.uses`. */
export const FREE_TRIAL_USES = 3;

/** Creator gallery (like store screenshots) and photos per review. */
export const MAX_AGENT_IMAGES = 5;
export const MAX_REVIEW_IMAGES = 3;
/** Maximum size of each uploaded image (the server re-encodes it to a much smaller WebP). */
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export function bpsToScore(bps: number): number {
  return Math.round(bps) / 100;
}

export function scoreToBps(score: number): number {
  return Math.round(score * 100);
}

export function averageRating(ratingSum: number | bigint, ratingCount: number): number {
  if (!ratingCount) return 0;
  return Math.round((Number(ratingSum) / ratingCount) * 10) / 10;
}

export function reputationScore(purchases: number, disputesLost: number): number {
  const raw = 50 + Math.min(purchases, 20) * 1.5 - disputesLost * 15;
  return Math.max(0, Math.min(100, raw));
}

/** Purchases needed for the full guarantee level. */
export const FULL_LEVEL_PURCHASES = 3;

export function guaranteeLevel(purchases: number, disputesLost: number): GuaranteeLevel {
  const score = reputationScore(purchases, disputesLost);
  if (disputesLost >= MAX_BUYER_DISPUTES_LOST || score < 30) return "none";
  if (purchases < FULL_LEVEL_PURCHASES) return "limited";
  return "full";
}

/**
 * Creator reputation (0..100): grows with sales and a good rating, drops sharply with lost disputes.
 * Same idea as the buyer reputation, computed from the on-chain agent data.
 */
export function creatorReputationScore(totalSales: number, avgRating: number, disputesLost: number): number {
  const ratingBonus = avgRating > 0 ? (avgRating - 3) * 5 : 0;
  const raw = 50 + Math.min(totalSales, 20) * 1.5 + ratingBonus - disputesLost * 15;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** Maximum open guarantee value per level, in whole stablecoin units. */
export const GUARANTEE_LIMITS_USDC: Record<GuaranteeLevel, number> = {
  none: 0,
  limited: 20,
  full: 500,
};

/** Highest buyer `disputesLost` accepted by `createEscrow` (mirrors the contract's `disputesLost < 3`). */
export const MAX_BUYER_DISPUTES_LOST = 3;

/** At the limited level, guarantees above this value need at least 2 milestones. */
export const SINGLE_MILESTONE_MAX_USDC = 10;

/** A Solver leaves the storefront with a rating below DELIST_MAX_RATING after DELIST_MIN_REVIEWS reviews. */
export const DELIST_MIN_REVIEWS = 10;
export const DELIST_MAX_RATING = 3.5;

/**
 * Splits a guarantee price across the template's milestones (% each), in base units; the last milestone takes the
 * rounding remainder, so the parts always add up to the total.
 */
export function splitGuaranteeUnits(total: bigint, sharesPct: number[]): bigint[] {
  if (sharesPct.length === 0) return [];
  const weights = sharesPct.map((p) => BigInt(Math.round(p * 100)));
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum <= 0n) throw new RangeError("milestone shares must add up to more than zero");
  const units = weights.map((w) => (total * w) / sum);
  const rest = total - units.reduce((s, u) => s + u, 0n);
  units[units.length - 1] = units[units.length - 1]! + rest;
  return units;
}

/** Same split for a price given as a number of whole stablecoin units (display values). */
export function splitGuaranteeAmounts(total: number, sharesPct: number[], decimals: number = DEFAULT_TOKEN_DECIMALS): number[] {
  return splitGuaranteeUnits(numberToUnits(total, decimals), sharesPct).map((u) => unitsToNumber(u, decimals));
}
