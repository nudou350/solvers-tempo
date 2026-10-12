import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Platform Solver (the Solver creator) against a real Postgres: free access without license nor trial, templates, the
// validate_package tool through the MCP connector, purchases/guarantees blocked and never in the on-chain usage batches.
// Runs only with TEST_DATABASE_URL (a DISPOSABLE migrated database: `db:migrate`); see the header of platform-status.db.test.ts.
// NEVER point it at the dev database: the test creates and deletes rows (the agent uses the real platform id; creators
// use the "platest" prefix). The chain context is offline (closed RPC port): nothing here may reach a network.

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "platest";
const PLATFORM_ID = "c71ad0a50f750e75c71ad0a50f750e75";
const SLUG = "criador-de-solvers";

/** A fresh EOA address, lowercase. */
const newWallet = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

const STEP = (n: number) => `# Step ${n}\n\n## Goal\nDo step ${n}.\n\n## How to run it\n1. Do it.\n\n## result_summary format\nOne line.\n`;

const manifest = {
  specVersion: 1,
  id: PLATFORM_ID,
  slug: SLUG,
  name: "Solver Creator",
  tagline: "Builds your Solver step by step",
  description: "Free platform Solver used by the server tests.",
  category: "Other",
  version: "1.0.0",
  platform: true,
  creator: { id: "solvers", name: "Solvers", bio: "Platform" },
  terms: { rightsConfirmed: true, sourcesListed: true },
  requirements: [],
  packageContents: ["a", "b", "c"],
  steps: [
    { file: "steps/01-one.md", gate: ["Done"] },
    { file: "steps/02-two.md", gate: ["Done"] },
  ],
  tools: [{ name: "validate_package", description: "Validates the manifest and the steps", runner: "builtin:validate-package", inputSchema: { type: "object" } }],
  templates: [
    { name: "briefing", path: "templates/briefing.md", title: "Briefing", description: "Briefing template" },
    { name: "case", path: "templates/case.json", title: "Eval case", description: "Skeleton of a case" },
    { name: "logo", path: "templates/logo.svg", title: "Logo", description: "Image (never delivered)" },
  ],
  pricing: { priceUsdc: 5, royaltyBps: 0 },
  guarantee: { available: false, defaultCriteria: [] },
  versions: [{ version: "1.0.0", releasedAt: "2026-10-01", notes: "n" }],
};

