import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { SolverPackage } from "./packages.js";
import { trialLimits, type TrialLimits, type TrialUsage } from "./trial.js";
import { blockBeforeTrial, escrowGivesAccess, OPEN_ESCROW_STATUSES, type LicenseCheck, type PaidAccess, type PlatformAccess } from "./access-rules.js";
import { findUnindexedLicenses, refreshLicenseOwner } from "./licenses.js";
import { isPlatformAgent, isPlatformAgentRow, PLATFORM_AGENT_IDS } from "./platform-agents.js";

export type { PaidAccess, PlatformAccess } from "./access-rules.js";

export type Access =
  | ({ ok: true } & PaidAccess)
  | ({ ok: true } & PlatformAccess)
  | { ok: true; kind: "trial"; trial: TrialLimits; used: number; remaining: number; usage: TrialUsage }
  | { ok: false; reason: "no_trial" | "trial_exhausted" | "retired" | "agent_no_trial" | "unverified"; trial: TrialLimits | null };

type AgentRow = typeof schema.agents.$inferSelect;

/** How long the on-chain fallback may take before the answer is "unknown" (never "no license"). */
const FALLBACK_TIMEOUT_MS = 3000;

/** Valid lifetime license? Re-checks the current owner on-chain (the license may have been transferred). */
async function licenseCheck(wallet: string, agent: AgentRow): Promise<LicenseCheck> {
  const rows = await db
    .select()
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, agent.id), eq(schema.licenses.burned, false)));
  for (const r of rows) {
    // RPC failure: the mirror's owner counts (never "assume" the wallet that asked).
    const owner = await refreshLicenseOwner(r.id).catch(() => r.ownerWallet);
    if (owner === wallet) return { state: "owned", id: r.id };
  }
  // On-chain fallback: bought (or received) and the indexer has not written it yet. Only for Solvers registered on-chain.
  if (agent.chainIndex !== null) {
    // A slow or failing RPC is NOT "no license": whoever just paid must never be sent to buy again.
    const found = await Promise.race([
      findUnindexedLicenses(wallet, agent.id),
      new Promise<null>((r) => setTimeout(() => r(null), FALLBACK_TIMEOUT_MS)),
    ]).catch(() => null);
    if (found === null) return { state: "unknown" };
    if (found[0]) return { state: "owned", id: found[0] };
  }
  return { state: "none" };
}

