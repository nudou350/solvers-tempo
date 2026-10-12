import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { canTransition, type SubmissionStatus } from "@solvers/shared";
import { db, pool, schema } from "../db/index.js";
import { env } from "../env.js";
import { deleteKnowledgeVersion, renameKnowledgeVersion } from "../knowledge/ingest.js";
import { notifyCreator, sendTelegram } from "../notify/telegram.js";
import { loadPackage, packageHash, reloadPackages, type SolverPackage } from "../runtime/packages.js";
import { FINALIZABLE_STATUSES, nextPublicationStep, parseApproved, statusAfterChain, type ApprovedRecord, type PublicationStep } from "./approval-rules.js";
import { prepareCatalog, relist, writeCatalog, type PreparedCatalog } from "./catalog.js";
import { publishChain, type PublishChain } from "./chain-port.js";
import { cleanIncoming, findPackageRoot, incomingParent, publishedIdentityOf, publishedVersionOf, stagePackage, swapInPublished } from "./fs.js";
import { versionGreater } from "../submissions/rules.js";

// Publication finalization (PACKAGE_SPEC.md 15.3, step 5): the approved version becomes the one served. Idempotent and
// resumable: each step checks what was already done, and a failure leaves the submission in `publish_failed` for the
// admin to retry (POST /admin/submissions/:id/finish). The store does NOT change before the last step: the catalog is
// written in a single transaction at the end, after the disk and the knowledge base.

export type FinalizeDeps = {
  port: PublishChain;
  /** Published packages folder and submissions folder (resolved; the tests point them to a temporary folder). */
  publishedDir: string;
  submissionsDir: string;
  renameKnowledge: (agentId: string, from: string, to: string) => Promise<number>;
  deleteKnowledge: (agentId: string, version: string) => Promise<number>;
  prepare: (pkg: SolverPackage) => Promise<PreparedCatalog>;
  /** Reloads the runtime package cache (`reloadPackages`). */
  reload: () => void;
  notifyAdmin: (text: string) => Promise<unknown>;
  notifyCreator: (agentId: string, text: string) => Promise<unknown>;
};

export function defaultFinalizeDeps(): FinalizeDeps {
  return {
    port: publishChain(),
    publishedDir: resolve(process.cwd(), env.PUBLISHED_DIR),
    submissionsDir: resolve(process.cwd(), env.SUBMISSIONS_DIR),
    renameKnowledge: renameKnowledgeVersion,
    deleteKnowledge: deleteKnowledgeVersion,
    prepare: prepareCatalog,
    reload: () => void reloadPackages(),
    notifyAdmin: (text) => sendTelegram(env.TELEGRAM_ADMIN_CHAT_ID, text),
    notifyCreator,
  };
}

export type FinalizeResult =
  | { outcome: "published"; version: string }
  | { outcome: "already_published" }
  /** Another process is finalizing this submission (event + button + CLI at the same time): nothing to do. */
  | { outcome: "busy" }
  /** Not yet: wrong state, chain behind the approved record, agent suspended. Nothing changed (except the state advance). */
  | { outcome: "not_ready"; status: SubmissionStatus; step?: PublicationStep; reason: string }
  | { outcome: "failed"; error: string };

type SubmissionRow = typeof schema.packageSubmissions.$inferSelect;

const short = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 500);

/** Check error with its own text (hash, id, slug, version): safe to show the creator. Any other error is internal. */
export class PublishCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishCheckError";
  }
}

/** What the creator sees (`error` column, API answers) when publication fails internally: the detail (paths, database) goes only to the log and the admin. */
export const PUBLISH_FAILED_TEXT = "Publishing failed because of an internal error. The team has been notified and will try again.";

/** State change conditioned on the state seen (and on `canTransition`): whoever lost the race does not overwrite. */
export async function moveSubmission(id: string, from: SubmissionStatus, to: SubmissionStatus, extra: Partial<SubmissionRow> = {}): Promise<boolean> {
  if (from !== to && !canTransition(from, to)) return false;
  const rows = await db
    .update(schema.packageSubmissions)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(and(eq(schema.packageSubmissions.id, id), eq(schema.packageSubmissions.status, from)))
    .returning({ id: schema.packageSubmissions.id });
  return rows.length > 0;
}

/**
 * Publishes the approved version. `actor` (admin wallet) becomes a `finish` row in `package_reviews` when finalization is
 * the admin's action (the "Finish" button, `cli:approve`); triggered by a chain event, nothing is recorded.
 */
