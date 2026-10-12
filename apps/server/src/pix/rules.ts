// Pure Pix rules (no env, database or network), tested in test/pix-rules.test.ts.

/** Smallest and largest Pix charge accepted (BRL cents). */
export const PIX_MIN_CENTS = 100; // R$ 1
export const PIX_MAX_CENTS = 50_000; // R$ 500
/** Open (unpaid) Pix charges per wallet. */
export const PIX_MAX_PENDING = 3;
/** Same as the expiration requested from Mercado Pago (PT30M). */
export const PIX_TTL_MS = 30 * 60_000;
/** After the local expiry, a real order is cancelled at Mercado Pago before the charge is marked expired. */
export const PIX_EXPIRY_GRACE_MS = 5 * 60_000;

/**
 * Only charges of the simulated provider can be "paid" through the simulation route. With Mercado Pago configured a
 * real pending charge must never be approved that way: any signed-in user would get the purchase without paying.
 */
export function simulateBlockReason(provider: string): "pix_not_simulated" | null {
  return provider === "simulated" ? null : "pix_not_simulated";
}

const E8 = 100_000_000n;

/** BRL per USD as an integer scaled by 1e8 (the ledger stores the rate as numeric(18,8)). */
export function rateToE8(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`invalid FX rate: ${rate}`);
  return BigInt(Math.round(rate * 1e8));
}

/** "5.43210000" (exactly 8 decimals) from a 1e8-scaled rate. */
export function formatRateE8(rateE8: bigint): string {
  const int = rateE8 / E8;
  const frac = (rateE8 % E8).toString().padStart(8, "0");
  return `${int}.${frac}`;
}

/**
 * BRL cents for `units` of a USD stablecoin with `decimals` decimals at `rateE8` BRL/USD, rounded half up to the cent
 * (the same total the store shows). The platform pays the exact token amount on-chain; the half-cent difference is the
 * platform's.
 */
export function brlCentsFor(units: bigint, rateE8: bigint, decimals: number): bigint {
  const denominator = 10n ** BigInt(decimals) * E8;
  return (units * rateE8 * 100n + denominator / 2n) / denominator;
}

export type PixLimitError = { code: "pix_min" | "pix_max"; message: string };

export function pixLimitError(cents: bigint): PixLimitError | null {
  if (cents < BigInt(PIX_MIN_CENTS)) return { code: "pix_min", message: `The minimum Pix amount is R$ ${(PIX_MIN_CENTS / 100).toFixed(2)}.` };
  if (cents > BigInt(PIX_MAX_CENTS)) return { code: "pix_max", message: `The maximum amount per Pix is R$ ${(PIX_MAX_CENTS / 100).toFixed(2)}.` };
  return null;
}

/** Mercado Pago order status -> what it means for our charge. */
export type MpOutcome = "paid" | "pending" | "expired" | "failed" | "refunded";

export function mpOrderOutcome(status: string | undefined): MpOutcome {
  switch (status) {
    case "processed":
      return "paid";
    case "expired":
    case "canceled":
      return "expired";
    case "failed":
      return "failed";
    case "refunded":
    case "charged_back":
      return "refunded";
    default:
      // action_required, processing, unknown: not paid yet
      return "pending";
  }
}

/** Placeholder copy-and-paste code of a simulated charge: it cannot be paid at any bank. */
export function simulatedPixCode(chargeId: string, cents: bigint): string {
  return `PIX-TEST-SOLVERS|DO-NOT-PAY|SIMULATED|${chargeId}|R$${(Number(cents) / 100).toFixed(2)}`;
}
