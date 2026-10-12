import { and, desc, eq, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isPlatformAgentRow } from "../runtime/platform-agents.js";
import { publishChain, type PublishChain } from "./chain-port.js";

// The admin kill switch (PACKAGE_SPEC.md 15.4): `cli:suspend <slug>` and `cli:suspend <slug> --resume`.
//  1. `agents.platform_status` (a column the indexer NEVER writes): cuts open sessions, the store and sales at once
//     (`getSession` and the rest check the column on every call).
//  2. `suspendAgent` on-chain with the admin key (through the admin nonce lane, fee sponsored by RELAY): without it a
//     direct purchase through the contract (`purchaseLicense`, which only requires Active) would still be possible.
//  3. Audit: a `suspend`/`resume` row in `package_reviews` (insert-only) and the submission `published` <-> `suspended`.
// The order is fail-safe: the database (immediate effect) first when suspending; the chain first when resuming. Running
// it again after a chain failure completes what was missing without duplicating the audit trail.

export class SuspendError extends Error {}

type AgentRow = typeof schema.agents.$inferSelect;

export type SuspendResult = {
  agentId: string;
  slug: string;
  action: "suspend" | "resume";
  /** The database changed (platform_status). */
  platformChanged: boolean;
  /** suspendAgent/approveAgent tx hash (null: nothing to do on-chain, or a database-only Solver). */
  chainTx: string | null;
  submissionId: string | null;
};

export async function findAgentByRef(ref: string): Promise<AgentRow> {
  const [row] = await db
    .select()
    .from(schema.agents)
    .where(or(eq(schema.agents.slug, ref), eq(schema.agents.id, ref)));
  if (!row) throw new SuspendError(`Solver "${ref}" not found (use the slug or the id)`);
  return row;
}

/** Submission that reflects the live Solver: the latest `published` (when suspending) or `suspended` (when resuming). */
async function currentSubmission(agentId: string, status: "published" | "suspended") {
  const t = schema.packageSubmissions;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.agentId, agentId), eq(t.status, status)))
    .orderBy(desc(t.createdAt))
    .limit(1);
  return row ?? null;
}

export async function suspendSolver(
  ref: string,
  opts: { resume?: boolean; reason?: string; port?: PublishChain } = {},
): Promise<SuspendResult> {
  const port = opts.port ?? publishChain();
  const agent = await findAgentByRef(ref);
  const resume = opts.resume === true;
  const reason = opts.reason?.trim() || (resume ? "Resumed by the admin" : "Suspended by the admin");
  // Platform Solvers (no on-chain agent) only have the database side and need no key.
  const hasChain = !isPlatformAgentRow(agent);
  const actor = (hasChain ? await port.adminAddress() : null) ?? "cli";
  const result: SuspendResult = { agentId: agent.id, slug: agent.slug, action: resume ? "resume" : "suspend", platformChanged: false, chainTx: null, submissionId: null };

  if (resume) {
    // Chain first: the Solver only sells again with the agent Active and the platform column active.
    if (hasChain) result.chainTx = await onchain(port, agent.id, "resume");
    await markPlatform(agent, "active", result, { from: "suspended", to: "published", action: "resume", reason, actor });
    return result;
  }
  // Database first: the effect is immediate (sessions and sales drop now), even if the chain fails.
  await markPlatform(agent, "suspended", result, { from: "published", to: "suspended", action: "suspend", reason, actor });
  if (hasChain) {
    try {
      result.chainTx = await onchain(port, agent.id, "suspend");
    } catch (e) {
      throw new SuspendError(
        `suspended on the platform (sessions and sales already dropped), BUT the on-chain suspendAgent failed: ${(e as Error).message}. Run it again: a direct purchase through the contract remains possible until the agent is suspended on-chain.`,
      );
    }
  }
  return result;
}

/** suspendAgent / approveAgent (resume) only when the agent is not already in the requested state; then mirrors and indexes. */
async function onchain(port: PublishChain, agentId: string, action: "suspend" | "resume"): Promise<string | null> {
  const state = await port.fetchAgentState(agentId);
  if (!state.exists) return null;
  const wanted = action === "suspend" ? state.status !== "suspended" && state.status !== "retired" : state.status === "suspended";
  if (!wanted) return null;
  const hash = action === "suspend" ? await port.suspendAgent(agentId) : await port.approveAgent(agentId);
  await port.syncAgent(agentId).catch(() => undefined);
  await port.indexTx(hash).catch(() => undefined);
  return hash.toLowerCase();
}

async function markPlatform(
  agent: AgentRow,
  to: "active" | "suspended",
  result: SuspendResult,
  audit: { from: "published" | "suspended"; to: "published" | "suspended"; action: "suspend" | "resume"; reason: string; actor: string },
): Promise<void> {
  const changed = agent.platformStatus !== to;
  result.platformChanged = changed;
  if (!changed) return; // already like this (retry after a chain failure): no duplicate audit row
  const sub = await currentSubmission(agent.id, audit.from);
  result.submissionId = sub?.id ?? null;
  await db.transaction(async (tx) => {
    await tx.update(schema.agents).set({ platformStatus: to, updatedAt: new Date() }).where(eq(schema.agents.id, agent.id));
    if (sub) {
      await tx
        .update(schema.packageSubmissions)
        .set({ status: audit.to, updatedAt: new Date() })
        .where(and(eq(schema.packageSubmissions.id, sub.id), eq(schema.packageSubmissions.status, audit.from)));
    }
    await tx.insert(schema.packageReviews).values({
      // Solver without a submission (platform package published by the CLI): the trail goes under the agent id.
      submissionId: sub?.id ?? `agent:${agent.id}`,
      reviewerWallet: audit.actor,
      action: audit.action,
      notes: audit.reason,
      versionHash: agent.versionHash,
    });
  });
}