export async function finalizePublication(submissionId: string, opts: { actor?: string; deps?: Partial<FinalizeDeps> } = {}): Promise<FinalizeResult> {
  const deps = { ...defaultFinalizeDeps(), ...opts.deps };
  // One finalization per submission: chain event, admin button and CLI can arrive together. The lock belongs to the
  // Postgres session (released by itself if the process dies).
  const client = await pool.connect();
  const key = `finalize:${submissionId}`;
  try {
    const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
    if (!got.rows[0]?.ok) return { outcome: "busy" };
    try {
      const result = await run(submissionId, opts.actor, deps);
      // Another process (the `cli:approve` CLI) may have published: the API reloads the cache from disk.
      if (result.outcome === "already_published" || result.outcome === "busy") deps.reload();
      return result;
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

async function run(id: string, actor: string | undefined, deps: FinalizeDeps): Promise<FinalizeResult> {
  const [sub] = await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id));
  if (!sub) return { outcome: "not_ready", status: "submitted", reason: "submission not found" };
  const status = sub.status as SubmissionStatus;
  if (status === "published") return { outcome: "already_published" };
  if (!FINALIZABLE_STATUSES.includes(status)) return { outcome: "not_ready", status, reason: `the submission is ${status}` };
  const approved = parseApproved(sub.approved);
  if (!approved) return { outcome: "not_ready", status, reason: "the submission has no approved version" };

  // Agent suspended by the platform: publishing a version must not lift the suspension by accident.
  const [existing] = await db.select({ platformStatus: schema.agents.platformStatus }).from(schema.agents).where(eq(schema.agents.id, sub.agentId));
  if (existing?.platformStatus === "suspended") return { outcome: "not_ready", status, reason: "the Solver is suspended: resume it (cli:suspend --resume) before publishing" };

  // The chain must match the approved record exactly and the agent must be Active (approved by the on-chain admin).
  let step: PublicationStep;
  try {
    step = nextPublicationStep(approved, await deps.port.fetchAgentState(sub.agentId));
  } catch (e) {
    return { outcome: "not_ready", status, reason: `could not read the chain: ${short(e)}` };
  }
  if (step !== "ready") {
    const next = statusAfterChain(status, step);
    if (next !== "finalize" && next !== status) {
      if (await moveSubmission(id, status, next)) {
        if (next === "awaiting_onchain_approval") {
          await deps.notifyAdmin(`Solvers: ${sub.slug} v${approved.version} is ready for the on-chain approval.\nRun: pnpm --filter @solvers/server cli:approve ${sub.slug}`).catch(() => undefined);
        }
        return { outcome: "not_ready", status: next, step, reason: `missing: ${step}` };
      }
    }
    return { outcome: "not_ready", status, step, reason: `missing: ${step}` };
  }

  // From here on it is "publishing": any failure becomes publish_failed and the admin retries.
  if (status !== "publishing") {
    if (!(await moveSubmission(id, status, "publishing", { error: null }))) return { outcome: "busy" };
  }
  try {
    const version = await publish(sub, approved, actor, deps);
    await deps.notifyCreator(sub.agentId, `Solvers: your Solver ${approved.name} v${version} is live.`).catch(() => undefined);
    return { outcome: "published", version };
  } catch (e) {
    const detail = short(e);
    console.error(`[publish] publishing ${sub.slug} v${approved.version} failed:`, e);
    // A check error has its own safe text; any other (disk, database) is internal: the creator sees a fixed text.
    const error = e instanceof PublishCheckError ? detail : PUBLISH_FAILED_TEXT;
    await moveSubmission(id, "publishing", "publish_failed", { error });
    await deps.notifyAdmin(`Solvers: publishing ${sub.slug} v${approved.version} failed: ${detail}\nRetry in /admin/reviews (Finish).`).catch(() => undefined);
    return { outcome: "failed", error };
  }
}

/** The steps with side effects. Throws on any failure (the caller marks publish_failed). Returns the published version. */
async function publish(sub: SubmissionRow, approved: ApprovedRecord, actor: string | undefined, deps: FinalizeDeps): Promise<string> {
  const id = sub.id;
  const target = join(deps.publishedDir, sub.slug);

  // 1. Disk: the published folder becomes the approved one (swap by rename; the previous goes to _archive/). Already there = skip.
  const alreadyThere = existsSync(join(target, "manifest.json")) && publishedVersionOf(target) === approved.version && packageHash(target) === approved.versionHash;
  if (!alreadyThere) {
    // Is the live folder of this slug this Solver's? And is the approved version not lower than the live one (no downgrades)?
    const current = existsSync(join(target, "manifest.json")) ? publishedIdentityOf(target) : null;
    if (current?.id && current.id !== sub.agentId) throw new PublishCheckError("the published folder for this slug belongs to another Solver; nothing was changed");
    if (current?.version && versionGreater(current.version, approved.version)) throw new PublishCheckError(`the approved version (${approved.version}) is lower than the published one (${current.version}); nothing was changed`);
    const root = findPackageRoot(join(deps.submissionsDir, id, "extracted"));
    const staged = stagePackage(root, incomingParent(deps.publishedDir, id), sub.slug);
    // Checked BEFORE touching the published folder: what goes live is byte for byte what the reviewer approved.
    checkPackage(loadPackage(staged, { source: "published" }), sub, approved);
    swapInPublished(deps.publishedDir, sub.slug, staged, sub.agentId);
  }
  const pkg = loadPackage(target, { source: "published" });
  checkPackage(pkg, sub, approved);
  cleanIncoming(deps.publishedDir, id);

  // 2. Knowledge: the staging chunks become the real version's (one UPDATE, no vectors recomputed). The old version's
  // chunks leave only after the new one is live (step 7), so the RAG is never empty.
  await deps.renameKnowledge(sub.agentId, `staging:${id}`, approved.version);

  // 3. Who the creator is (the profile owns `creators.id`, not the manifest) and the search vectors (slow; outside the transaction).
  const [creator] = await db.select({ id: schema.creators.id }).from(schema.creators).where(eq(schema.creators.wallet, sub.creatorWallet));
  if (!creator) throw new Error(`creator ${sub.creatorWallet} has no profile (creators)`);
  const prepared = await deps.prepare(pkg);

  // 4. Catalog, in a single transaction: this is where the store changes. A brand-new row starts `active` (the chain
  // was just read as Active: step "ready"); existing rows keep the status the chain mirror wrote.
  const [prior] = await db
    .select({ id: schema.packageSubmissions.id })
    .from(schema.packageSubmissions)
    .where(and(eq(schema.packageSubmissions.agentId, sub.agentId), ne(schema.packageSubmissions.id, id), inArray(schema.packageSubmissions.status, ["published", "superseded", "suspended", "withdrawn"])))
    .limit(1);
  await db.transaction(async (tx) => {
    await writeCatalog(prepared, sub.creatorWallet, { agentId: sub.agentId, upsertCreator: false, creatorId: creator.id, insertStatus: "active" }, tx as unknown as typeof db);
    await relist(sub.agentId, tx as unknown as typeof db);
    // First publication of the agent: platform_status starts `active`. Later ones never touch it (suspension is the admin's call).
    if (!prior) await tx.update(schema.agents).set({ platformStatus: "active" }).where(eq(schema.agents.id, sub.agentId));
    const done = await tx
      .update(schema.packageSubmissions)
      .set({ status: "published", error: null, updatedAt: new Date() })
      .where(and(eq(schema.packageSubmissions.id, id), eq(schema.packageSubmissions.status, "publishing")))
      .returning({ id: schema.packageSubmissions.id });
    if (done.length === 0) throw new Error("the submission left 'publishing' during finalization");
    await tx
      .update(schema.packageSubmissions)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(schema.packageSubmissions.agentId, sub.agentId), ne(schema.packageSubmissions.id, id), eq(schema.packageSubmissions.status, "published")));
    if (actor) {
      await tx.insert(schema.packageReviews).values({ submissionId: id, reviewerWallet: actor, action: "finish", notes: "Publication finished", versionHash: approved.versionHash });
    }
  });

  // 5. Chain mirror (chain index, stake, cap, counters) onto the row that now exists. The indexer does the same; a
  // failure here only delays those columns.
  await deps.port.syncAgent(sub.agentId).catch((e) => console.warn(`[publish] chain mirror of ${sub.slug} failed: ${short(e)}`));

  // 6. The runtime serves the new package (sessions of the old version get session_outdated and reactivate).
  deps.reload();

  // 7. Only now the previous versions' chunks leave (a failure leaves garbage, but the publication is up). The catalog
  // version is NOT the reference (the chain mirror may have changed it when the creator signed): what counts is what
  // exists in knowledge_chunks, minus the new version and the `staging:*` of other submissions in progress.
  try {
    const rows = await db.selectDistinct({ version: schema.knowledgeChunks.version }).from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.agentId, sub.agentId));
    for (const { version } of rows) {
      if (version === approved.version || version.startsWith("staging:")) continue;
      await deps.deleteKnowledge(sub.agentId, version);
    }
  } catch (e) {
    console.warn(`[publish] old chunks of ${sub.slug} not removed: ${short(e)}`);
  }
  return approved.version;
}

