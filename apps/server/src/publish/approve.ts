import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { FINALIZABLE_STATUSES, nextPublicationStep, parseApproved, type PublicationStep } from "./approval-rules.js";
import { publishChain, type PublishChain } from "./chain-port.js";
import { finalizePublication, type FinalizeDeps, type FinalizeResult } from "./finalize.js";

// The admin's on-chain approval (PACKAGE_SPEC.md 15.2 and 15.3, steps 4 and 5): new Solvers only. `approveAgent` needs
// the Registry's default admin, a cold key kept off the VPS: "Approve" on the site only releases the submission, and
// this command (`cli:approve <slug|submissionId>`) signs `approveAgent` through the admin nonce lane with the fee
// sponsored by RELAY (D20), then triggers the finalization.

type SubmissionRow = typeof schema.packageSubmissions.$inferSelect;

export class ApproveError extends Error {}

/** Resolves `<slug|submissionId>` to the submission waiting for the chain (the latest one, for a slug). */
export async function resolveSubmission(ref: string): Promise<SubmissionRow> {
  const t = schema.packageSubmissions;
  const [byId] = await db.select().from(t).where(eq(t.id, ref));
  if (byId) return byId;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.slug, ref), inArray(t.status, [...FINALIZABLE_STATUSES])))
    .orderBy(desc(t.createdAt));
  if (rows.length === 0) throw new ApproveError(`no submission waiting for publication for "${ref}" (use the slug or the submission id)`);
  if (rows.length > 1) {
    throw new ApproveError(`"${ref}" has ${rows.length} submissions in progress (${rows.map((r) => `${r.id} v${r.version} ${r.status}`).join("; ")}). Pass the submission id.`);
  }
  return rows[0]!;
}

export type ApproveResult = {
  submissionId: string;
  slug: string;
  version: string;
  /** What is missing (the chain does not match the approved record yet), or the step that was handled. */
  step: PublicationStep;
  /** approveAgent tx hash (null: already approved on-chain, or dry-run). */
  approveTx: string | null;
  dryRun: boolean;
  finalize: FinalizeResult | null;
};

/**
 * Signs `approveAgent` for the submission's new Solver and finalizes the publication. Refuses when the chain does not
 * match the approved version (never approves what the review did not see) or when the local key is not the Registry's
 * default admin.
 */
export async function approveOnChain(
  ref: string,
  opts: { port?: PublishChain; dryRun?: boolean; deps?: Partial<FinalizeDeps> } = {},
): Promise<ApproveResult> {
  const port = opts.port ?? publishChain();
  const sub = await resolveSubmission(ref);
  const approved = parseApproved(sub.approved);
  if (!approved) throw new ApproveError(`submission ${sub.id} has no version approved by the review`);
  if (!FINALIZABLE_STATUSES.includes(sub.status as (typeof FINALIZABLE_STATUSES)[number])) {
    throw new ApproveError(`submission ${sub.id} is "${sub.status}"; only submissions waiting for publication are approved on-chain`);
  }
  const base = { submissionId: sub.id, slug: sub.slug, version: approved.version, dryRun: opts.dryRun === true };
  const step = nextPublicationStep(approved, await port.fetchAgentState(sub.agentId));

  if (step === "ready") {
    // Already Active on-chain (approved before, some other way): only the finalization is missing.
    if (opts.dryRun) return { ...base, step, approveTx: null, finalize: null };
    const actor = (await port.adminAddress()) ?? undefined;
    return { ...base, step, approveTx: null, finalize: await finalizePublication(sub.id, { actor, deps: { port, ...opts.deps } }) };
  }
  if (step !== "await-admin-approval") {
    throw new ApproveError(`the chain does not match the approved version yet (missing: ${step}). The creator must finish signing on the site first.`);
  }

  const admin = await port.adminAddress();
  if (!admin) throw new ApproveError("no admin key loaded: approveAgent needs the Registry's default admin (--key-file, or ADMIN_PRIVATE_KEY off mainnet)");
  const onchain = await port.onchainAdmin();
  if (onchain.toLowerCase() !== admin.toLowerCase()) throw new ApproveError(`the local key (${admin}) is not the on-chain admin (${onchain})`);
  if (opts.dryRun) return { ...base, step, approveTx: null, finalize: null };

  const approveTx = (await port.approveAgent(sub.agentId)).toLowerCase();
  const t = schema.packageSubmissions;
  await db.update(t).set({ approveTx, updatedAt: new Date() }).where(and(eq(t.id, sub.id), isNull(t.approveTx)));
  const v = schema.agentPublishedVersions;
  await db.update(v).set({ approveTx }).where(and(eq(v.agentId, sub.agentId), eq(v.version, approved.version), isNull(v.approveTx)));
  // Mirror the new status (Active) right away; the indexer's AgentStatusChanged does the same and is idempotent.
  await port.indexTx(approveTx).catch(() => undefined);
  return { ...base, step, approveTx, finalize: await finalizePublication(sub.id, { actor: admin, deps: { port, ...opts.deps } }) };
}
