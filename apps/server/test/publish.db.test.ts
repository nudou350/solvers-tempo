import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FakeChain } from "./helpers/fake-publish-chain.js";

// On-chain publication with a real database and an IN-MEMORY chain (PACKAGE_SPEC.md 15): creator co-signature through
// the HTTP routes (call batch + confirmation by tx hash), admin approval, finalization (idempotent, failure and resume),
// the chain event and the kill switch. The real chain is covered by publish-anvil.db.test.ts.
// Needs TEST_DATABASE_URL (DISPOSABLE migrated database). Rows use the "pubtest" prefix and the agent ids below.

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "pubtest";
const hexId = (suffix: string) => "0".repeat(24) + suffix;
const AGENT_A = hexId("b2b2a001"); // new Solver -> updates -> suspension
const AGENT_B = hexId("b2b2a002"); // new Solver finalized by the chain event
const AGENT_C = hexId("b2b2a003"); // submission in the wrong state
const AGENT_IDS = [AGENT_A, AGENT_B, AGENT_C];
const CREATOR = "0x00000000000000000000000000000000000c4ea7";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const ADMIN_SITE = "0x000000000000000000000000000000000000ad51";
const H = (c: string) => c.repeat(64);
const norm = (h: string | null | undefined) => (h ?? "").toLowerCase().replace(/^0x/, "");