/** Open guaranteed task of this wallet for the Solver (unlimited access while it lasts). */
async function openEscrowOf(wallet: string, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.escrows.id })
    .from(schema.escrows)
    .where(and(eq(schema.escrows.buyerWallet, wallet), eq(schema.escrows.agentId, agentId), inArray(schema.escrows.status, [...OPEN_ESCROW_STATUSES])))
    // More than one open: the newest (stable result, independent of the database order).
    .orderBy(desc(schema.escrows.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export async function escrowIsOpen(escrowId: string): Promise<boolean> {
  const [row] = await db.select({ status: schema.escrows.status }).from(schema.escrows).where(eq(schema.escrows.id, escrowId));
  // Escrow status is derived on-chain (D19): approved/refunded are terminal, nothing else closes a task.
  return !!row && escrowGivesAccess({ status: row.status, closed: false });
}

/** Paid access without consuming anything (lifetime license > open guarantee); "unknown" when the license could not be confirmed. */
async function paidAccessState(wallet: string, agent: AgentRow): Promise<PaidAccess | null | "unknown"> {
  const lic = await licenseCheck(wallet, agent);
  if (lic.state === "owned") return { kind: "license", licenseId: lic.id };
  const escrowId = await openEscrowOf(wallet, agent.id);
  if (escrowId) return { kind: "guarantee", escrowId };
  return lic.state === "unknown" ? "unknown" : null;
}

/** Paid access without consuming anything: lifetime license > open guaranteed task. */
export async function paidAccess(wallet: string, agent: AgentRow): Promise<PaidAccess | null> {
  const s = await paidAccessState(wallet, agent);
  return s === "unknown" ? null : s;
}

export async function paidAccessById(wallet: string, agentId: string): Promise<PaidAccess | null> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  return agent ? paidAccess(wallet, agent) : null;
}

/**
 * Is the paid session still valid? License transferred away or guarantee finished: no (the session is dropped and the
 * activation follows the normal flow). Trial sessions are always valid here.
 */
export async function sessionGrantValid(s: typeof schema.sessions.$inferSelect): Promise<boolean> {
  // Platform Solver: the right is the server's own list (nothing to re-check on-chain).
  if (s.access === "platform") return isPlatformAgent(s.agentId);
  if (s.access === "license") {
    if (!s.licenseId) return false;
    const [lic] = await db.select({ owner: schema.licenses.ownerWallet }).from(schema.licenses).where(eq(schema.licenses.id, s.licenseId));
    const owner = await refreshLicenseOwner(s.licenseId).catch(() => lic?.owner ?? null);
    return owner === s.wallet;
  }
  if (s.access === "guarantee") {
    const escrowId = (s.context as { escrowId?: unknown }).escrowId;
    return typeof escrowId === "string" && (await escrowIsOpen(escrowId));
  }
  return s.access === "trial";
}

/**
 * Decides how the wallet accesses the Solver in this activation: platform Solver (free for any signed-in wallet, no
 * license nor trial) > lifetime license > open guaranteed task > free trial (when the Solver has one; uses per wallet
 * counted off-chain).
 */
export async function resolveAccess(
  wallet: string,
  agent: AgentRow,
  pkg: SolverPackage,
  /** `allowTrial: false` (retired Solver): only paid access counts, never the free trial. */
  /** `agent: true` (token of a direct SIWE agent login): never a free trial (a new wallet costs nothing and would always drain it). */
  opts: { consume: boolean; allowTrial?: boolean; agent?: boolean },
): Promise<Access> {
  // PLATFORM_AGENTS is the authority (not the manifest field). No RPC, no license and no trial consumed.
  if (isPlatformAgentRow(agent)) return { ok: true, kind: "platform" };
  const paid = await paidAccessState(wallet, agent);
  if (paid && paid !== "unknown") return { ok: true, ...paid };
  const blocked = blockBeforeTrial({ licenseUnknown: paid === "unknown", allowTrial: opts.allowTrial !== false, agent: opts.agent === true });
  if (blocked) return { ok: false, reason: blocked, trial: null };

  const trial = trialLimits(pkg.manifest);
  if (!trial) return { ok: false, reason: "no_trial", trial: null };
  const [row] = await db
    .select()
    .from(schema.trials)
    .where(and(eq(schema.trials.agentId, agent.id), eq(schema.trials.wallet, wallet)));
  const used = row?.used ?? 0;
  if (used >= trial.uses) return { ok: false, reason: "trial_exhausted", trial };
  if (!opts.consume) return { ok: true, kind: "trial", trial, used, remaining: trial.uses - used, usage: usageOf(row) };
  // Atomic capped increment, so two concurrent activations never pass the limit.
  const [updated] = await db
    .insert(schema.trials)
    .values({ agentId: agent.id, wallet, used: 1 })
    .onConflictDoUpdate({
      target: [schema.trials.agentId, schema.trials.wallet],
      set: { used: sql`${schema.trials.used} + 1`, updatedAt: new Date() },
      setWhere: sql`${schema.trials.used} < ${trial.uses}`,
    })
    .returning();
  if (!updated) return { ok: false, reason: "trial_exhausted", trial };
  return { ok: true, kind: "trial", trial, used: updated.used, remaining: trial.uses - updated.used, usage: usageOf(updated) };
}

function usageOf(row: typeof schema.trials.$inferSelect | undefined): TrialUsage {
  return { searchesUsed: row?.searchesUsed ?? 0, toolRuns: row?.toolRuns ?? {} };
}

/** What the wallet already spent of this Solver's trial. */
export async function trialUsage(wallet: string, agentId: string): Promise<{ used: number; usage: TrialUsage }> {
  const [row] = await db
    .select()
    .from(schema.trials)
    .where(and(eq(schema.trials.agentId, agentId), eq(schema.trials.wallet, wallet)));
  return { used: row?.used ?? 0, usage: usageOf(row) };
}

const trialKey = (wallet: string, agentId: string) => and(eq(schema.trials.agentId, agentId), eq(schema.trials.wallet, wallet));

/** Consumes 1 trial knowledge search (atomic, capped). false: no searches left. */
export async function consumeTrialSearch(wallet: string, agentId: string, limit: number): Promise<boolean> {
  const rows = await db
    .update(schema.trials)
    .set({ searchesUsed: sql`${schema.trials.searchesUsed} + 1`, updatedAt: new Date() })
    .where(and(trialKey(wallet, agentId), sql`${schema.trials.searchesUsed} < ${limit}`))
    .returning({ n: schema.trials.searchesUsed });
  return rows.length > 0;
}

const runsOf = (tool: string) => sql`coalesce((${schema.trials.toolRuns} ->> ${tool})::int, 0)`;

/** Consumes 1 trial tool run (atomic, capped). false: limit reached. */
export async function consumeTrialTool(wallet: string, agentId: string, tool: string, limit: number): Promise<boolean> {
  const rows = await db
    .update(schema.trials)
    .set({
      toolRuns: sql`jsonb_set(${schema.trials.toolRuns}, array[${tool}]::text[], to_jsonb(${runsOf(tool)} + 1))`,
      updatedAt: new Date(),
    })
    .where(and(trialKey(wallet, agentId), sql`${runsOf(tool)} < ${limit}`))
    .returning({ agentId: schema.trials.agentId });
  return rows.length > 0;
}

/** Gives the run back when the tool refused the input (the AI fixes it and retries without losing the use). */
export async function refundTrialTool(wallet: string, agentId: string, tool: string): Promise<void> {
  await db
    .update(schema.trials)
    .set({ toolRuns: sql`jsonb_set(${schema.trials.toolRuns}, array[${tool}]::text[], to_jsonb(${runsOf(tool)} - 1))` })
    .where(and(trialKey(wallet, agentId), sql`${runsOf(tool)} > 0`));
}

/** How many licenses are re-checked on-chain per list_my_solvers call (bounds the RPC load). */
const OWNED_REFRESH_LIMIT = 20;

/**
 * Solvers the wallet holds a license of, re-checking the owner on-chain (a transferred license leaves the list).
 * RPC error: the mirror counts (a license is never hidden because of a network failure).
 */
export async function ownedLicensedAgents(wallet: string): Promise<Set<string>> {
  const lic = await db
    .select({ id: schema.licenses.id, agentId: schema.licenses.agentId })
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.burned, false)))
    .limit(OWNED_REFRESH_LIMIT);
  const checked = await Promise.all(lic.map(async (l) => ((await refreshLicenseOwner(l.id).catch(() => wallet)) === wallet ? l.agentId : null)));
  return new Set(checked.filter((a): a is string => a !== null));
}

/**
 * Solvers the wallet can use without buying (database only, no RPC): its licenses and the free platform Solvers, which
 * any signed-in wallet can use.
 */
export async function ownedAgents(wallet: string): Promise<Set<string>> {
  const lic = await db
    .select({ agentId: schema.licenses.agentId })
    .from(schema.licenses)
    .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.burned, false)));
  return new Set([...lic.map((l) => l.agentId), ...PLATFORM_AGENT_IDS]);
}
