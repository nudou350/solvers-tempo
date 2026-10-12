// Money: token base units as bigint end to end, fee/royalty math mirrored byte for byte from the contracts
// (`SolversMath.feeSplit` / `royaltySplit`, plan §4.7, decisions.md D14/D15). No float math on amounts: numbers only
// appear at the display edge (`unitsToNumber`) and when reading human-entered prices (`numberToUnits`).

/** Basis-point denominator. */
export const MAX_BPS = 10_000;
/** Highest primary-sale platform fee the Registry accepts (20%). */
export const MAX_FEE_BPS = 2_000;
/** Highest transfer royalty, creator + platform (25% of the original price). */
export const MAX_TOTAL_ROYALTY_BPS = 2_500;

/**
 * Documented default for the payment token's decimals: TIP-20 tokens always have 6. The real value comes from config
 * (`PAYMENT_TOKEN_DECIMALS`, checked against `decimals()` on-chain at boot, `PublicConfig.paymentToken.decimals`).
 */
export const DEFAULT_TOKEN_DECIMALS = 6;
/** Default minimum purchase in whole stablecoin units (license, credits, guarantee); the contract stores it in base units. */
export const DEFAULT_MIN_PRICE = 5;

const BPS = BigInt(MAX_BPS);

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError(`invalid decimals: ${decimals}`);
}

function assertBps(name: string, bps: number, max = MAX_BPS): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new RangeError(`invalid ${name}: ${bps} (expected an integer in 0..${max})`);
}

function assertAmount(name: string, amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 0n) throw new RangeError(`invalid ${name}: ${String(amount)} (expected a non-negative bigint)`);
}

/** `10^decimals` as bigint. */
export function unitScale(decimals: number): bigint {
  assertDecimals(decimals);
  return 10n ** BigInt(decimals);
}

/** Default `minPrice` in base units: `5 × 10^decimals` (5_000_000 for a 6-decimal token). */
export function DEFAULT_MIN_PRICE_UNITS(decimals: number = DEFAULT_TOKEN_DECIMALS): bigint {
  return BigInt(DEFAULT_MIN_PRICE) * unitScale(decimals);
}

/**
 * Primary-sale split, mirror of `SolversMath.feeSplit`: `fee = amount × bps / 10_000` (floor), `rest = amount − fee`
 * (the rounding remainder goes to the creator).
 */
export function feeSplit(amount: bigint, feeBps: number): { fee: bigint; rest: bigint } {
  assertAmount("amount", amount);
  assertBps("feeBps", feeBps);
  const fee = (amount * BigInt(feeBps)) / BPS;
  return { fee, rest: amount - fee };
}

/**
 * Transfer royalty, mirror of `SolversMath.royaltySplit`: each share is a floored bps of the ORIGINAL price (dust stays
 * with the payer). The creator share is at most `MAX_TOTAL_ROYALTY_BPS`; the platform share is clamped so the total
 * never exceeds it: `effectivePlatformBps = min(platformBps, MAX_TOTAL_ROYALTY_BPS − creatorBps)`.
 */
export function royaltySplit(
  originalPrice: bigint,
  creatorBps: number,
  platformBps: number,
): { creatorAmount: bigint; platformAmount: bigint; total: bigint } {
  assertAmount("originalPrice", originalPrice);
  assertBps("creatorBps", creatorBps, MAX_TOTAL_ROYALTY_BPS);
  assertBps("platformBps", platformBps);
  const effectivePlatformBps = Math.min(platformBps, MAX_TOTAL_ROYALTY_BPS - creatorBps);
  const creatorAmount = (originalPrice * BigInt(creatorBps)) / BPS;
  const platformAmount = (originalPrice * BigInt(effectivePlatformBps)) / BPS;
  return { creatorAmount, platformAmount, total: creatorAmount + platformAmount };
}

// ----- Unit conversion -----

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Exact decimal string -> base units (`"12.5"`, 6 -> `12_500_000n`). Rejects signs, exponents and more fractional
 * digits than `decimals` (unless the extra digits are zeros): money is never rounded silently.
 */
export function toUnits(amount: string, decimals: number): bigint {
  const scale = unitScale(decimals);
  const m = DECIMAL_RE.exec(amount.trim());
  if (!m) throw new RangeError(`invalid amount: ${JSON.stringify(amount)}`);
  const int = m[1]!;
  let frac = m[2] ?? "";
  if (frac.length > decimals) {
    if (/[^0]/.test(frac.slice(decimals))) throw new RangeError(`amount ${amount} has more than ${decimals} decimals`);
    frac = frac.slice(0, decimals);
  }
  return BigInt(int) * scale + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units -> exact decimal string without trailing zeros (`12_500_000n`, 6 -> `"12.5"`). */
export function fromUnits(units: bigint, decimals: number): string {
  const scale = unitScale(decimals);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const int = abs / scale;
  const frac = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Shortest decimal representation of a finite number, expanding exponent notation (`1e-7` -> `"0.0000001"`). */
function plainDecimal(n: number): string {
  const s = String(n);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[1]! + (m[2] ?? "");
  const point = m[1]!.length + Number(m[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Human-entered or manifest price (a JS number, e.g. `pricing.priceUsdc`) -> base units. Uses the number's shortest
 * decimal form (what was typed: `1.005` stays `1.005`) and rounds half up at `decimals`, so float noise such as
 * `0.1 + 0.2` becomes `300_000n` at 6 decimals.
 */
export function numberToUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`invalid amount: ${amount}`);
  const scale = unitScale(decimals);
  const [int = "0", frac = ""] = plainDecimal(amount).split(".");
  let units = BigInt(int) * scale + BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (frac.replace(/0+$/, "").length > decimals) {
    // Money is never rounded silently: extra decimals are accepted only when they are binary float noise (e.g.
    // 0.1 + 0.2 = 0.30000000000000004), i.e. the value rounded to `decimals` is the same double within a few ULPs.
    if (frac.charCodeAt(decimals) >= 53 /* 5 */) units += 1n;
    const rounded = Number(fromUnits(units, decimals));
    if (Math.abs(rounded - amount) > Number.EPSILON * Math.max(1, Math.abs(amount)) * 8) {
      throw new RangeError(`${amount} has more than ${decimals} decimal places`);
    }
  }
  return units;
}

/** Base units -> the nearest JS number, for display and legacy numeric API fields only. */
export function unitsToNumber(units: bigint | number | string, decimals: number): number {
  return Number(fromUnits(BigInt(units), decimals));
}

/** @deprecated Use `numberToUnits(amount, decimals)` with the configured decimals. Kept while apps/ is ported. */
export function usdcToUnits(amount: number, decimals: number = DEFAULT_TOKEN_DECIMALS): bigint {
  return numberToUnits(amount, decimals);
}

/** @deprecated Use `unitsToNumber(units, decimals)` with the configured decimals. Kept while apps/ is ported. */
export function unitsToUsdc(units: bigint | number | string, decimals: number = DEFAULT_TOKEN_DECIMALS): number {
  return unitsToNumber(units, decimals);
}