describe("publication with a database and an in-memory chain", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let d: typeof import("drizzle-orm");
  let server: Server;
  let base = "";
  let cookie: (wallet: string) => Promise<string>;
  let fake: FakeChain;
  let FAKE_ADMIN: string;
  let packageHash: typeof import("../src/runtime/packages.js").packageHash;
  let finalizePublication: typeof import("../src/publish/finalize.js").finalizePublication;
  let approveOnChain: typeof import("../src/publish/approve.js").approveOnChain;
  let ApproveError: typeof import("../src/publish/approve.js").ApproveError;
  let suspendSolver: typeof import("../src/publish/suspend.js").suspendSolver;
  let SuspendError: typeof import("../src/publish/suspend.js").SuspendError;
  let onPublishEvent: typeof import("../src/publish/reconcile.js").onPublishEvent;
  let publishedVersionOf: typeof import("../src/publish/fs.js").publishedVersionOf;
  const root = mkdtempSync(join(tmpdir(), "solvers-publish-"));
  const SUBS = join(root, "submissions");
  const PUBLISHED = join(root, "packages");

  // ---------- fixtures ----------

  /** Extracted folder of a submission (SUBMISSIONS_DIR/<id>/extracted/<slug>), as the worker leaves it. */
  function writePackage(subId: string, slug: string, agentId: string, version: string, priceUsdc: number) {
    const dir = join(SUBS, subId, "extracted", slug);
    mkdirSync(join(dir, "steps"), { recursive: true });
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        id: agentId,
        slug,
        name: "Test Solver",
        tagline: "A value sentence",
        description: `Description of version ${version}`,
        category: "Other",
        version,
        creator: { id: `${PREFIX}-creator`, name: "Test creator", bio: "Bio" },
        requirements: [],
        packageContents: ["a"],
        steps: [{ file: "steps/01-first.md", gate: [] }],
        pricing: { priceUsdc, royaltyBps: 500 },
        guarantee: { available: false, defaultCriteria: [] },
      }),
    );
    writeFileSync(join(dir, "steps", "01-first.md"), `# Step 1\n\nDo what it takes in ${version}.`);
    writeFileSync(join(dir, "knowledge", "a.md"), `Knowledge of version ${version}.`);
    return dir;
  }

  /** Submission approved on the site: approved record, approved-version row and staging knowledge. */
  async function seed(subId: string, agentId: string, slug: string, version: string, priceUsdc: number, status = "awaiting_creator_signature", extra: { manifest?: Record<string, unknown>; royaltyBps?: number } = {}) {
    const dir = writePackage(subId, slug, agentId, version, priceUsdc);
    const versionHash = packageHash(dir);
    const priceUnits = BigInt(priceUsdc) * 1_000_000n;
    const approved = { versionHash, priceUsdc: priceUnits.toString(), royaltyBps: extra.royaltyBps ?? 500, name: "Test Solver", version };
    await db.insert(schema.packageSubmissions).values({ id: subId, creatorWallet: CREATOR, agentId, slug, version, status, approved, manifest: extra.manifest ?? null });
    await db.insert(schema.agentPublishedVersions).values({ agentId, version, versionHash, priceUsdc: priceUnits }).onConflictDoNothing();
    await db.insert(schema.knowledgeChunks).values({ agentId, version: `staging:${subId}`, source: "knowledge/a.md", content: `Knowledge of version ${version}.` });
    return { dir, versionHash, approved };
  }

  const sub = async (id: string) => (await db.select().from(schema.packageSubmissions).where(d.eq(schema.packageSubmissions.id, id)))[0]!;
  const agent = async (id: string) => (await db.select().from(schema.agents).where(d.eq(schema.agents.id, id)))[0]!;
  const reviews = async (submissionId: string, action?: string) =>
    (await db.select().from(schema.packageReviews).where(d.eq(schema.packageReviews.submissionId, submissionId))).filter((r) => !action || r.action === action);
  const chunkVersions = async (agentId: string) =>
    [...new Set((await db.select({ v: schema.knowledgeChunks.version }).from(schema.knowledgeChunks).where(d.eq(schema.knowledgeChunks.agentId, agentId))).map((r) => r.v))].sort();

  async function http(wallet: string | null, method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(wallet ? { cookie: await cookie(wallet) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const tx = (wallet: string | null, kind: string, submissionId: string, extra: Record<string, unknown> = {}) => http(wallet, "POST", `/tx/${kind}`, { submissionId, ...extra });
  const confirm = (wallet: string, submissionId: string, txHash: string, kind?: string) => http(wallet, "POST", "/tx/publication/confirm", { submissionId, txHash, ...(kind ? { kind } : {}) });

  async function cleanup() {
    // package_reviews is an insert-only audit trail; the database is DISPOSABLE, so the test removes its own rows. If an
    // insert-only trigger exists, it is switched off only around this delete.
    const trig = await db.execute(d.sql`select 1 from pg_trigger where tgname = 'package_reviews_no_update_delete'`);
    const hasTrigger = (trig as unknown as { rows: unknown[] }).rows.length > 0;
    if (hasTrigger) await db.execute(d.sql`alter table package_reviews disable trigger package_reviews_no_update_delete`);
    await db.delete(schema.packageReviews).where(d.like(schema.packageReviews.submissionId, `${PREFIX}%`));
    await db.delete(schema.packageReviews).where(d.inArray(schema.packageReviews.submissionId, AGENT_IDS.map((id) => `agent:${id}`)));
    if (hasTrigger) await db.execute(d.sql`alter table package_reviews enable trigger package_reviews_no_update_delete`);
    await db.delete(schema.packageSubmissions).where(d.like(schema.packageSubmissions.id, `${PREFIX}%`));
    await db.delete(schema.agentPublishedVersions).where(d.inArray(schema.agentPublishedVersions.agentId, AGENT_IDS));
    await db.delete(schema.knowledgeChunks).where(d.inArray(schema.knowledgeChunks.agentId, AGENT_IDS));
    await db.delete(schema.agentSearchVectors).where(d.inArray(schema.agentSearchVectors.agentId, AGENT_IDS));
    await db.delete(schema.agents).where(d.inArray(schema.agents.id, AGENT_IDS));
    await db.delete(schema.creators).where(d.like(schema.creators.id, `${PREFIX}%`));
  }

  before(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url,
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
      SEARCH_MODE: "fts", // no embeddings model: the catalog writes only the search text
      SUBMISSIONS_DIR: SUBS,
      PUBLISHED_DIR: PUBLISHED,
      ADMIN_WALLETS: ADMIN_SITE,
    });
    delete process.env.TELEGRAM_BOT_TOKEN;
    ({ db, schema, pool } = await import("../src/db/index.js"));
    d = await import("drizzle-orm");
    ({ packageHash } = await import("../src/runtime/packages.js"));
    ({ finalizePublication } = await import("../src/publish/finalize.js"));
    ({ approveOnChain, ApproveError } = await import("../src/publish/approve.js"));
    ({ suspendSolver, SuspendError } = await import("../src/publish/suspend.js"));
    ({ onPublishEvent } = await import("../src/publish/reconcile.js"));
    ({ publishedVersionOf } = await import("../src/publish/fs.js"));
    const { mirrorAgentAccount } = await import("../src/indexer/sync.js");
    const helper = await import("./helpers/fake-publish-chain.js");
    FAKE_ADMIN = helper.FAKE_ADMIN;
    fake = new helper.FakeChain((s) => mirrorAgentAccount(s));
    (await import("../src/publish/chain-port.js")).setPublishChain(fake);
    // Minimal app with only this area's router (the full app is wired by modules.ts).
    const express = (await import("express")).default;
    const cookieParser = (await import("cookie-parser")).default;
    const { optionalAuth, signSession, SESSION_COOKIE } = await import("../src/auth/jwt.js");
    const { errorHandler } = await import("../src/lib/http.js");
    const { publishRouter } = await import("../src/publish/routes.js");
    const app = express();
    app.use("/api", express.json(), cookieParser(), optionalAuth, publishRouter);
    app.use(errorHandler);
    cookie = async (wallet) => `${SESSION_COOKIE}=${await signSession(wallet)}`;

    await cleanup();
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: CREATOR, name: "Test creator", invited: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    server?.close();
    (await import("../src/publish/chain-port.js")).setPublishChain(null);
    rmSync(root, { recursive: true, force: true });
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  // ---------- New Solver: co-signature -> admin approval -> live ----------

  describe("new Solver", () => {
    const N1 = `${PREFIX}-n1`;
    const SLUG = `${PREFIX}-new`;
    let approved: { versionHash: string; priceUsdc: string; royaltyBps: number; name: string; version: string };
    let registerTx = "";

    before(async () => {
      ({ approved } = await seed(N1, AGENT_A, SLUG, "1.0.0", 10, "awaiting_creator_signature", { manifest: { supply: { maxLicenses: 50 } } }));
    });

    it("no login 401; another creator's wallet 403; unknown submission 404; empty id 400", async () => {
      assert.equal((await tx(null, "register-agent", N1)).status, 401);
      assert.equal((await tx(OTHER, "register-agent", N1)).status, 403);
      assert.equal((await tx(CREATOR, "register-agent", `${PREFIX}-missing`)).status, 404);
      assert.equal((await tx(CREATOR, "register-agent", "")).status, 400);
    });

    it("the wrong step is a 409 wrong_step with the expected one (the client does not choose the step)", async () => {
      const r = await tx(CREATOR, "update-version", N1);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "wrong_step");
      assert.equal(r.body.expected, "register-agent");
    });

    it("a submission outside awaiting_creator_signature builds nothing (409 submission_state)", async () => {
      await seed(`${PREFIX}-pend`, AGENT_C, `${PREFIX}-pending`, "1.0.0", 10, "pending_review");
      const r = await tx(CREATOR, "register-agent", `${PREFIX}-pend`);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "submission_state");
      assert.equal(r.body.status, "pending_review");
    });

    it("balance below the stake: 400 insufficient_funds with the amounts", async () => {
      fake.balances.set(CREATOR, 1_000_000n);
      const r = await tx(CREATOR, "register-agent", N1);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "insufficient_funds");
      assert.equal(r.body.neededUnits, "5000000");
      assert.equal(r.body.balanceUnits, "1000000");
      fake.balances.delete(CREATOR);
    });

    it("creator + platform royalty above 2500 bps: 409 royalty_too_high; a failed simulation: 409 with the contract error", async () => {
      fake.cfg = { ...fake.cfg, platformRoyaltyBps: 2100 };
      assert.equal((await tx(CREATOR, "register-agent", N1)).body.code, "royalty_too_high");
      fake.cfg = { ...fake.cfg, platformRoyaltyBps: 500 };
      fake.simulateRefusal = { name: "Paused", message: "The platform paused this operation." };
      const r = await tx(CREATOR, "register-agent", N1);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "simulation_failed");
      assert.equal(r.body.error, "Paused");
      fake.simulateRefusal = null;
    });

    it("register-agent: a sponsored call batch built from the APPROVED record and the manifest cap, whatever the client sends", async () => {
      const r = await tx(CREATOR, "register-agent", N1, { priceUsdc: 1, versionHash: H("f"), name: "Other name", version: "9.9.9" });
      assert.equal(r.status, 200);
      assert.equal(r.body.feePayer, true);
      assert.ok(Array.isArray(r.body.calls) && (r.body.calls as unknown[]).length > 0);
      const built = fake.built.at(-1)!;
      assert.equal(built.wallet, CREATOR);
      assert.deepEqual(built.approved, approved);
      assert.equal(built.maxSupply, 50);
    });

    it("the creator's batch is mined and indexed: a minimal unlisted row, sync ok (approved version recorded before the tx)", async () => {
      registerTx = fake.land("register-agent", CREATOR, AGENT_A, approved);
      await fake.indexTx(registerTx);
      const a = await agent(AGENT_A);
      assert.equal(a.syncFlag, "ok");
      assert.equal(a.listed, false);
      assert.equal(a.slug, AGENT_A, "minimal indexer row: the catalog is only written at the last step");
    });

    it("confirm: a hash of another tx 400 tx_not_for_agent; another wallet 403; the right one links register_tx and advances", async () => {
      const bad = await confirm(CREATOR, N1, `0x${"9".repeat(64)}`);
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, "tx_not_for_agent");
      assert.equal((await http(CREATOR, "POST", "/tx/publication/confirm", { submissionId: N1, signature: registerTx })).status, 400, "the old signature field is refused");
      assert.equal((await confirm(OTHER, N1, registerTx)).status, 403);
      // The tx must contain the requested step.
      assert.equal((await confirm(CREATOR, N1, registerTx, "update-pricing")).body.code, "tx_not_for_agent");

      const ok = await confirm(CREATOR, N1, registerTx, "register-agent");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.outcome, "not_ready");
      assert.equal(ok.body.step, "await-admin-approval");
      assert.equal(ok.body.status, "awaiting_onchain_approval");
      assert.equal((await sub(N1)).registerTx, registerTx);
      assert.equal(existsSync(join(PUBLISHED, SLUG)), false, "the store did not change");
    });

    it("the plan says what is missing (read from the chain)", async () => {
      const r = await http(CREATOR, "GET", `/tx/publication/${N1}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.step, "await-admin-approval");
      assert.equal(r.body.isNewAgent, true);
      assert.equal((r.body.approved as { priceUnits: string }).priceUnits, "10000000");
      assert.equal((r.body.chain as { registered: boolean }).registered, true);
      assert.equal((await http(OTHER, "GET", `/tx/publication/${N1}`)).status, 403);
    });

    it("cli:approve refuses a key that is not the on-chain admin; the dry-run sends nothing", async () => {
      fake.onchainAdminAddress = OTHER;
      await assert.rejects(approveOnChain(SLUG, { port: fake }), (e: unknown) => e instanceof ApproveError && /not the on-chain admin/.test((e as Error).message));
      fake.onchainAdminAddress = FAKE_ADMIN;
      fake.admin = null;
      await assert.rejects(approveOnChain(SLUG, { port: fake }), (e: unknown) => e instanceof ApproveError && /no admin key/.test((e as Error).message));
      fake.admin = FAKE_ADMIN;
      const dry = await approveOnChain(SLUG, { port: fake, dryRun: true });
      assert.equal(dry.approveTx, null);
      assert.equal(dry.step, "await-admin-approval");
      assert.deepEqual(fake.calls, []);
    });

    it("cli:approve refuses when the chain does NOT match the approved version", async () => {
      await fake.indexTx(fake.tamper(AGENT_A, { versionHash: H("e") }));
      await assert.rejects(approveOnChain(N1, { port: fake }), (e: unknown) => e instanceof ApproveError && /missing: update-version/.test((e as Error).message));
      assert.deepEqual(fake.calls, []);
      fake.tamper(AGENT_A, { versionHash: approved.versionHash });
    });

    it("cli:approve signs approveAgent, records approve_tx and finalizes: the Solver is live", async () => {
      let reloads = 0;
      const r = await approveOnChain(SLUG, { port: fake, deps: { reload: () => void reloads++ } });
      assert.ok(r.approveTx);
      assert.deepEqual(r.finalize, { outcome: "published", version: "1.0.0" });
      assert.deepEqual(fake.calls, [`approve:${AGENT_A}`]);
      assert.equal(reloads, 1);

      const s = await sub(N1);
      assert.equal(s.status, "published");
      assert.equal(s.approveTx, r.approveTx);
      const [pv] = await db.select().from(schema.agentPublishedVersions).where(d.and(d.eq(schema.agentPublishedVersions.agentId, AGENT_A), d.eq(schema.agentPublishedVersions.version, "1.0.0")));
      assert.equal(pv!.approveTx, r.approveTx);

      const a = await agent(AGENT_A);
      assert.equal(a.slug, SLUG);
      assert.equal(a.name, "Test Solver");
      assert.equal(a.version, "1.0.0");
      assert.equal(norm(a.versionHash), approved.versionHash);
      assert.equal(a.price, 10_000_000n);
      assert.equal(a.status, "active");
      assert.equal(a.platformStatus, "active");
      assert.equal(a.syncFlag, "ok");
      assert.equal(a.listed, true);
      assert.equal(a.creatorId, `${PREFIX}-creator`);
      assert.match(a.searchText, /Test Solver/);
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.0.0");
      assert.equal(existsSync(join(PUBLISHED, ".incoming", N1)), false);
      assert.deepEqual(await chunkVersions(AGENT_A), ["1.0.0"]);
      const fin = await reviews(N1, "finish");
      assert.equal(fin.length, 1);
      assert.equal(fin[0]!.reviewerWallet, FAKE_ADMIN);
    });

    it("idempotent; the 'Finish' button is for site admins only", async () => {
      assert.deepEqual(await finalizePublication(N1), { outcome: "already_published" });
      assert.equal((await http(CREATOR, "POST", `/admin/submissions/${N1}/finish`)).status, 403);
      assert.equal((await http(null, "POST", `/admin/submissions/${N1}/finish`)).status, 401);
      assert.equal((await http(ADMIN_SITE, "POST", `/admin/submissions/${PREFIX}-missing/finish`)).status, 404);
      const again = await http(ADMIN_SITE, "POST", `/admin/submissions/${N1}/finish`);
      assert.equal(again.status, 200);
      assert.equal(again.body.outcome, "already_published");
      assert.equal((await reviews(N1, "finish")).length, 1);
      await assert.rejects(approveOnChain(N1, { port: fake }), ApproveError);
    });
  });

  // ---------- Update of an approved Solver ----------

  describe("update", () => {
    const N1 = `${PREFIX}-n1`;
    const U2 = `${PREFIX}-u2`;
    const SLUG = `${PREFIX}-new`;
    let approved: { versionHash: string; priceUsdc: string; royaltyBps: number; name: string; version: string };

    before(async () => {
      ({ approved } = await seed(U2, AGENT_A, SLUG, "1.1.0", 12));
    });

    it("the next step is update-version (one batch for version and price)", async () => {
      assert.equal((await tx(CREATOR, "register-agent", U2)).body.expected, "update-version");
      assert.equal((await tx(CREATOR, "update-pricing", U2)).body.expected, "update-version");
      const r = await tx(CREATOR, "update-version", U2);
      assert.equal(r.status, 200);
      assert.deepEqual(fake.built.at(-1)!.approved, approved);
    });

    it("confirm: everything ready (updates need no on-chain approval) publishes at once; the old version is archived", async () => {
      const hash = fake.land("update-version", CREATOR, AGENT_A, approved);
      assert.equal((await http(CREATOR, "GET", `/tx/publication/${U2}`)).body.step, "ready");
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.0.0", "the SERVED package is still the old one");
      const r = await confirm(CREATOR, U2, hash, "update-version");
      assert.equal(r.status, 200);
      assert.equal(r.body.outcome, "published");
      assert.equal((await sub(U2)).registerTx, hash);
      assert.equal((await sub(N1)).status, "superseded");
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.1.0");
      assert.equal(publishedVersionOf(join(PUBLISHED, "_archive", SLUG, "1.0.0")), "1.0.0");
      assert.deepEqual(await chunkVersions(AGENT_A), ["1.1.0"]);
      const a = await agent(AGENT_A);
      assert.equal(a.version, "1.1.0");
      assert.equal(a.price, 12_000_000n);
      assert.equal(a.syncFlag, "ok");
      assert.equal(readFileSync(join(PUBLISHED, SLUG, "knowledge", "a.md"), "utf8"), "Knowledge of version 1.1.0.");
      assert.equal((await tx(CREATOR, "update-pricing", U2)).body.code, "submission_state");
    });

    it("a new version with a new price: ONE batch (version + price), both checked against the approved record", async () => {
      const P = `${PREFIX}-p1`;
      const { approved: ap } = await seed(P, AGENT_A, SLUG, "1.1.1", 15);
      assert.equal((await tx(CREATOR, "update-pricing", P)).body.expected, "update-version");
      assert.equal((await tx(CREATOR, "update-version", P)).status, 200);
      const hash = fake.land("update-version", CREATOR, AGENT_A, ap);
      assert.deepEqual(fake.txs.get(hash)!.events.map((e) => e.name), ["AgentVersionUpdated", "PricingUpdated"]);
      const r = await confirm(CREATOR, P, hash);
      assert.equal(r.body.outcome, "published");
      const a = await agent(AGENT_A);
      assert.equal(a.version, "1.1.1");
      assert.equal(a.price, 15_000_000n);
    });

    it("the creator changed the price directly on-chain: the mirror flags it and keeps the approved price", async () => {
      const t = fake.tamperPrice(AGENT_A, 1_000_000n);
      await fake.indexTx(t);
      const a = await agent(AGENT_A);
      assert.equal(a.syncFlag, "unapproved_chain_version");
      assert.equal(a.price, 15_000_000n);
      fake.accounts.get(AGENT_A)!.price = 15_000_000n;
      await fake.syncAgent(AGENT_A);
      assert.equal((await agent(AGENT_A)).syncFlag, "ok");
    });
  });

  // ---------- Failure and resume ----------

  describe("failure and resume", () => {
    const SLUG = `${PREFIX}-new`;

    it("content changed after approval: the hash does not match and publication fails without touching the published folder", async () => {
      const S3 = `${PREFIX}-s3`;
      const { approved, dir } = await seed(S3, AGENT_A, SLUG, "1.2.0", 15);
      const hash = fake.land("update-version", CREATOR, AGENT_A, approved);
      const original = readFileSync(join(dir, "knowledge", "a.md"), "utf8");
      writeFileSync(join(dir, "knowledge", "a.md"), `${original} TAMPERED`);
      const c = await confirm(CREATOR, S3, hash, "update-version");
      assert.equal(c.body.outcome, "failed");
      assert.equal(c.body.status, "publish_failed");
      assert.match(String(c.body.error), /changed after approval/);
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.1.1", "the published folder was not touched");
      assert.ok((await chunkVersions(AGENT_A)).includes(`staging:${S3}`));

      assert.equal((await http(CREATOR, "POST", `/admin/submissions/${S3}/finish`)).status, 403);
      assert.equal((await http(ADMIN_SITE, "POST", `/admin/submissions/${S3}/finish`)).body.outcome, "failed");
      assert.equal((await reviews(S3, "finish")).length, 0);

      writeFileSync(join(dir, "knowledge", "a.md"), original);
      const fixed = await http(ADMIN_SITE, "POST", `/admin/submissions/${S3}/finish`);
      assert.equal(fixed.body.outcome, "published");
      assert.equal((await sub(S3)).error, null);
      const fin = await reviews(S3, "finish");
      assert.equal(fin.length, 1);
      assert.equal(fin[0]!.reviewerWallet, ADMIN_SITE);
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.2.0");
    });

    it("failure midway (after the disk) and resume: no double archive, knowledge kept; the creator never sees internal details", async () => {
      const S4 = `${PREFIX}-s4`;
      const { approved } = await seed(S4, AGENT_A, SLUG, "1.3.0", 15);
      await fake.indexTx(fake.land("update-version", CREATOR, AGENT_A, approved));
      let reloads = 0;
      const first = await finalizePublication(S4, { deps: { renameKnowledge: async () => Promise.reject(new Error("database down")), reload: () => void reloads++ } });
      assert.equal(first.outcome, "failed");
      assert.match(String((first as { error?: string }).error), /internal error/);
      assert.doesNotMatch((await sub(S4)).error ?? "", /database down/);
      assert.equal(reloads, 0);
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.3.0");
      const retry = await finalizePublication(S4, { deps: { reload: () => void reloads++ } });
      assert.deepEqual(retry, { outcome: "published", version: "1.3.0" });
      assert.equal(existsSync(join(PUBLISHED, "_archive", SLUG, "1.2.0-1")), false);
      assert.deepEqual(await chunkVersions(AGENT_A), ["1.3.0"]);
    });

    it("three finalizations at once (event + button + CLI): one publishes", async () => {
      const S5 = `${PREFIX}-s5`;
      const { approved } = await seed(S5, AGENT_A, SLUG, "1.4.0", 15);
      fake.land("update-version", CREATOR, AGENT_A, approved);
      const results = await Promise.all([finalizePublication(S5), finalizePublication(S5), finalizePublication(S5)]);
      assert.equal(results.filter((r) => r.outcome === "published").length, 1, JSON.stringify(results));
      for (const r of results) assert.ok(["published", "busy", "already_published"].includes(r.outcome));
      assert.equal(publishedVersionOf(join(PUBLISHED, SLUG)), "1.4.0");
    });

    it("chain still behind the approved record: nothing is finalized", async () => {
      const S6 = `${PREFIX}-s6`;
      await seed(S6, AGENT_A, SLUG, "1.5.0", 15);
      const r = await finalizePublication(S6);
      assert.equal(r.outcome, "not_ready");
      if (r.outcome === "not_ready") assert.equal(r.step, "update-version");
      assert.equal((await sub(S6)).status, "awaiting_creator_signature");
      await db.update(schema.packageSubmissions).set({ status: "withdrawn" }).where(d.eq(schema.packageSubmissions.id, S6));
    });
  });

  // ---------- The chain event finalizes by itself ----------

  describe("chain event", () => {
    it("AgentStatusChanged(Active) of a new Solver waiting for the admin finalizes and records approve_tx", async () => {
      const E = `${PREFIX}-e1`;
      const slug = `${PREFIX}-event`;
      const { approved } = await seed(E, AGENT_B, slug, "1.0.0", 8, "awaiting_onchain_approval");
      await fake.indexTx(fake.land("register-agent", CREATOR, AGENT_B, approved));
      const ev = (status: number, agentId = AGENT_B) => ({ name: "AgentStatusChanged", agentId: `0x${agentId}${"0".repeat(32)}`, status });

      assert.equal(await onPublishEvent(ev(2), `0x${"1".repeat(64)}`), null, "a suspension unlocks nothing");
      assert.equal(await onPublishEvent(ev(1, hexId("deadbeef")), `0x${"2".repeat(64)}`), null, "unknown agent");
      const early = await onPublishEvent(ev(1), `0x${"3".repeat(64)}`, { port: fake });
      assert.equal(early?.result?.outcome, "not_ready", "still Pending on-chain");
      assert.equal((await sub(E)).approveTx, null, "an early event is not recorded as approve_tx");

      fake.accounts.get(AGENT_B)!.status = "active";
      const approvalTx = `0x${"4".repeat(64)}`;
      const r = await onPublishEvent(ev(1), approvalTx, { port: fake });
      assert.deepEqual(r?.result, { outcome: "published", version: "1.0.0" });
      const s = await sub(E);
      assert.equal(s.status, "published");
      assert.equal(s.approveTx, approvalTx);
      assert.equal((await agent(AGENT_B)).listed, true);
      assert.equal((await reviews(E, "finish")).length, 0, "finalization by the event is not an admin action");
    });
  });

  // ---------- Kill switch ----------

  describe("suspension", () => {
    const SLUG = `${PREFIX}-new`;

    it("suspends on the platform and on-chain, with an audit row", async () => {
      const [published] = await db.select().from(schema.packageSubmissions).where(d.and(d.eq(schema.packageSubmissions.agentId, AGENT_A), d.eq(schema.packageSubmissions.status, "published")));
      const r = await suspendSolver(SLUG, { reason: "copied third-party content", port: fake });
      assert.equal(r.action, "suspend");
      assert.equal(r.platformChanged, true);
      assert.ok(r.chainTx);
      assert.equal(r.submissionId, published!.id);
      assert.equal(fake.accounts.get(AGENT_A)!.status, "suspended");
      const a = await agent(AGENT_A);
      assert.equal(a.platformStatus, "suspended");
      assert.equal(a.status, "suspended", "the chain status was mirrored");
      assert.equal((await sub(published!.id)).status, "suspended");
      const trail = await reviews(published!.id, "suspend");
      assert.equal(trail.length, 1);
      assert.equal(trail[0]!.reviewerWallet, FAKE_ADMIN);
      assert.equal(trail[0]!.notes, "copied third-party content");
    });

    it("the chain mirror never lifts it, and running again only completes the chain side", async () => {
      fake.accounts.get(AGENT_A)!.status = "active";
      await fake.syncAgent(AGENT_A);
      assert.equal((await agent(AGENT_A)).platformStatus, "suspended");
      const again = await suspendSolver(SLUG, { port: fake });
      assert.equal(again.platformChanged, false);
      assert.ok(again.chainTx);
      const [s] = await db.select().from(schema.packageSubmissions).where(d.and(d.eq(schema.packageSubmissions.agentId, AGENT_A), d.eq(schema.packageSubmissions.status, "suspended")));
      assert.equal((await reviews(s!.id, "suspend")).length, 1);
    });

    it("if suspendAgent fails, the Solver is already suspended on the platform and the error says so", async () => {
      await suspendSolver(SLUG, { resume: true, port: fake });
      fake.failSuspend = true;
      await assert.rejects(suspendSolver(SLUG, { port: fake }), (e: unknown) => e instanceof SuspendError && /on-chain suspendAgent failed/.test((e as Error).message));
      assert.equal((await agent(AGENT_A)).platformStatus, "suspended");
      fake.failSuspend = false;
      const retry = await suspendSolver(SLUG, { port: fake });
      assert.equal(retry.platformChanged, false);
      assert.ok(retry.chainTx);
    });

    it("resume: approveAgent on-chain, platform_status active, submission back to published", async () => {
      fake.calls.length = 0;
      const r = await suspendSolver(SLUG, { resume: true, reason: "reviewed", port: fake });
      assert.equal(r.action, "resume");
      assert.ok(r.chainTx);
      assert.deepEqual(fake.calls, [`approve:${AGENT_A}`]);
      const a = await agent(AGENT_A);
      assert.equal(a.platformStatus, "active");
      assert.equal(a.status, "active");
      assert.equal((await sub(r.submissionId!)).status, "published");
      assert.equal((await reviews(r.submissionId!, "resume")).length, 2);
    });

    it("finalizing a new version of a Solver suspended by the platform is refused", async () => {
      const S7 = `${PREFIX}-s7`;
      const { approved } = await seed(S7, AGENT_A, SLUG, "1.6.0", 15);
      fake.land("update-version", CREATOR, AGENT_A, approved);
      await db.update(schema.agents).set({ platformStatus: "suspended" }).where(d.eq(schema.agents.id, AGENT_A));
      const r = await finalizePublication(S7);
      assert.equal(r.outcome, "not_ready");
      assert.match(r.outcome === "not_ready" ? r.reason : "", /suspended/);
      await db.update(schema.agents).set({ platformStatus: "active" }).where(d.eq(schema.agents.id, AGENT_A));
    });

    it("unknown Solver: a clear error", async () => {
      await assert.rejects(suspendSolver(`${PREFIX}-missing`, { port: fake }), SuspendError);
    });
  });
});
