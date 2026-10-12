import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { AGENT_STATUS, bytes32ToAgentId } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { onChainEvent } from "../indexer/index.js";
import { every, type Job } from "../lib/jobs.js";
import { isPublicationTouch, parseApproved, type ApprovedRecord } from "./approval-rules.js";
import { publishChain } from "./chain-port.js";
import { finalizePublication, type FinalizeDeps, type FinalizeResult } from "./finalize.js";

// Links what the chain says to the submission (PACKAGE_SPEC.md 15.3). Three entries, the same idempotent logic:
//  - the explicit confirmation from the site (POST /tx/publication/confirm, by tx hash), which answers with the new state;
//  - a Registry event seen by the indexer (`onPublishEvent`: AgentRegistered, AgentVersionUpdated, PricingUpdated,
//    AgentStatusChanged), which is what finalizes when the admin approves from another machine;
//  - the `publish: reconcile` job, a safety net that re-reads the chain for every submission still waiting.
// All of them record the tx hash (`register_tx` / `approve_tx`) and let finalization decide what is missing by reading
// the chain.

/** Submissions waiting for the chain (the creator to sign or the admin to approve): an event can unlock these. */
const WAITING = ["awaiting_creator_signature", "awaiting_onchain_approval"] as const;

export type ChainTouch = {
  /** Hash of the transaction that changed the agent on-chain. */
  txHash?: string;
  /** What the transaction was. `status_active` is the admin's approveAgent. */
  kind?: "registered" | "version" | "pricing" | "status_active";
  /** The transaction's Registry events were already checked against the approved record (`checkCreatorTx`). */
  verified?: boolean;
  /** Version and hash the event carries (AgentRegistered / AgentVersionUpdated seen by the indexer). */
  version?: string;
  versionHash?: string;
};

export type ReconcileResult = { submissionId: string | null; result: FinalizeResult | null };

export async function reconcileAgent(agentId: string, touch: ChainTouch = {}, deps?: Partial<FinalizeDeps>): Promise<ReconcileResult> {
  const [sub] = await db
    .select()
    .from(schema.packageSubmissions)
    .where(and(eq(schema.packageSubmissions.agentId, agentId), inArray(schema.packageSubmissions.status, [...WAITING])))
    .orderBy(desc(schema.packageSubmissions.createdAt))
    .limit(1);
  if (!sub) return { submissionId: null, result: null };
  // The approveAgent hash only counts as `approve_tx` if the agent really is Active (an early event, with a lagging RPC, does not).
  if (touch.kind === "status_active" && touch.txHash) {
    const state = await (deps?.port ?? publishChain()).fetchAgentState(agentId).catch(() => null);
    if (!state?.exists || state.status !== "active") touch = { ...touch, txHash: undefined };
  }
  await recordTx(sub.id, parseApproved(sub.approved), sub.agentId, touch);
  return { submissionId: sub.id, result: await finalizePublication(sub.id, { deps }) };
}

/**
 * register_tx: the creator's registration or version update matching the approved record (`isPublicationTouch`);
 * approve_tx: the admin's approveAgent. Fills only empty columns.
 */
async function recordTx(submissionId: string, approved: ApprovedRecord | null, agentId: string, touch: ChainTouch): Promise<void> {
  if (!touch.txHash) return;
  const hash = touch.txHash.toLowerCase();
  const t = schema.packageSubmissions;
  const version = approved?.version ?? null;
  if (touch.kind === "status_active") {
    await db.update(t).set({ approveTx: hash, updatedAt: new Date() }).where(and(eq(t.id, submissionId), isNull(t.approveTx)));
    if (version) {
      const v = schema.agentPublishedVersions;
      await db.update(v).set({ approveTx: hash }).where(and(eq(v.agentId, agentId), eq(v.version, version), isNull(v.approveTx)));
    }
    return;
  }
  // The registration/update is "the" publication transaction: written only when empty (a later hash, from another
  // transaction, never replaces the one already linked to the submission).
  if (!isPublicationTouch(touch, approved)) return;
  await db.update(t).set({ registerTx: hash, updatedAt: new Date() }).where(and(eq(t.id, submissionId), isNull(t.registerTx)));
}

/** A Registry event as the indexer decodes it (`agentId` as bytes32 or as the 32-hex package id). */
export type PublishChainEvent = { name: string; agentId: string; status?: number; version?: string; versionHash?: string };

const TOUCH_KIND: Record<string, ChainTouch["kind"]> = {
  AgentRegistered: "registered",
  AgentVersionUpdated: "version",
  PricingUpdated: "pricing",
  AgentStatusChanged: "status_active",
};

function packageId(agentId: string): string | null {
  const s = agentId.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(s)) return s;
  try {
    return bytes32ToAgentId(s);
  } catch {
    return null;
  }
}

/**
 * Reaction to an indexer event (registered through `onChainEvent` by `registerPublishListeners`); exported for the tests. Returns null when the event cannot unlock anything.
 */
export async function onPublishEvent(ev: PublishChainEvent, txHash: string, deps?: Partial<FinalizeDeps>): Promise<ReconcileResult | null> {
  const kind = TOUCH_KIND[ev.name];
  if (!kind) return null;
  // A status change that is not "became Active" (suspend, retire) unlocks nothing.
  if (ev.name === "AgentStatusChanged" && ev.status !== AGENT_STATUS.Active) return null;
  const id = packageId(ev.agentId);
  if (!id) return null;
  const r = await reconcileAgent(id, { txHash, kind, ...(ev.version !== undefined ? { version: ev.version } : {}), ...(ev.versionHash !== undefined ? { versionHash: ev.versionHash } : {}) }, deps);
  return r.submissionId ? r : null;
}

/**
 * Safety net: re-reads the chain for every submission waiting for it (oldest first) and finalizes the ones that are
 * ready. Covers an approval signed elsewhere when the event was missed. Returns how many were published.
 */
export async function reconcileWaitingPublications(limit = 20, deps?: Partial<FinalizeDeps>): Promise<number> {
  const rows = await db
    .select({ id: schema.packageSubmissions.id })
    .from(schema.packageSubmissions)
    .where(inArray(schema.packageSubmissions.status, [...WAITING, "publishing"]))
    .orderBy(asc(schema.packageSubmissions.updatedAt))
    .limit(limit);
  let published = 0;
  for (const r of rows) {
    const out = await finalizePublication(r.id, { deps }).catch((e) => {
      console.warn(`[publish] reconcile of ${r.id} failed: ${(e as Error).message}`);
      return null;
    });
    if (out?.outcome === "published") published++;
  }
  return published;
}

let registered = false;

/** Listens to the indexer's Registry events (idempotent; called when the publish routes are mounted, i.e. in the API only). */
export function registerPublishListeners(): void {
  if (registered) return;
  registered = true;
  onChainEvent(async (ev, txHash) => {
    if (ev.contract !== "registry" || !(ev.eventName in TOUCH_KIND)) return;
    const args = ev.args as { agentId?: string; status?: number; version?: string; versionHash?: string };
    if (!args.agentId) return;
    await onPublishEvent(
      {
        name: ev.eventName,
        agentId: args.agentId,
        status: args.status === undefined ? undefined : Number(args.status),
        ...(typeof args.version === "string" ? { version: args.version } : {}),
        ...(typeof args.versionHash === "string" ? { versionHash: args.versionHash } : {}),
      },
      txHash,
    );
  });
}

/** Jobs of this area (the API schedules them; never the worker). */
export const publishJobs: Job[] = [every(60_000, "publish: reconcile", () => reconcileWaitingPublications())];
