// Pure helpers of the account screens (library, transfer, payouts, guarantees, profile). No React, no float math on
// money: amounts are token base units (bigint or decimal strings) plus the token's decimals.
import { checksumAddress, fromUnits, isAddress, MAX_BPS, type DeferredPayouts, type RoyaltyQuote } from "@solvers/shared";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Every TIP-20 token lives at an address starting with these 12 bytes; a license sent there is lost. */
const TIP20_PREFIX = "0x20c000000000000000000000";

/** Decimal separator of a locale ("." for en, "," for pt-BR). */
function decimalSeparator(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Base units -> localized amount, exact (no rounding, no float): `12_500_000n`, 6, "en-US" -> "12.50".
 * At least `minFraction` decimals are shown (default 2), more only when the amount has them.
 */
export function formatUnits(units: bigint | string, decimals: number, locale: string, minFraction = 2): string {
  const exact = fromUnits(BigInt(units), decimals);
  const neg = exact.startsWith("-");
  const [int = "0", frac = ""] = (neg ? exact.slice(1) : exact).split(".");
  const intText = new Intl.NumberFormat(locale, { useGrouping: true }).format(BigInt(int));
  const fracText = frac.padEnd(Math.min(minFraction, decimals), "0");
  return `${neg ? "-" : ""}${intText}${fracText ? `${decimalSeparator(locale)}${fracText}` : ""}`;
}

/** Amount with the token symbol: "12.50 USD". */
export function formatMoney(units: bigint | string, token: { decimals: number; symbol: string }, locale: string): string {
  return `${formatUnits(units, token.decimals, locale)} ${token.symbol}`;
}

/** Basis points as a percentage, exact: 500 -> "5%", 750 -> "7.5%" ("7,5%" in pt), 333 -> "3.33%". */
export function bpsPercent(bps: number, locale: string): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) throw new RangeError(`invalid bps: ${bps}`);
  const int = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${int}${frac ? `${decimalSeparator(locale)}${frac}` : ""}%`;
}

export type RecipientProblem = "empty" | "format" | "checksum" | "zero" | "self" | "contract";
export type RecipientCheck = { ok: true; address: `0x${string}` } | { ok: false; reason: RecipientProblem };

/**
 * Validates the address a license is sent to. Mixed-case input must carry a valid EIP-55 checksum (a wrong one usually
 * means a typo). Refuses the zero address, the owner's own wallet, the platform's contracts (`blocked`) and token
 * addresses: a license sent to any of them can never come back. Returns the checksummed form for display.
 */
export function checkRecipient(input: string, ctx: { owner?: string | null; blocked?: readonly string[] } = {}): RecipientCheck {
  const s = input.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, reason: "format" };
  if (!isAddress(s)) return { ok: false, reason: "checksum" };
  const lower = s.toLowerCase();
  if (lower === ZERO_ADDRESS) return { ok: false, reason: "zero" };
  if (ctx.owner && lower === ctx.owner.trim().toLowerCase()) return { ok: false, reason: "self" };
  if (lower.startsWith(TIP20_PREFIX) || (ctx.blocked ?? []).some((b) => b.trim().toLowerCase() === lower)) return { ok: false, reason: "contract" };
  return { ok: true, address: checksumAddress(s) };
}

/** "0xAbCd…1234" (checksummed when valid). */
export function shortAddress(address: string): string {
  const a = isAddress(address) ? checksumAddress(address) : address;
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export type RoyaltyDisclosure = {
  /** Total share of the original price, e.g. "10%". */
  totalPct: string;
  creatorPct: string;
  platformPct: string;
  original: string;
  creator: string;
  platform: string;
  total: string;
  /** Total in base units (what the transfer charges and the `maxRoyalty` sent to the contract). */
  totalUnits: bigint;
};

/**
 * Texts of the royalty disclosure, straight from the server's quote (the contract's own `quoteRoyalty`): the percentages
 * are the quote's bps, never hard-coded, and the amounts are the quote's exact units.
 */
export function royaltyDisclosure(quote: RoyaltyQuote, symbol: string, locale: string): RoyaltyDisclosure {
  const money = (u: string | bigint) => formatMoney(u, { decimals: quote.decimals, symbol }, locale);
  return {
    totalPct: bpsPercent(quote.creatorBps + quote.platformBps, locale),
    creatorPct: bpsPercent(quote.creatorBps, locale),
    platformPct: bpsPercent(quote.platformBps, locale),
    original: money(quote.originalPriceUnits),
    creator: money(quote.creatorAmountUnits),
    platform: money(quote.platformAmountUnits),
    total: money(quote.totalUnits),
    totalUnits: BigInt(quote.totalUnits),
  };
}

/** True when the balance covers `needed` (both in base units). */
export function hasEnough(balanceUnits: bigint | string | null | undefined, needed: bigint | string): boolean {
  if (balanceUnits == null) return false;
  return BigInt(balanceUnits) >= BigInt(needed);
}

/** Amount held for the wallet (payments it could not receive directly), in base units; 0n when nothing is held. */
export function heldTotal(payouts: DeferredPayouts | null | undefined): bigint {
  if (!payouts) return 0n;
  const total = BigInt(payouts.totalUnits);
  return total > 0n ? total : 0n;
}

/** Why unlocking the memories failed, for the text the screen shows. */
export type MemoryUnlockFailure = "refused" | "session" | "cancelled" | "other";

/**
 * Classifies an error of the memory unlock (wallet signature + `POST /api/me/memory-key`). The server answers 400
 * `memory_signature_refused` when it cannot derive a key from the signature (not the signed-in wallet, or a smart-contract
 * wallet); a 401 means the session itself ended. Duck-typed on `status`/`code`, so it needs no API client import.
 */
export function memoryUnlockFailure(e: unknown): MemoryUnlockFailure {
  const o = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (o.code === "memory_signature_refused") return "refused";
  if (o.status === 401 || o.code === "unauthorized") return "session";
  const msg = typeof o.message === "string" ? o.message : "";
  if (o.code === "cancelled" || o.code === 4001 || /cancel|rejected|denied/i.test(msg)) return "cancelled";
  return "other";
}
