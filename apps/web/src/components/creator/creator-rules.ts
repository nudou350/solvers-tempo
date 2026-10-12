// Pure rules of the creator screens: amount and percentage parsing, the checks the contracts enforce (so the creator
// gets a clear message before the wallet opens) and the publication progress. No React, no I/O; tested in
// apps/web/test/creator-rules.test.ts. The server repeats every check and the contracts have the final word.
import { fromUnits, MAX_BPS, MAX_LICENSES_CAP, MAX_TOTAL_ROYALTY_BPS, toUnits, type AgentSupply, type PublicationStep } from "@solvers/shared";

// ----- Money: base-unit strings + decimals, never floats -----

export type AmountParse = { ok: true; units: string } | { ok: false; reason: "empty" | "invalid" | "too_many_decimals" | "zero" };

/**
 * Text typed by the creator ("12", "12.5", "12,50") -> base units as a decimal string. A comma is accepted as the
 * decimal separator; thousands separators are not (they are ambiguous between languages). Zero is refused unless
 * `allowZero` (a pay-per-use price of 0 turns credits off).
 */
export function parseAmount(text: string, decimals: number, opts: { allowZero?: boolean } = {}): AmountParse {
  const s = text.trim().replace(",", ".");
  if (!s) return { ok: false, reason: "empty" };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, reason: "invalid" };
  let units: bigint;
  try {
    units = toUnits(s, decimals);
  } catch {
    return { ok: false, reason: "too_many_decimals" };
  }
  if (units === 0n && !opts.allowZero) return { ok: false, reason: "zero" };
  return { ok: true, units: units.toString() };
}

/**
 * Base units -> text in the page language ("1,234.5" / "1.234,5"), exact (the integer part goes through BigInt, the
 * fraction is never rounded). `minFraction` pads the fraction (2 for prices).
 */
export function formatUnits(units: string | bigint, decimals: number, intlLocale: string, minFraction = 0): string {
  const plain = fromUnits(BigInt(units), decimals);
  const neg = plain.startsWith("-");
  const [int = "0", frac = ""] = (neg ? plain.slice(1) : plain).split(".");
  const fmt = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 0 });
  const sep = new Intl.NumberFormat(intlLocale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  const fraction = frac.padEnd(Math.min(minFraction, decimals), "0");
  return `${neg ? "-" : ""}${fmt.format(BigInt(int))}${fraction ? `${sep}${fraction}` : ""}`;
}

// ----- Transfer royalty (decisions.md D15) -----

export type PercentParse = { ok: true; bps: number } | { ok: false; reason: "empty" | "invalid" | "too_precise" };

/** "5" -> 500 bps, "2.5" -> 250, "2,25" -> 225. At most two decimal places (1 bps). */
export function parsePercentToBps(text: string): PercentParse {
  const s = text.trim().replace(",", ".").replace(/%$/, "").trim();
  if (!s) return { ok: false, reason: "empty" };
  const m = /^(\d{1,3})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: "invalid" };
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > 2) return { ok: false, reason: "too_precise" };
  const bps = Number(m[1]) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  if (bps > MAX_BPS) return { ok: false, reason: "invalid" };
  return { ok: true, bps };
}

/** Highest creator share allowed by the contract: creator + platform <= MAX_TOTAL_ROYALTY_BPS (25%). */
export function maxCreatorRoyaltyBps(platformBps: number | null): number {
  return Math.max(0, MAX_TOTAL_ROYALTY_BPS - (platformBps ?? 0));
}

export type RoyaltyCheck = { ok: true } | { ok: false; reason: "locked" | "too_high"; maxBps: number };

/** The creator share can change only before the first sale, and creator + platform never exceed 25%. */
export function royaltyCheck(bps: number, platformBps: number | null, sales: number): RoyaltyCheck {
  const maxBps = maxCreatorRoyaltyBps(platformBps);
  if (sales > 0) return { ok: false, reason: "locked", maxBps };
  if (bps > maxBps) return { ok: false, reason: "too_high", maxBps };
  return { ok: true };
}

// ----- License cap (raise only) -----

export type SupplyCheck = { ok: true } | { ok: false; reason: "invalid" | "below_sold" | "not_higher" | "too_high"; min: number };

/**
 * Next license cap (`SolversRegistry.setSupplyCap`): from "no limit" the first cap needs at least max(1, sold); after
 * that it can only go up. The cap is never a promise of scarcity: the creator can raise it again later.
 */
export function supplyCheck(supply: AgentSupply, next: number): SupplyCheck {
  const min = supply.max == null ? Math.max(1, supply.sold) : supply.max + 1;
  if (!Number.isInteger(next) || next < 1) return { ok: false, reason: "invalid", min };
  if (next > MAX_LICENSES_CAP) return { ok: false, reason: "too_high", min };
  if (supply.max == null) return next < min ? { ok: false, reason: "below_sold", min } : { ok: true };
  return next <= supply.max ? { ok: false, reason: "not_higher", min } : { ok: true };
}

