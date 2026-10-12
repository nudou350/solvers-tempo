// Display of token amounts from base units (bigint or decimal string) with the token's decimals: exact decimal strings
// from `fromUnits` (@solvers/shared), formatted by Intl from the STRING (no float rounding of money). Pure, no React.
import { fromUnits } from "@solvers/shared";

/** Base units (bigint, integer string or a safe integer number) -> bigint; null when the value is not an integer amount. */
export function toBigUnits(units: bigint | string | number | null | undefined): bigint | null {
  if (typeof units === "bigint") return units;
  if (typeof units === "number") return Number.isSafeInteger(units) ? BigInt(units) : null;
  if (typeof units === "string" && /^-?\d+$/.test(units.trim())) return BigInt(units.trim());
  return null;
}

/**
 * "12.5" -> "12.50" / "12,50" (pt-BR): grouping and decimal separator of the locale, at least `minFraction` digits when
 * the amount has a fraction, never fewer digits than the exact value (money is not rounded).
 */
export function formatDecimalString(value: string, intlLocale: string, minFraction = 2): string {
  const frac = value.split(".")[1]?.length ?? 0;
  const nf = new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: frac === 0 ? 0 : Math.min(Math.max(minFraction, 0), 20),
    maximumFractionDigits: Math.min(Math.max(frac, minFraction), 20),
  });
  // Intl formats decimal strings exactly (ES2023 Intl.NumberFormat v3); a JS number is never involved.
  return nf.format(value as unknown as number);
}

/** Base units -> localized amount without the symbol ("1,234.5" -> "1,234.50"). Null for an invalid amount. */
export function formatUnits(units: bigint | string | number | null | undefined, decimals: number, intlLocale: string): string | null {
  const v = toBigUnits(units);
  if (v === null) return null;
  return formatDecimalString(fromUnits(v, decimals), intlLocale);
}

/** Base units -> "12.50 USD" with the token symbol. */
export function formatToken(units: bigint | string | number | null | undefined, token: { decimals: number; symbol: string }, intlLocale: string): string | null {
  const s = formatUnits(units, token.decimals, intlLocale);
  return s === null ? null : `${s} ${token.symbol}`;
}
