// Money display for the storefront and checkout (pure, no React). Amounts are token base units (bigint or decimal
// strings) plus the payment token's decimals from the public config; no float math on amounts. Numbers only appear at
// the display edge for the BRL estimate, which is a conversion by an FX rate anyway.
import { fromUnits, MAX_BPS, MAX_TOTAL_ROYALTY_BPS, numberToUnits, royaltySplit, unitsToNumber } from "@solvers/shared";

/** The payment token as the public config describes it (`PublicConfig.paymentToken`). */
export type TokenInfo = { symbol: string; decimals: number };

/** Decimal separator of a BCP 47 locale ("." for en-US, "," for pt-BR). */
function decimalSeparator(intlLocale: string): string {
  return new Intl.NumberFormat(intlLocale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Base units -> localized decimal text, exact (never rounded): `12_500_000n`, 6 -> "12.50" (en) / "12,50" (pt).
 * Whole amounts have no decimals unless `fixed2`; fractional amounts show at least 2 decimals and every significant
 * digit after that.
 */
export function formatUnits(units: bigint | string, decimals: number, intlLocale: string, opts: { fixed2?: boolean } = {}): string {
  const exact = fromUnits(BigInt(units), decimals);
  const [int = "0", frac = ""] = exact.split(".");
  const intText = BigInt(int).toLocaleString(intlLocale);
  const fracText = frac === "" ? (opts.fixed2 ? "00" : "") : frac.padEnd(2, "0");
  return fracText ? `${intText}${decimalSeparator(intlLocale)}${fracText}` : intText;
}

/** "12.50 pathUSD": an amount in the payment token, with its symbol. */
export function tokenText(units: bigint | string, token: TokenInfo, intlLocale: string): string {
  return `${formatUnits(units, token.decimals, intlLocale)} ${token.symbol}`;
}

/** "$12.50": the payment token is a US-dollar stablecoin, shown 1:1 as dollars (always 2 decimals). */
export function usdText(units: bigint | string, decimals: number, intlLocale: string): string {
  return `$${formatUnits(units, decimals, intlLocale, { fixed2: true })}`;
}

/** "R$ 64,90": BRL estimate of an amount at the given BRL/USD rate (display only; Pix charges carry their own BRL). */
export function brlText(units: bigint | string, decimals: number, rate: number, intlLocale: string, digits = 2): string {
  const v = unitsToNumber(units, decimals) * rate;
  return `R$ ${v.toLocaleString(intlLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A BRL value already computed by the server (e.g. `AgentDetail.priceBrl`, `PixCharge.amountBrl`). */
export function brlValueText(reais: number, intlLocale: string, digits = 2): string {
  return `R$ ${reais.toLocaleString(intlLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Display price (a whole-stablecoin number from the catalog, e.g. `Agent.priceUsdc`) -> base units, or null when the
 * number cannot be represented with the token's decimals (never rounded silently).
 */
export function priceUnits(price: number, decimals: number): bigint | null {
  try {
    return numberToUnits(price, decimals);
  } catch {
    return null;
  }
}

/** Decimal string from the API (`UnitsString`) -> bigint, or null when it is not a base-unit amount. */
export function parseUnits(value: string | null | undefined): bigint | null {
  if (value == null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

/** Basis points -> percent text without float noise: 500 -> "5%", 750 -> "7.5%", 125 -> "1.25%". */
export function bpsText(bps: number, intlLocale: string): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) return "";
  return `${formatUnitsTrim(BigInt(bps), 2, intlLocale)}%`;
}

/** Like `formatUnits` but with no padding of the fraction (for percentages). */
function formatUnitsTrim(units: bigint, decimals: number, intlLocale: string): string {
  const [int = "0", frac = ""] = fromUnits(units, decimals).split(".");
  const intText = BigInt(int).toLocaleString(intlLocale);
  return frac ? `${intText}${decimalSeparator(intlLocale)}${frac}` : intText;
}

/** What the owner of a license pays to transfer it (decisions.md D15), mirrored from the contract math. */
export type RoyaltyInfo = {
  creatorBps: number;
  platformBps: number;
  totalBps: number;
  creatorUnits: bigint;
  platformUnits: bigint;
  totalUnits: bigint;
};

/**
 * Transfer royalty of a license bought at `originalUnits`: creator share (the Solver's own `royaltyBps`) plus the
 * platform share (`PublicConfig.royalty.platformBps`), each floored, the platform share clamped to the 25% cap.
 * null when the platform share is unknown (config not readable) or the inputs are invalid.
 */
export function royaltyInfo(originalUnits: bigint | null, creatorBps: number, platformBps: number | null): RoyaltyInfo | null {
  if (originalUnits == null || platformBps == null) return null;
  try {
    const split = royaltySplit(originalUnits, creatorBps, platformBps);
    // Effective platform share, as the contract applies it (clamped so the total never exceeds the cap).
    const effPlatformBps = Math.max(0, Math.min(platformBps, MAX_TOTAL_ROYALTY_BPS - creatorBps));
    return {
      creatorBps,
      platformBps: effPlatformBps,
      totalBps: creatorBps + effPlatformBps,
      creatorUnits: split.creatorAmount,
      platformUnits: split.platformAmount,
      totalUnits: split.total,
    };
  } catch {
    return null;
  }
}
