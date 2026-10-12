import { badRequest, HttpError } from "../lib/http.js";

// Pure rules for connector sessions (no env/database), tested in test/session.test.ts.

/** The session belongs to an old version of the specialist: content and knowledge base no longer match. */
export function assertSessionCurrent(sessionVersion: string, currentVersion: string, name: string): void {
  if (sessionVersion === currentVersion) return;
  throw new HttpError(
    409,
    `${name} was updated (v${sessionVersion} to v${currentVersion}) and this session is out of date. Call activate_solver again to open a session on the current version.`,
    "session_outdated",
  );
}

export type NextStepPlan = { kind: "advance"; index: number } | { kind: "replay"; index: number };

/**
 * next_step with `completed_step` (how many steps the AI has completed; 0 at the start). Session with
 * `stepIndex` = steps already delivered:
 * - absent or equal: advances (the usual behavior);
 * - lower: the previous response was lost and the AI repeats the call; resends the step without advancing;
 * - higher: the AI claims to have completed steps it never received.
 */
export function planNextStep(stepIndex: number, completedStep?: number): NextStepPlan {
  if (completedStep === undefined || completedStep === stepIndex) return { kind: "advance", index: stepIndex };
  if (completedStep > stepIndex) {
    throw badRequest(`completed_step=${completedStep} is greater than the steps already delivered (${stepIndex}). Use the number of the last step you completed.`, "invalid_completed_step");
  }
  return { kind: "replay", index: completedStep };
}

/** Stores the summary of step `slot` (0-based) in the context, without touching the others. */
export function withSummary(context: Record<string, unknown>, slot: number, summary: string): Record<string, unknown> {
  const summaries = Array.isArray(context.summaries) ? [...(context.summaries as unknown[])] : [];
  if (slot >= 0) summaries[slot] = summary.slice(0, 4000);
  return { ...context, summaries };
}

/** On-chain recheck of a session's license: at most once per short window. */
export const LICENSE_RECHECK_MS = 45_000;

export function licenseRecheckDue(lastCheckedAt: number | undefined, now: number, ttlMs = LICENSE_RECHECK_MS): boolean {
  return lastCheckedAt === undefined || now - lastCheckedAt >= ttlMs || now < lastCheckedAt;
}
