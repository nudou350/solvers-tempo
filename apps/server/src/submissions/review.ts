import { existsSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AdminReviewInput } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { deleteKnowledgeVersion } from "../knowledge/ingest.js";
import { HttpError } from "../lib/http.js";
import { packageHashOf } from "../review/hash.js";
import { packageFromFolder } from "../runtime/validate/input.js";
import { minPriceUnits, ownershipConflict } from "./lookup.js";
import { creatorMessage, notifyCreatorWallet } from "./notify.js";
import { extractedDirOf, stagingVersion } from "./paths.js";
import { planApproval, reviewTransitionProblem, REVIEW_TRANSITIONS, versionGreater, type Approved } from "./rules.js";

// Reviewer decisions on a submission in `pending_review` (PACKAGE_SPEC.md 14.4 and 15.3). Every action respects
// `canTransition`, is conditional on the current state (two simultaneous decisions do not both go through) and leaves a row
// in `package_reviews`, which is insert-only (database trigger). Approving on the site does NOT sign anything on-chain.

type Row = typeof schema.packageSubmissions.$inferSelect;

export type ReviewCtx = {
  id: string;
  reviewerWallet: string;
  ip: string | undefined;
  input: AdminReviewInput;
};

export type ReviewDeps = {
  minPriceUnits: () => Promise<bigint>;
  notifyCreator: (wallet: string, text: string) => Promise<void>;
  deleteStaging: (agentId: string, version: string) => Promise<number>;
  /** Tests only: tracks the order of the approval's writes. */
  trace?: (step: "published_version" | "submission" | "review") => void;
};

export const defaultReviewDeps: ReviewDeps = { minPriceUnits, notifyCreator: notifyCreatorWallet, deleteStaging: deleteKnowledgeVersion };

const subjectOf = (r: Row) => ({ id: r.id, slug: r.slug, version: r.version, creatorWallet: r.creatorWallet, name: (r.manifest?.name as string | undefined) ?? null });

async function load(id: string): Promise<Row> {
  const [row] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id));
  if (!row) throw new HttpError(404, "Submission not found.", "not_found");
  return row;
}

/** Locks the row and checks the state is still the expected one (another decision may have arrived first). */
async function lockPending(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string): Promise<Row> {
  await tx.execute(sql`select id from package_submissions where id = ${id} for update`);
  const [row] = await tx.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id));
  if (!row) throw new HttpError(404, "Submission not found.", "not_found");
  return row;
}

/**
 * Approves: freezes hash, price, royalty, name and version in `package_submissions.approved` and moves to
 * `awaiting_creator_signature`. The approved version goes into `agent_published_versions` BEFORE any other write:
 * `/tx/submit` indexes the creator's transaction right away, and the indexer would compare the chain with a row that did not exist yet.
 */
export async function approveSubmission(ctx: ReviewCtx, deps: ReviewDeps = defaultReviewDeps): Promise<{ id: string; status: "awaiting_creator_signature"; approved: Approved }> {
  const row = await load(ctx.id);
  // Separation of duties: whoever submitted the package cannot approve it (not even as an admin).
  if (ctx.reviewerWallet === row.creatorWallet) throw new HttpError(403, "You can't approve your own submission: another administrator has to review it.", "self_review");
  const bad = reviewTransitionProblem(row.status, "approve");
  if (bad) throw new HttpError(409, bad, "invalid_state");
  const dir = extractedDirOf(ctx.id);
  if (!existsSync(dir)) throw new HttpError(409, "The extracted files for this submission no longer exist on the server.", "files_missing");

  // The hash is computed HERE, over the folder the reviewer saw: it is the `versionHash` that goes on-chain.
  const versionHash = packageHashOf(packageFromFolder(dir));
  const plan = planApproval({ status: row.status, validation: row.validation, manifest: row.manifest, checklist: ctx.input.checklist, versionHash, minPriceUnits: await deps.minPriceUnits() });
  if (!plan.ok) throw new HttpError(plan.status, plan.message, plan.code);

  await db.transaction(async (tx) => {
    const fresh = await lockPending(tx, ctx.id);
    const problem = reviewTransitionProblem(fresh.status, "approve");
    if (problem) throw new HttpError(409, problem, "invalid_state");

    // Redoes the submission checks inside the transaction (the world changed since validation): two approvals of the same slug
    // are serialized by the lock, and each one sees what the other wrote.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slug:${fresh.slug}`}, 0))`);
    // The version must be GREATER than the catalog's: equal would overwrite the hash of a live version; lower would be a downgrade.
    const [live] = await tx.select({ version: schema.agents.version }).from(schema.agents).where(eq(schema.agents.id, fresh.agentId));
    if (live && !versionGreater(plan.approved.version, live.version)) {
      throw new HttpError(409, `Version ${plan.approved.version} is not greater than the already published ${live.version}. Ask the creator to bump the version.`, "version_already_published");
    }
    // Owner of the slug and id: the catalog, the platform and other approved submissions count as of now, not as of the upload.
    const conflict = await ownershipConflict({ submissionId: fresh.id, wallet: fresh.creatorWallet, agentId: fresh.agentId, slug: fresh.slug });
    if (conflict) throw new HttpError(409, conflict, "ownership_conflict");

    // 1) approved version: before anything else.
    deps.trace?.("published_version");
    await tx
      .insert(schema.agentPublishedVersions)
      .values({ agentId: fresh.agentId, version: plan.approved.version, versionHash, priceUsdc: plan.priceUnits })
      .onConflictDoUpdate({
        target: [schema.agentPublishedVersions.agentId, schema.agentPublishedVersions.version],
        set: { versionHash, priceUsdc: plan.priceUnits, approvedAt: new Date(), approveTx: null },
      });
    // 2) submission: frozen data and new state.
    deps.trace?.("submission");
    await tx
      .update(schema.packageSubmissions)
      .set({ approved: plan.approved, status: REVIEW_TRANSITIONS.approve.to, reviewerNotes: ctx.input.notes, error: null, updatedAt: new Date() })
      .where(and(eq(schema.packageSubmissions.id, ctx.id), eq(schema.packageSubmissions.status, "pending_review")));
    // 3) audit trail (insert-only).
    deps.trace?.("review");
    await tx.insert(schema.packageReviews).values({
      submissionId: ctx.id,
      reviewerWallet: ctx.reviewerWallet,
      action: "approve",
      notes: ctx.input.notes,
      checklist: ctx.input.checklist,
      versionHash,
      diffSnapshot: ((row.scans as { diff?: Record<string, unknown> } | null)?.diff as Record<string, unknown> | undefined) ?? null,
      ip: ctx.ip ?? null,
    });
  });
  await deps.notifyCreator(row.creatorWallet, creatorMessage("approved", subjectOf(row)));
  return { id: ctx.id, status: "awaiting_creator_signature", approved: plan.approved };
}

