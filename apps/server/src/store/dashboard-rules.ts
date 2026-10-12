import type { CreatorSlash, CreatorStakeExit } from "@solvers/shared";
import { SLASH_DELAY_SECS, SLASH_EXPIRY_GRACE_SECS } from "../cli/admin-guard.js";
import type { SlashOnChain, StakeExitOnChain } from "./chain-reads.js";

// Pure rules of the creator dashboard: money stays in base units (bigint) from the SQL to the JSON, and the live
// Staking reads become the API shape. No I/O; tested in test/creator-dashboard.test.ts.

/**
 * A Postgres `sum()` of a bigint column as text (numeric: "123", sometimes "123.0") -> base units. A real fraction
 * means the query is wrong, so it throws instead of rounding.
 */
export function unitsFromSql(text: string | number | bigint | null | undefined): bigint {
  if (text == null) return 0n;
  if (typeof text === "bigint") return text;
  const s = String(text).trim();
  const m = /^(-?\d+)(?:\.0*)?$/.exec(s);
  if (!m) throw new RangeError(`not a whole base-unit amount: ${JSON.stringify(s)}`);
  return BigInt(m[1]!);
}

/** Exact sum of base-unit amounts. */
export function sumUnits(xs: Iterable<bigint>): bigint {
  let total = 0n;
  for (const x of xs) total += x;
  return total;
}

const iso = (secs: number): string => new Date(secs * 1000).toISOString();

/** `stakeExitOf` -> API shape; null when no exit was requested (`exitAt` 0). */
export function stakeExitView(e: StakeExitOnChain): CreatorStakeExit | null {
  if (!e.exitAt) return null;
  return { exitAt: iso(e.exitAt), extensions: e.extensions };
}

/** `slashOf` -> API shape; null when nothing is proposed (`proposedAt` 0). Windows mirror `SolversStaking` constants. */
export function slashView(s: SlashOnChain): CreatorSlash | null {
  if (!s.proposedAt) return null;
  const executableAt = s.proposedAt + SLASH_DELAY_SECS;
  return {
    amountUnits: s.amount.toString(),
    executableAt: iso(executableAt),
    expiresAt: iso(executableAt + SLASH_EXPIRY_GRACE_SECS),
    contested: s.contestedAt !== 0,
  };
}