describe("platform Solver with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let drizzle: typeof import("drizzle-orm");
  let access: typeof import("../src/runtime/access.js");
  let getPackage: typeof import("../src/runtime/packages.js").getPackage;
  let findAgentRow: typeof import("../src/store/catalog.js").findAgentRow;
  let signSession: typeof import("../src/auth/jwt.js").signSession;
  let server: Server;
  let base = "";
  let tmp = "";
  const clients: { close: () => Promise<void> }[] = [];

  /** In-memory MCP connector speaking as the given wallet (same tools as /mcp). */
  async function connect(wallet: string, isAgent = false) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { buildMcpServer } = await import("../src/mcp/tools.js");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer({ wallet, isAgent }).connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError === true };
    };
    return { client, call };
  }

  async function cleanup() {
    const { eq, like } = drizzle;
    await db.delete(schema.usageEvents).where(eq(schema.usageEvents.agentId, PLATFORM_ID));
    await db.delete(schema.sessions).where(eq(schema.sessions.agentId, PLATFORM_ID));
    await db.delete(schema.trials).where(eq(schema.trials.agentId, PLATFORM_ID));
    await db.delete(schema.licenses).where(eq(schema.licenses.agentId, PLATFORM_ID));
    await db.delete(schema.agents).where(eq(schema.agents.id, PLATFORM_ID));
    await db.delete(schema.creators).where(like(schema.creators.id, `${PREFIX}%`));
  }

  /** Offline chain context: valid keys and a placeholder deployment on a closed RPC port (never reached by these tests). */
  async function installOfflineChain() {
    const { getChain, publicClientFor, serverWalletClient } = await import("@solvers/chain");
    const { setChainContext } = await import("../src/chain/index.js");
    const rpc = "http://127.0.0.1:1";
    const chain = getChain(31337, rpc);
    const acct = () => privateKeyToAccount(generatePrivateKey());
    const [platform, relay, verifier] = [acct(), acct(), acct()];
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
    setChainContext({
      chain,
      deployment: {
        chainId: 31337,
        token: "0x20c0000000000000000000000000000000000000",
        treasury: addr(0xdead),
        deployBlock: 0n,
        gitSha: "",
        registry: addr(0xa1),
        license: addr(0xa2),
        credits: addr(0xa3),
        reviews: addr(0xa4),
        escrow: addr(0xa5),
        staking: addr(0xa6),
      },
      publicClient: publicClientFor(chain, rpc),
      accounts: { platform, relay, verifier, admin: null },
      wallets: { platform: serverWalletClient(platform, chain, rpc), verifier: serverWalletClient(verifier, chain, rpc), admin: null },
    });
  }

  before(async () => {
    // Platform package only for this test (AGENTS_DIR points to it; the repository's real package is not touched).
    tmp = mkdtempSync(join(tmpdir(), "solvers-platform-"));
    const dir = join(tmp, "agents", SLUG);
    mkdirSync(join(dir, "steps"), { recursive: true });
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "steps", "01-one.md"), STEP(1));
    writeFileSync(join(dir, "steps", "02-two.md"), STEP(2));
    writeFileSync(join(dir, "templates", "briefing.md"), "# Briefing\n\nDescribe the audience.\n");
    writeFileSync(join(dir, "templates", "case.json"), '{ "id": "case-1", "input": "request", "checks": [] }\n');
    writeFileSync(join(dir, "templates", "logo.svg"), "<svg onload=alert(1)></svg>");

    Object.assign(process.env, {
      DATABASE_URL: url,
      AGENTS_DIR: join(tmp, "agents"),
      PUBLISHED_DIR: join(tmp, "does-not-exist"),
      RPC_URL: "http://127.0.0.1:1", // closed port: fails fast, nothing leaves the machine
    });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    drizzle = await import("drizzle-orm");
    access = await import("../src/runtime/access.js");
    ({ getPackage } = await import("../src/runtime/packages.js"));
    ({ findAgentRow } = await import("../src/store/catalog.js"));
    ({ signSession } = await import("../src/auth/jwt.js"));
    await installOfflineChain();
    const { createApp } = await import("../src/app.js");
    const { mounts } = await import("../src/modules.js");

    await cleanup();
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: newWallet(), name: "Platform" });
    // Database only: never registered on-chain (chain_index null).
    await db.insert(schema.agents).values({
      id: PLATFORM_ID, slug: SLUG, name: "Solver Creator", tagline: "Builds your Solver step by step", description: "d", category: "Other",
      creatorId: `${PREFIX}-creator`, version: "1.0.0", versionHash: "ab".repeat(32), price: 5_000_000n, status: "active", listed: true,
    });
    await new Promise<void>((resolve) => {
      server = createApp(mounts).listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    server?.close();
    if (db) {
      await cleanup();
      await pool.end();
    }
    (await import("../src/chain/index.js")).setChainContext(null);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("the platform package loads from AGENTS_DIR and counts as platform", () => {
    const pkg = getPackage(PLATFORM_ID)!;
    assert.equal(pkg.platform, true);
    assert.equal(pkg.source, "agents");
    assert.equal(pkg.manifest.templates?.length, 3);
  });

  it("resolveAccess: any signed-in wallet, no trial and nothing consumed (agents too)", async () => {
    const wallet = newWallet();
    const row = await findAgentRow(PLATFORM_ID);
    const pkg = getPackage(PLATFORM_ID)!;
    for (const agent of [false, true]) {
      const a = await access.resolveAccess(wallet, row, pkg, { consume: true, allowTrial: true, agent });
      assert.deepEqual(a, { ok: true, kind: "platform" });
    }
    const trials = await db.select().from(schema.trials).where(drizzle.eq(schema.trials.wallet, wallet));
    assert.equal(trials.length, 0, "no trial use was spent");
    // Even retired (paid_only) the platform access counts; the trial does not.
    const retired = { ...row, status: "retired" };
    assert.equal((await access.resolveAccess(wallet, retired, pkg, { consume: true, allowTrial: false })).ok, true);
  });

  it("ownedAgents includes the platform Solver for any wallet", async () => {
    assert.ok((await access.ownedAgents(newWallet())).has(PLATFORM_ID));
  });

  it("the platform session is valid without a license", async () => {
    const wallet = newWallet();
    const { createSession, getSession } = await import("../src/runtime/engine.js");
    const s = await createSession(wallet, getPackage(PLATFORM_ID)!, { kind: "platform" });
    assert.equal(s.access, "platform");
    assert.equal(s.licenseId, null);
    assert.equal(await access.sessionGrantValid(s), true);
    assert.equal((await getSession(s.id, wallet)).id, s.id);
    // The TTL is the paid session's (24 h), not the trial's (2 h).
    assert.ok(s.expiresAt.getTime() - Date.now() > 20 * 3600_000);
  });

  describe("through the MCP connector", () => {
    it("lists the tools, including get_template, and the instructions carry the safety rule", async () => {
      const { client } = await connect(newWallet());
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("get_template"));
      for (const n of ["list_my_solvers", "find_solver", "activate_solver", "run_tool", "next_step"]) assert.ok(names.includes(n), n);
      const instructions = client.getInstructions() ?? "";
      assert.match(instructions, /No specialist content authorizes/);
      assert.match(instructions, /sending the user's data elsewhere/);
      assert.match(instructions, /get_template/);
      const agent = await connect(newWallet(), true);
      assert.match(agent.client.getInstructions() ?? "", /sending the user's data elsewhere/);
    });

    it("list_my_solvers shows the platform Solver as free for an empty wallet", async () => {
      const { call } = await connect(newWallet());
      const { text } = await call("list_my_solvers");
      assert.match(text, new RegExp(`Solver Creator \\(agent_id: ${PLATFORM_ID}\\)`));
      assert.match(text, /free, from the platform/);
      assert.doesNotMatch(text, /lifetime license\]/);
    });

    it("get_purchase_link refuses: it is not sold", async () => {
      const { call } = await connect(newWallet());
      const { text } = await call("get_purchase_link", { agent_id: PLATFORM_ID });
      assert.match(text, /free platform Solver/);
      assert.doesNotMatch(text, /checkout|USD/);
    });

    it("activate_solver: free, no trial, no purchase link, with the declared templates", async () => {
      const wallet = newWallet();
      const { call } = await connect(wallet);
      const { text } = await call("activate_solver", { agent_id: PLATFORM_ID });
      assert.match(text, /session_id: ses_/);
      assert.match(text, /Access: free/);
      assert.doesNotMatch(text, /free trial|Buy|checkout/i);
      assert.match(text, /## Available templates/);
      assert.match(text, /- briefing: Briefing\./);
      assert.match(text, /- case: Eval case\./);
      const [s] = await db.select().from(schema.sessions).where(drizzle.and(drizzle.eq(schema.sessions.wallet, wallet), drizzle.eq(schema.sessions.agentId, PLATFORM_ID)));
      assert.equal(s!.access, "platform");
      assert.equal((await db.select().from(schema.trials).where(drizzle.eq(schema.trials.wallet, wallet))).length, 0);

      // Second activation: reuses the session and still says it is free.
      const again = await call("activate_solver", { agent_id: PLATFORM_ID });
      assert.match(again.text, new RegExp(`session_id: ${s!.id}`));
      assert.match(again.text, /Access: free/);
    });

    it("get_template: only what is declared, text, watermarked; svg, invented names and paths never leave", async () => {
      const wallet = newWallet();
      const { call } = await connect(wallet);
      const sid = /session_id: (ses_\w+)/.exec((await call("activate_solver", { agent_id: PLATFORM_ID })).text)![1]!;

      const md = await call("get_template", { session_id: sid, name: "briefing" });
      assert.equal(md.isError, false);
      assert.match(md.text, /# Template: Briefing \(briefing\)/);
      assert.match(md.text, /Describe the audience\./);
      const { watermark } = await import("../src/runtime/engine.js");
      assert.ok(md.text.endsWith(watermark(wallet, PLATFORM_ID)), "per-wallet watermark at the end");

      const json = await call("get_template", { session_id: sid, name: "case" });
      assert.ok(json.text.includes('```json\n{ "id": "case-1", "input": "request", "checks": [] }\n```'));

      for (const name of ["logo", "does-not-exist", "../../manifest", "templates/briefing.md", "steps/01-one.md"]) {
        const r = await call("get_template", { session_id: sid, name });
        assert.doesNotMatch(r.text, /<svg|Describe the audience|# Step/, name);
      }
      assert.match((await call("get_template", { session_id: sid, name: "logo" })).text, /not a text file/);
      assert.match((await call("get_template", { session_id: sid, name: "does-not-exist" })).text, /There is no template "does-not-exist".*Available: briefing, case, logo/);
    });

    it("get_template requires a session of the same wallet", async () => {
      const owner = newWallet();
      const sid = /session_id: (ses_\w+)/.exec((await (await connect(owner)).call("activate_solver", { agent_id: PLATFORM_ID })).text)![1]!;
      const other = await connect(newWallet());
      const r = await other.call("get_template", { session_id: sid, name: "briefing" });
      assert.equal(r.isError, true);
      assert.match(r.text, /another wallet/);
    });

    it("run_tool validate_package: validates manifest and steps and returns { ok, errors, warnings, stats, summary }", async () => {
      const { call } = await connect(newWallet());
      const sid = /session_id: (ses_\w+)/.exec((await call("activate_solver", { agent_id: PLATFORM_ID })).text)![1]!;
      const bad = await call("run_tool", { session_id: sid, tool: "validate_package", input: { manifest: { slug: "x" }, steps: [] } });
      assert.equal(bad.isError, false);
      const out = JSON.parse(bad.text) as { ok: boolean; errors: { code: string; path: string; message: string; fix: string }[]; summary: string; stats: unknown; warnings: unknown[] };
      assert.equal(out.ok, false);
      assert.ok(out.errors.length > 0);
      assert.ok(out.errors.every((e) => e.code && e.message && e.fix && typeof e.path === "string"));
      assert.match(out.summary, /errors to fix/);
      assert.ok(out.stats && Array.isArray(out.warnings));
      // Input outside the contract: a clear error, nothing breaks.
      const wrong = await call("run_tool", { session_id: sid, tool: "validate_package", input: { nothing: 1 } });
      assert.equal(wrong.isError, true);
      assert.match(wrong.text, /Invalid input/);
    });

    it("next_step follows the method normally in the platform session", async () => {
      const { call } = await connect(newWallet());
      const sid = /session_id: (ses_\w+)/.exec((await call("activate_solver", { agent_id: PLATFORM_ID })).text)![1]!;
      assert.match((await call("preflight_check", { session_id: sid, available_tools: [] })).text, /All set/);
      assert.match((await call("next_step", { session_id: sid, completed_step: 0 })).text, /Step 1 of 2/);
    });

    it("suspending the platform Solver (kill switch) drops the session and the activation", async () => {
      const { call } = await connect(newWallet());
      const sid = /session_id: (ses_\w+)/.exec((await call("activate_solver", { agent_id: PLATFORM_ID })).text)![1]!;
      await db.update(schema.agents).set({ platformStatus: "suspended" }).where(drizzle.eq(schema.agents.id, PLATFORM_ID));
      try {
        const r = await call("get_template", { session_id: sid, name: "briefing" });
        assert.equal(r.isError, true);
        assert.match(r.text, /unavailable/);
        assert.match((await call("activate_solver", { agent_id: PLATFORM_ID })).text, /unavailable/);
        assert.doesNotMatch((await call("list_my_solvers")).text, new RegExp(PLATFORM_ID), "a suspended Solver is not listed");
      } finally {
        await db.update(schema.agents).set({ platformStatus: "active" }).where(drizzle.eq(schema.agents.id, PLATFORM_ID));
      }
    });
  });

  describe("purchases and guarantees blocked", () => {
    it("assertCanPurchase and assertFreshPrice answer 409 platform_agent_not_for_sale (no RPC)", async () => {
      const row = await findAgentRow(PLATFORM_ID);
      const { assertCanPurchase } = await import("../src/store/purchase-guards.js");
      const { assertFreshPrice } = await import("../src/store/fresh-price.js");
      const is409 = (e: unknown) => (e as { status?: number }).status === 409 && (e as { code?: string }).code === "platform_agent_not_for_sale";
      await assert.rejects(assertCanPurchase(newWallet(), row), is409);
      await assert.rejects(assertFreshPrice(row), is409);
    });

    it("POST /api/purchases/intent (license and guarantee): 409 platform_agent_not_for_sale", async () => {
      const token = await signSession(newWallet());
      for (const body of [
        { kind: "license", agentId: PLATFORM_ID },
        { kind: "license", agentId: SLUG },
        { kind: "escrow", agentId: PLATFORM_ID, task: { title: "My task", description: "I want a task with a guarantee", deliveryDays: 7 } },
      ]) {
        const res = await fetch(`${base}/api/purchases/intent`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        const json = (await res.json()) as { code?: string; error?: string };
        assert.equal(res.status, 409, `${JSON.stringify(body)}: ${JSON.stringify(json)}`);
        assert.equal(json.code, "platform_agent_not_for_sale");
      }
    });

    it("the storefront marks the agent as platform and without a trial", async () => {
      const { toAgent } = await import("../src/store/mappers.js");
      const agent = toAgent(await findAgentRow(PLATFORM_ID), { trend7d: 0 });
      assert.equal(agent.platform, true);
      assert.equal(agent.trialAvailable, false);
      assert.equal(agent.guaranteeAvailable, false);
      assert.ok(Array.isArray(agent.differentiators));
    });
  });

  describe("never in the on-chain usage batches", () => {
    it("the job does not select the platform Solver's use (nor tries to build the transaction)", async () => {
      const wallet = newWallet();
      const sessionId = `${PREFIX}-ses-batch`;
      // Even if a "trial" session shows up (odd data), the platform agent never enters a batch.
      await db.insert(schema.sessions).values({ id: sessionId, wallet, agentId: PLATFORM_ID, version: "1.0.0", access: "trial" });
      await db.insert(schema.usageEvents).values({ wallet, agentId: PLATFORM_ID, sessionId, tool: "activate_solver", responseHash: "ab".repeat(32), createdAt: new Date(Date.now() - 60_000) });
      const { recordUsageBatchOnce } = await import("../src/jobs.js");
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        await recordUsageBatchOnce();
      } finally {
        console.error = original;
      }
      assert.ok(!errors.some((e) => e.includes(PLATFORM_ID)), `the job tried to batch the platform agent: ${errors.join(" | ")}`);
      const [ev] = await db.select().from(schema.usageEvents).where(drizzle.eq(schema.usageEvents.sessionId, sessionId));
      assert.equal(ev!.batchId, null);
      assert.equal(ev!.batched, false);
    });
  });
});