async function decide(action: "request_changes" | "reject", ctx: ReviewCtx, deps: ReviewDeps): Promise<{ id: string; status: "changes_requested" | "rejected" }> {
  const row = await load(ctx.id);
  const to = REVIEW_TRANSITIONS[action].to;
  const bad = reviewTransitionProblem(row.status, action);
  if (bad) throw new HttpError(409, bad, "invalid_state");
  await db.transaction(async (tx) => {
    const fresh = await lockPending(tx, ctx.id);
    const problem = reviewTransitionProblem(fresh.status, action);
    if (problem) throw new HttpError(409, problem, "invalid_state");
    await tx
      .update(schema.packageSubmissions)
      .set({ status: to, reviewerNotes: ctx.input.notes, updatedAt: new Date() })
      .where(and(eq(schema.packageSubmissions.id, ctx.id), eq(schema.packageSubmissions.status, fresh.status)));
    await tx.insert(schema.packageReviews).values({
      submissionId: ctx.id,
      reviewerWallet: ctx.reviewerWallet,
      action,
      notes: ctx.input.notes,
      checklist: ctx.input.checklist,
      versionHash: null,
      diffSnapshot: null,
      ip: ctx.ip ?? null,
    });
  });
  // Final rejection: the test knowledge is of no use to anyone anymore.
  if (to === "rejected") await deps.deleteStaging(row.agentId, stagingVersion(ctx.id)).catch((e) => console.warn("[submissions] staging cleanup failed:", (e as Error).message));
  await deps.notifyCreator(row.creatorWallet, creatorMessage(to === "rejected" ? "rejected" : "changes_requested", subjectOf(row), ctx.input.notes));
  return { id: ctx.id, status: to };
}

export const requestChanges = (ctx: ReviewCtx, deps: ReviewDeps = defaultReviewDeps) => decide("request_changes", ctx, deps) as Promise<{ id: string; status: "changes_requested" }>;
export const rejectSubmission = (ctx: ReviewCtx, deps: ReviewDeps = defaultReviewDeps) => decide("reject", ctx, deps) as Promise<{ id: string; status: "rejected" }>;

/**
 * Revokes an approval the creator has not signed yet (`awaiting_creator_signature` -> `changes_requested`): clears the
 * approved record, removes the approved version from `agent_published_versions` (nothing on-chain backs it) and leaves a
 * `revoke` row in `package_reviews`. The creator fixes it and resubmits through the same submission.
 */
export async function revokeApproval(ctx: ReviewCtx, deps: ReviewDeps = defaultReviewDeps): Promise<{ id: string; status: "changes_requested" }> {
  const row = await load(ctx.id);
  const bad = reviewTransitionProblem(row.status, "revoke");
  if (bad) throw new HttpError(409, bad, "invalid_state");
  await db.transaction(async (tx) => {
    const fresh = await lockPending(tx, ctx.id);
    const problem = reviewTransitionProblem(fresh.status, "revoke");
    if (problem) throw new HttpError(409, problem, "invalid_state");
    const approved = fresh.approved;
    await tx
      .update(schema.packageSubmissions)
      .set({ status: REVIEW_TRANSITIONS.revoke.to, approved: null, reviewerNotes: ctx.input.notes, error: null, updatedAt: new Date() })
      .where(and(eq(schema.packageSubmissions.id, ctx.id), eq(schema.packageSubmissions.status, "awaiting_creator_signature")));
    if (approved?.version) {
      await tx
        .delete(schema.agentPublishedVersions)
        .where(and(eq(schema.agentPublishedVersions.agentId, fresh.agentId), eq(schema.agentPublishedVersions.version, approved.version), isNull(schema.agentPublishedVersions.approveTx)));
    }
    await tx.insert(schema.packageReviews).values({
      submissionId: ctx.id,
      reviewerWallet: ctx.reviewerWallet,
      action: "revoke",
      notes: ctx.input.notes,
      checklist: ctx.input.checklist,
      versionHash: approved?.versionHash ?? null,
      diffSnapshot: null,
      ip: ctx.ip ?? null,
    });
  });
  await deps.notifyCreator(row.creatorWallet, creatorMessage("changes_requested", subjectOf(row), ctx.input.notes));
  return { id: ctx.id, status: "changes_requested" };
}