/** Is the loaded package the approved one? Hash, id, slug and version (the hash covers the content; the rest, the identity). */
function checkPackage(pkg: SolverPackage, sub: SubmissionRow, approved: ApprovedRecord): void {
  const m = pkg.manifest;
  if (pkg.versionHash !== approved.versionHash) throw new PublishCheckError(`the package content changed after approval (hash ${pkg.versionHash.slice(0, 12)}… ≠ ${approved.versionHash.slice(0, 12)}…)`);
  if (m.id !== sub.agentId) throw new PublishCheckError(`the manifest id (${m.id}) is not the Solver's id (${sub.agentId})`);
  if (m.slug !== sub.slug) throw new PublishCheckError(`the manifest slug (${m.slug}) is not the submission's slug (${sub.slug})`);
  if (m.version !== approved.version) throw new PublishCheckError(`the manifest version (${m.version}) is not the approved one (${approved.version})`);
}

/** Shortcut: the (latest) submission of a Solver in a finalizable state, for the chain event and the CLI. */
export async function pendingSubmissionFor(agentId: string): Promise<SubmissionRow | null> {
  const [row] = await db
    .select()
    .from(schema.packageSubmissions)
    .where(and(eq(schema.packageSubmissions.agentId, agentId), inArray(schema.packageSubmissions.status, [...FINALIZABLE_STATUSES])))
    .orderBy(desc(schema.packageSubmissions.createdAt))
    .limit(1);
  return row ?? null;
}
