// Pure paid-access rules (no env/database), tested in test/trial.test.ts.

/** Paid access: lifetime license or an open guaranteed task (no trial limits). */
export type PaidAccess = { kind: "license"; licenseId: string } | { kind: "guarantee"; escrowId: string };

/** Free access to a platform Solver (PLATFORM_AGENTS): no license, no free trial and no use counter. */
export type PlatformAccess = { kind: "platform" };

/** Escrow statuses in which the task is still running (derived on-chain; approved and refunded are terminal). */
export const OPEN_ESCROW_STATUSES = ["active", "disputed"] as const;

/** Terminal escrow statuses (D19: there is no stored "closed" flag; completed or refunded tasks are closed). */
export const TERMINAL_ESCROW_STATUSES = ["approved", "refunded"] as const;

export function isTerminalEscrowStatus(status: string): boolean {
  return (TERMINAL_ESCROW_STATUSES as readonly string[]).includes(status);
}

/** The guarantee gives access while it is open: confirmed, not closed, neither approved nor refunded. */
export function escrowGivesAccess(e: { status: string; closed: boolean }): boolean {
  return !e.closed && (OPEN_ESCROW_STATUSES as readonly string[]).includes(e.status);
}

/** Result of the license check: owned, not owned, or could not be confirmed (slow or failing RPC). */
export type LicenseCheck = { state: "owned"; id: string } | { state: "none" } | { state: "unknown" };

/**
 * No confirmed paid access: what blocks before the free trial? null = go on to the trial.
 * - "unverified": the license could not be confirmed (RPC): never sends the user to buy nor spends a trial because of it.
 * - "retired": a retired Solver has no trial.
 * - "agent_no_trial": an agent (direct SIWE login) has no free trial.
 */
export function blockBeforeTrial(i: { licenseUnknown: boolean; allowTrial: boolean; agent: boolean }): "unverified" | "retired" | "agent_no_trial" | null {
  if (i.licenseUnknown) return "unverified";
  if (!i.allowTrial) return "retired";
  if (i.agent) return "agent_no_trial";
  return null;
}

/** activate_solver access line for paid access (or the free access of a platform Solver). */
export function paidAccessLine(kind: PaidAccess["kind"] | PlatformAccess["kind"]): string {
  if (kind === "platform") return "Access: free (platform Solver, no license and no trial limits).";
  return kind === "license" ? "Access: lifetime license." : "Access: guaranteed task (no limits while the guarantee is open).";
}
