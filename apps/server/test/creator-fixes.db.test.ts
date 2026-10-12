import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Fixes from the review of the Solver creation flow, against a real Postgres: worker attempts (poison pill), queue
// without submissions in backoff, approval (self-review, version, owner), revocation, cleanup and light lists.
// Only runs with TEST_DATABASE_URL (DISPOSABLE database already migrated: `db:migrate`); see the header of platform-status.db.test.ts.
// package_reviews is insert-only: ids are unique per run (prefix P).

const url = process.env.TEST_DATABASE_URL;
const P = `cfx${Date.now().toString(36)}`;
const hex = (n: number) => randomBytes(n).toString("hex");
const DAY = 86_400_000;

describe("creation flow fixes with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let eq: typeof import("drizzle-orm").eq;
  let like: typeof import("drizzle-orm").like;
  let inArray: typeof import("drizzle-orm").inArray;
  let proc: typeof import("../src/submissions/process.js");
  let review: typeof import("../src/submissions/review.js");
  let cleanup: typeof import("../src/submissions/cleanup.js");
  let worker: typeof import("../src/worker/index.js");
  let lookup: typeof import("../src/submissions/lookup.js");
  let paths: typeof import("../src/submissions/paths.js");
  let root = "";

  const A = `${P}-creatora`;
  const B = `${P}-creatorb`;
  const REVIEWER = `${P}-revisor`;
  const agentIds: string[] = [];
  const noop = async () => undefined;

  const procDeps = (over: Record<string, unknown> = {}) => ({ ...proc.defaultProcessDeps, notifyAdmin: noop, notifyCreator: noop, minPriceUnits: async () => 5_000_000n, ...over });
  const reviewDeps = () => ({ ...review.defaultReviewDeps, minPriceUnits: async () => 5_000_000n, notifyCreator: noop, deleteStaging: async () => 0 });

  async function sub(over: Partial<typeof schema.packageSubmissions.$inferInsert> = {}) {
    const id = hex(12);
    const agentId = over.agentId ?? hex(16);
    agentIds.push(agentId);
    await db.insert(schema.packageSubmissions).values({ id, creatorWallet: A, agentId, slug: `${P}-s-${id.slice(0, 6)}`, version: "1.0.0", status: "submitted", ...over });
    return { id, agentId };
  }
  const row = async (id: string) => (await db.select().from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, id)))[0]!;
  const reviews = (id: string) => db.select().from(schema.packageReviews).where(eq(schema.packageReviews.submissionId, id));

  async function wipe() {
    await db.delete(schema.agentPublishedVersions).where(inArray(schema.agentPublishedVersions.agentId, agentIds));
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    await db.delete(schema.packageSubmissions).where(like(schema.packageSubmissions.creatorWallet, `${P}%`));
    await db.delete(schema.creators).where(like(schema.creators.wallet, `${P}%`));
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "solvers-cfx-"));
    Object.assign(process.env, {
      DATABASE_URL: url,
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
      SEARCH_MODE: "fts",
      SUBMISSIONS_DIR: root,
      PUBLISHED_DIR: join(root, "published"),
    });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    ({ eq, like, inArray } = await import("drizzle-orm"));
    proc = await import("../src/submissions/process.js");
    review = await import("../src/submissions/review.js");
    cleanup = await import("../src/submissions/cleanup.js");
    worker = await import("../src/worker/index.js");
    lookup = await import("../src/submissions/lookup.js");
    paths = await import("../src/submissions/paths.js");
    await wipe();
    await db.insert(schema.creators).values([
      { id: `${P}-ca`, wallet: A, name: "Criadora A", bio: "Bio da criadora A com mais de dez caracteres", invited: true, termsAcceptedAt: new Date() },
      { id: `${P}-cb`, wallet: B, name: "Criador B", bio: "Bio do criador B com mais de dez caracteres", invited: true, termsAcceptedAt: new Date() },
    ]);
  });

  after(async () => {
    if (db) {
      await wipe();
      await pool.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("worker: attempts and queue", () => {
    it("repeated system failure: on the 3rd attempt it rejects with a generic error and stops retrying", async () => {
      const { id } = await sub();
      const boom = procDeps({ deleteStaging: async () => Promise.reject(new Error("ENOENT /srv/solvers/data/x: banco caiu")) });
      await assert.rejects(proc.processSubmission(id, boom), /banco caiu/);
      assert.equal((await row(id)).attempts, 1);
      assert.equal((await row(id)).status, "validating");
      await assert.rejects(proc.processSubmission(id, boom), /banco caiu/);
      assert.equal((await row(id)).attempts, 2);
      // 3rd: does not throw, rejects.
      assert.equal(await proc.processSubmission(id, boom), "rejected_validation");
      const r = await row(id);
      assert.equal(r.status, "rejected_validation");
      assert.equal(r.error, proc.SYSTEM_FAILURE_MESSAGE);
      assert.doesNotMatch(JSON.stringify(r.validation), /ENOENT|srv|banco caiu/);
      assert.equal((r.validation as { errors: { code: string }[] }).errors[0]!.code, "PROCESSING_FAILED");
      assert.equal(await proc.processSubmission(id, procDeps()), "skipped", "final state: nothing left to process");
    });

    it("a submission that already used up its attempts (the process died midway) is rejected on the next claim", async () => {
      const { id } = await sub({ status: "validating", attempts: proc.MAX_ATTEMPTS });
      assert.equal(await proc.processSubmission(id, procDeps()), "rejected_validation");
      assert.equal((await row(id)).error, proc.SYSTEM_FAILURE_MESSAGE);
    });

    it("an intentional stop (deploy/SIGTERM) gives the attempt back", async () => {
      const { id } = await sub();
      await assert.rejects(proc.processSubmission(id, procDeps({ deleteStaging: async () => Promise.reject(new proc.WorkerStopping()) })), proc.WorkerStopping);
      assert.equal((await row(id)).attempts, 0);
      assert.equal((await row(id)).status, "validating");
    });

    it("time limit: a pass that overruns becomes a system failure (counts as an attempt)", async () => {
      const { id } = await sub();
      await assert.rejects(proc.processSubmission(id, procDeps({ timeoutMs: -1 })), proc.SubmissionTimeout);
      assert.equal((await row(id)).attempts, 1);
    });

    it("pendingSubmissionIds skips the ones in backoff (they do not take queue slots)", async () => {
      const a = await sub();
      const b = await sub();
      const all = await worker.pendingSubmissionIds(500);
      assert.ok(all.includes(a.id) && all.includes(b.id));
      const some = await worker.pendingSubmissionIds(500, [a.id]);
      assert.ok(!some.includes(a.id) && some.includes(b.id));
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("approval", () => {
    const pkg = (version: string) => ({ name: "Solver", version, pricing: { priceUsdc: 10, royaltyBps: 0 } });
    const CHECK = { promiseDelivered: true, twoDifferentiatorsProven: true, rightsAndSources: true, noHarmfulInstructions: true, priceTrialShowcaseCoherent: true };
    const ctx = (id: string, reviewer = REVIEWER) => ({ id, reviewerWallet: reviewer, ip: undefined, input: { notes: "ok", checklist: CHECK } });

    async function pending(version: string, over: Partial<typeof schema.packageSubmissions.$inferInsert> = {}) {
      const s = await sub({ status: "pending_review", version, manifest: pkg(version), validation: { ok: true, errors: [], warnings: [] }, ...over });
      const dir = paths.extractedDirOf(s.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), JSON.stringify(pkg(version)));
      return s;
    }
    async function agentRow(id: string, slug: string, creatorId: string, version: string) {
      await db.insert(schema.agents).values({ id, slug, name: "Solver", tagline: "t", description: "d", category: "Outros", creatorId, version, versionHash: "00", price: 10_000_000n });
    }

    it("the submission's creator cannot approve their own submission (403 self_review)", async () => {
      const s = await pending("1.0.0");
      await assert.rejects(review.approveSubmission(ctx(s.id, A), reviewDeps()), (e: any) => e.status === 403 && e.code === "self_review");
      assert.equal((await row(s.id)).status, "pending_review");
    });

    it("version equal to or lower than the catalog's: 409 version_already_published; higher: approves", async () => {
      const agentId = hex(16);
      const slug = `${P}-vers`;
      await agentRow(agentId, slug, `${P}-ca`, "1.2.0");
      const same = await pending("1.2.0", { agentId, slug });
      await assert.rejects(review.approveSubmission(ctx(same.id), reviewDeps()), (e: any) => e.status === 409 && e.code === "version_already_published");
      const lower = await pending("1.1.9", { agentId, slug });
      await assert.rejects(review.approveSubmission(ctx(lower.id), reviewDeps()), (e: any) => e.code === "version_already_published");
      const up = await pending("1.3.0", { agentId, slug });
      const out = await review.approveSubmission(ctx(up.id), reviewDeps());
      assert.equal(out.status, "awaiting_creator_signature");
      assert.equal((await row(up.id)).status, "awaiting_creator_signature");
    });

    it("the slug/id now belongs to another creator in the catalog: 409 ownership_conflict (nothing is written)", async () => {
      const slug = `${P}-roubado`;
      // The submission's slug already belongs to ANOTHER Solver, from creator B, in the catalog.
      await agentRow(hex(16), slug, `${P}-cb`, "1.0.0");
      const s = await pending("1.0.0", { slug });
      await assert.rejects(review.approveSubmission(ctx(s.id), reviewDeps()), (e: any) => e.status === 409 && e.code === "ownership_conflict");
      assert.equal((await row(s.id)).status, "pending_review");
      assert.equal((await db.select().from(schema.agentPublishedVersions).where(eq(schema.agentPublishedVersions.agentId, s.agentId))).length, 0);
    });

    it("a reserved platform id and a reserved slug are refused", async () => {
      assert.match((await lookup.ownershipConflict({ submissionId: "x", wallet: A, agentId: "c71ad0a50f750e75c71ad0a50f750e75", slug: `${P}-livre` })) ?? "", /platform/);
      assert.match((await lookup.ownershipConflict({ submissionId: "x", wallet: A, agentId: hex(16), slug: "solvers" })) ?? "", /reserved/);
      assert.equal(await lookup.ownershipConflict({ submissionId: "x", wallet: A, agentId: hex(16), slug: `${P}-livre2` }), null);
    });

    it("revoke: awaiting_creator_signature goes back to changes_requested, clears the approved record and leaves the trail", async () => {
      const s = await pending("2.0.0");
      await review.approveSubmission(ctx(s.id), reviewDeps());
      assert.equal((await db.select().from(schema.agentPublishedVersions).where(eq(schema.agentPublishedVersions.agentId, s.agentId))).length, 1);
      await assert.rejects(review.revokeApproval(ctx(await (await pending("2.0.1")).id), reviewDeps()), (e: any) => e.code === "invalid_state", "only applies to a submission that is approved and not yet signed");
      const out = await review.revokeApproval(ctx(s.id), reviewDeps());
      assert.equal(out.status, "changes_requested");
      const r = await row(s.id);
      assert.equal(r.status, "changes_requested");
      assert.equal(r.approved, null);
      assert.equal((await db.select().from(schema.agentPublishedVersions).where(eq(schema.agentPublishedVersions.agentId, s.agentId))).length, 0);
      assert.deepEqual((await reviews(s.id)).map((x) => x.action), ["approve", "revoke"]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("cleanup", () => {
    const old = (days: number) => new Date(Date.now() - days * DAY);

    it("expires changes_requested and awaiting_creator_signature idle for more than 30 days (slug freed, system trail)", async () => {
      const a = await sub({ status: "changes_requested", updatedAt: old(40) });
      const b = await sub({ status: "awaiting_creator_signature", updatedAt: old(31), approved: { versionHash: "ab", priceUsdc: "10000000", royaltyBps: 0, name: "N", version: "1.0.0" } });
      await db.insert(schema.agentPublishedVersions).values({ agentId: b.agentId, version: "1.0.0", versionHash: "ab", priceUsdc: 10_000_000n });
      const fresh = await sub({ status: "changes_requested", updatedAt: old(5) });
      const other = await sub({ status: "pending_review", updatedAt: old(90) });
      await cleanup.expireStaleSubmissions({ notify: false });
      for (const s of [a, b]) {
        const r = await row(s.id);
        assert.equal(r.status, "rejected");
        assert.match(r.reviewerNotes ?? "", /expired/i);
        const rv = await reviews(s.id);
        assert.deepEqual(rv.map((x) => [x.action, x.reviewerWallet]), [["expire", "system"]]);
      }
      assert.equal((await db.select().from(schema.agentPublishedVersions).where(eq(schema.agentPublishedVersions.agentId, b.agentId))).length, 0);
      assert.equal((await row(fresh.id)).status, "changes_requested");
      assert.equal((await row(other.id)).status, "pending_review", "in review does not expire: it is the admin's queue");
    });

    it("deletes the ZIP/folder of submissions rejected more than 30 days ago, orphan folders and old .part files (and only those)", async () => {
      const oldRejected = await sub({ status: "rejected", updatedAt: old(40) });
      const newRejected = await sub({ status: "rejected", updatedAt: old(3) });
      for (const s of [oldRejected, newRejected]) {
        await mkdir(join(paths.submissionDir(s.id), "extracted"), { recursive: true });
        await writeFile(join(paths.submissionDir(s.id), "package.zip"), "zip");
      }
      const live = await sub({ status: "pending_review" });
      await mkdir(paths.submissionDir(live.id), { recursive: true });
      await writeFile(join(paths.submissionDir(live.id), "package.zip.abc.part"), "x");
      await writeFile(join(paths.submissionDir(live.id), "package.zip.old.part"), "x");
      await utimes(join(paths.submissionDir(live.id), "package.zip.old.part"), old(2), old(2));
      const orphanOld = hex(12);
      const orphanNew = hex(12);
      for (const o of [orphanOld, orphanNew]) {
        await mkdir(paths.submissionDir(o), { recursive: true });
        await writeFile(join(paths.submissionDir(o), "package.zip"), "x");
      }
      await utimes(paths.submissionDir(orphanOld), old(3), old(3));

      await cleanup.removeRejectedFiles();
      await cleanup.removeOrphans();

      assert.equal(existsSync(paths.submissionDir(oldRejected.id)), false);
      assert.equal(existsSync(paths.submissionDir(newRejected.id)), true);
      assert.equal(existsSync(join(paths.submissionDir(live.id), "package.zip.old.part")), false, ".part older than a day");
      assert.equal(existsSync(join(paths.submissionDir(live.id), "package.zip.abc.part")), true, "a recent .part belongs to an upload in progress");
      assert.equal(existsSync(paths.submissionDir(orphanOld)), false);
      assert.equal(existsSync(paths.submissionDir(orphanNew)), true, "recent folder without a row: the upload creates the folder before the row");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("light lists", () => {
    it("listColumns returns the truncated name and the counts, without the whole manifest", async () => {
      const s = await sub({
        status: "pending_review",
        manifest: { name: "N".repeat(500), description: "x".repeat(200_000) },
        validation: { ok: false, errors: [{ code: "A" }, { code: "B" }], warnings: [{ code: "C" }] },
      });
      const [r] = await db.select(lookup.listColumns).from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, s.id));
      assert.equal(r!.name!.length, 80);
      assert.equal(r!.errorCount, 2);
      assert.equal(r!.warningCount, 1);
      assert.ok(!("manifest" in r!) && !("scans" in r!));
      const [sem] = await db.select(lookup.listColumns).from(schema.packageSubmissions).where(eq(schema.packageSubmissions.id, (await sub()).id));
      assert.deepEqual([sem!.name, sem!.errorCount, sem!.warningCount], [null, 0, 0]);
    });
  });
});
