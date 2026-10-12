import { HttpError } from "../lib/http.js";

// Availability of a specialist (PACKAGE_SPEC.md 15.4). `status` mirrors the on-chain state and the
// indexer rewrites it on every event; `platformStatus` is the platform suspension (kill switch) and is
// NEVER written by the indexer. It only SELLS if both are "active"; as for SERVING, `retired` still serves paid rights.

export type AgentAvailabilityFields = { status: string; platformStatus: string };

export const PLATFORM_ACTIVE = "active";
export const PLATFORM_SUSPENDED = "suspended";

export function agentIsAvailable(a: AgentAvailabilityFields): boolean {
  return a.status === "active" && a.platformStatus === PLATFORM_ACTIVE;
}

export const UNAVAILABLE_TEXT = "This specialist is temporarily unavailable.";
export const RETIRED_TEXT = "This specialist has been retired by its creator: it is no longer for sale and has no free trial. People who already have a license or an open guaranteed task can keep using it.";

/**
 * Who can be served (pure decision). `status` "retired" (the creator asked to withdraw the deposit) keeps serving PAID
 * rights (lifetime license, open guarantee) and never the free trial nor anyone without a right; "suspended" (chain)
 * or a suspended `platformStatus` (kill switch) cut everything off.
 */
export type ServePolicy = "all" | "paid_only" | "closed";
export type AccessKind = "license" | "guarantee" | "platform" | "trial" | "none";

export function servePolicy(a: AgentAvailabilityFields): ServePolicy {
  if (a.platformStatus !== PLATFORM_ACTIVE) return "closed";
  if (a.status === "active") return "all";
  if (a.status === "retired") return "paid_only";
  return "closed";
}

/** The free trial only exists for a live solver (not retired, not suspended). */
export const trialAllowed = (a: AgentAvailabilityFields): boolean => servePolicy(a) === "all";

export function agentCanServe(a: AgentAvailabilityFields, access: AccessKind): boolean {
  const p = servePolicy(a);
  // "platform": free platform Solver (no license): it is not a trial, so a retired one still serves.
  return p === "all" || (p === "paid_only" && (access === "license" || access === "guarantee" || access === "platform"));
}

export function assertAgentCanServe(a: AgentAvailabilityFields, access: AccessKind): void {
  if (agentCanServe(a, access)) return;
  throw new HttpError(403, servePolicy(a) === "paid_only" ? RETIRED_TEXT : UNAVAILABLE_TEXT, "agent_unavailable");
}

export function assertAgentAvailable(a: AgentAvailabilityFields): void {
  if (!agentIsAvailable(a)) throw new HttpError(403, UNAVAILABLE_TEXT, "agent_unavailable");
}