// ----- Stake -----

export type SolverStatus = "active" | "pending" | "suspended" | "retired";

/** Live Staking state of a Solver as the dashboard returns it (`chainRead` false = unknown, not "none"). */
export type StakeLive = {
  chainRead: boolean;
  stakeExit: { exitAt: string; extensions: number } | null;
  slash: { amountUnits: string; executableAt: string; expiresAt: string; contested: boolean } | null;
};

/**
 * Stake operations that make sense for the Solver (`SolversStaking`): a retired Solver (exit requested) can cancel the
 * exit (not after an admin extension) or withdraw once the exit date passed and no penalty is pending; any other status
 * can top up or request the exit. Without the live state (or when the read failed) only the status decides and the
 * server checks the rest. The contract has the final word.
 */
export function stakeActions(status: SolverStatus, live?: StakeLive, now: number = Date.now()): { topUp: boolean; exit: boolean; cancelExit: boolean; withdraw: boolean } {
  const retired = status === "retired";
  const base = { topUp: !retired, exit: !retired, cancelExit: retired, withdraw: retired };
  if (!retired || !live?.chainRead) return base;
  const exit = live.stakeExit;
  return {
    topUp: false,
    exit: false,
    cancelExit: !!exit && exit.extensions === 0,
    withdraw: !!exit && Date.parse(exit.exitAt) <= now && !live.slash,
  };
}

/** Why "withdraw" is not available yet for a retired Solver (null when it is, or when the state is unknown). */
export function withdrawBlock(status: SolverStatus, live: StakeLive, now: number = Date.now()): { reason: "waiting"; until: string } | { reason: "slash" | "no_exit" } | null {
  if (status !== "retired" || !live.chainRead) return null;
  if (!live.stakeExit) return { reason: "no_exit" };
  if (live.slash) return { reason: "slash" };
  if (Date.parse(live.stakeExit.exitAt) > now) return { reason: "waiting", until: live.stakeExit.exitAt };
  return null;
}

/** A proposed penalty can be contested once; with an unknown state the form stays available (the server decides). */
export function canContest(live: StakeLive): boolean {
  if (!live.chainRead) return true;
  return !!live.slash && !live.slash.contested;
}

/** Minimum length of the reason when contesting a stake penalty (same as the server). */
export const CONTEST_MIN = 10;
export const CONTEST_MAX = 4000;

// ----- Publication progress (CoSign) -----

/** The four stages the creator sees after the review approved the package. */
export const PUBLISH_PHASES = ["sign", "confirmed", "approval", "live"] as const;
export type PublishPhase = (typeof PUBLISH_PHASES)[number];
export type PhaseState = "done" | "current" | "todo" | "skipped" | "blocked";

/**
 * State of each stage from the server's publication plan (`step`), whether this is a new Solver (only new Solvers wait
 * for the platform's on-chain approval, done by the team with `cli:approve`) and what the screen is doing right now
 * (`local`: the wallet is signing or the server is confirming the transaction).
 */
export function publishPhases(step: PublicationStep | null, isNewAgent: boolean, local: "idle" | "signing" | "confirming" = "idle"): Record<PublishPhase, PhaseState> {
  const approval: PhaseState = isNewAgent ? "todo" : "skipped";
  if (local === "confirming") return { sign: "done", confirmed: "current", approval, live: "todo" };
  switch (step) {
    case "register-agent":
    case "update-version":
    case "update-pricing":
      return { sign: "current", confirmed: "todo", approval, live: "todo" };
    case "await-admin-approval":
      return { sign: "done", confirmed: "done", approval: "current", live: "todo" };
    case "ready":
      return { sign: "done", confirmed: "done", approval: isNewAgent ? "done" : "skipped", live: "current" };
    case "blocked":
      return { sign: "blocked", confirmed: "todo", approval, live: "todo" };
    default:
      return { sign: "todo", confirmed: "todo", approval, live: "todo" };
  }
}

/**
 * Big KPI figure (display only): whole units from 10 up, 2 decimals below 10 so small revenue never shows as "$0"
 * (0.45 -> "$0.45"). English: dollars 1:1 with the stablecoin; Portuguese with a rate: an estimate in reais.
 */
export function kpiHeadline(amount: number, o: { lang: "en" | "pt"; rate: number | null; intlLocale: string }): string {
  const pt = o.lang === "pt" && !!o.rate;
  const v = pt ? amount * (o.rate as number) : amount;
  const digits = Math.abs(v) < 10 && v !== 0 ? 2 : 0;
  const text = v.toLocaleString(o.intlLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return pt ? `R$ ${text}` : `$${text}`;
}
