// Co-signed publication against a real chain (`anvil --tempo` with the six contracts) and a real database: the creator's
// batch built by the server from the approved record, sent through the sponsoring relay, confirmed by tx hash; then
// `cli:approve`'s path (approveAgent on the admin nonce lane, fee paid by RELAY), the agent Active on-chain and listed
// in the database; then the kill switch on and off (cli:suspend).
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, anvilAvailable, serveRelay, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;
const PREFIX = "pubanvil";
const AGENT = "a7a7a7a7a7a7a7a7a7a7a7a7000a0001";
const SLUG = `${PREFIX}-solver`;
const SUB = `${PREFIX}-s1`;
const MIN_STAKE = 1_000_000n;
const acct = (i: number) => privateKeyToAccount(KEYS[i]!);

describe("co-signed publication on anvil", { skip }, () => {
  let env: AnvilEnv;
  let relay: { url: string; close: () => Promise<void> };
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let d: typeof import("drizzle-orm");
  let chainLib: typeof import("@solvers/chain");
  let port: import("../src/publish/chain-port.js").PublishChain;
  let tx: typeof import("../src/publish/tx.js");
  let approveOnChain: typeof import("../src/publish/approve.js").approveOnChain;
  let suspendSolver: typeof import("../src/publish/suspend.js").suspendSolver;
  const hashes: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "solvers-pubanvil-"));
  const creator = acct(ROLES.creator);
  const creatorAddr = creator.address.toLowerCase();

  const statusOnChain = async () => {
    const { solversRegistryAbi } = await import("@solvers/contracts-client");
    const pc = chainLib.publicClientFor(env.chain, env.rpcUrl);
    return pc.readContract({ address: env.deployment.registry, abi: solversRegistryAbi, functionName: "statusOf", args: [`0x${AGENT}${"0".repeat(32)}`] });
  };
  const balance = (a: Hex) =>
    chainLib.publicClientFor(env.chain, env.rpcUrl).readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  async function cleanup() {
    const t = await db.execute(d.sql`select 1 from pg_trigger where tgname = 'package_reviews_no_update_delete'`);
    const trig = (t as unknown as { rows: unknown[] }).rows.length > 0;
    if (trig) await db.execute(d.sql`alter table package_reviews disable trigger package_reviews_no_update_delete`);
    await db.delete(schema.packageReviews).where(d.inArray(schema.packageReviews.submissionId, [SUB, `agent:${AGENT}`]));
    if (trig) await db.execute(d.sql`alter table package_reviews enable trigger package_reviews_no_update_delete`);
    await db.delete(schema.packageSubmissions).where(d.like(schema.packageSubmissions.id, `${PREFIX}%`));
    await db.delete(schema.agentPublishedVersions).where(d.eq(schema.agentPublishedVersions.agentId, AGENT));
    await db.delete(schema.knowledgeChunks).where(d.eq(schema.knowledgeChunks.agentId, AGENT));
    await db.delete(schema.agentSearchVectors).where(d.eq(schema.agentSearchVectors.agentId, AGENT));
    await db.delete(schema.agents).where(d.eq(schema.agents.id, AGENT));
    await db.delete(schema.creators).where(d.like(schema.creators.id, `${PREFIX}%`));
    await db.delete(schema.sentTxs).where(d.eq(schema.sentTxs.ref, AGENT));
    // A fresh anvil reproduces the same tx hashes: drop what the indexer recorded for them.
    if (hashes.length) {
      await db.delete(schema.processedEvents).where(d.inArray(schema.processedEvents.txHash, hashes));
      await db.delete(schema.chainTxs).where(d.inArray(schema.chainTxs.txHash, hashes));
      await db.delete(schema.indexerFailures).where(d.inArray(schema.indexerFailures.txHash, hashes));
    }
  }

  before(async () => {
    env = await startAnvil({ minStake: MIN_STAKE });
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "31337",
      RPC_URL: env.rpcUrl,
      PLATFORM_PRIVATE_KEY: KEYS[ROLES.platform],
      RELAY_PRIVATE_KEY: KEYS[ROLES.relay],
      VERIFIER_PRIVATE_KEY: KEYS[ROLES.verifier],
      ADMIN_PRIVATE_KEY: KEYS[ROLES.admin],
      TREASURY_ADDRESS: env.deployment.treasury,
      JWT_SECRET: "j".repeat(40),
      SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
      SEARCH_MODE: "fts",
      SUBMISSIONS_DIR: join(root, "submissions"),
      PUBLISHED_DIR: join(root, "packages"),
    });
    delete process.env.TELEGRAM_BOT_TOKEN;
    chainLib = await import("@solvers/chain");
    const chainMod = await import("../src/chain/index.js");
    const a = (i: number) => chainLib.loadAccount(KEYS[i], "K");
    chainMod.setChainContext({
      chain: env.chain,
      deployment: env.deployment,
      publicClient: chainLib.publicClientFor(env.chain, env.rpcUrl),
      accounts: { platform: a(ROLES.platform), relay: a(ROLES.relay), verifier: a(ROLES.verifier), admin: a(ROLES.admin) },
      wallets: {
        platform: chainLib.serverWalletClient(a(ROLES.platform), env.chain, env.rpcUrl),
        verifier: chainLib.serverWalletClient(a(ROLES.verifier), env.chain, env.rpcUrl),
        admin: chainLib.serverWalletClient(a(ROLES.admin), env.chain, env.rpcUrl),
      },
    });
    const d0 = env.deployment;
    const r = chainLib.createSponsorRelay({
      chain: env.chain,
      rpcUrl: env.rpcUrl,
      feePayer: a(ROLES.relay),
      policy: {
        chainId: 31337,
        contracts: [d0.registry, d0.license, d0.credits, d0.reviews, d0.escrow, d0.staking],
        token: d0.token,
        maxGasPerTx: 8_000_000n,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        feeToken: PATH_USD,
      },
    });
    relay = await serveRelay(r.handle);

    ({ db, schema, pool } = await import("../src/db/index.js"));
    d = await import("drizzle-orm");
    port = (await import("../src/publish/chain-port.js")).realPublishChain();
    tx = await import("../src/publish/tx.js");
    ({ approveOnChain } = await import("../src/publish/approve.js"));
    ({ suspendSolver } = await import("../src/publish/suspend.js"));
    const { packageHash } = await import("../src/runtime/packages.js");
    await cleanup();

    // The approved submission as the site leaves it (worker extraction + review approval).
    const dir = join(root, "submissions", SUB, "extracted", SLUG);
    mkdirSync(join(dir, "steps"), { recursive: true });
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    const manifest = {
      id: AGENT,
      slug: SLUG,
      name: "Anvil Solver",
      tagline: "Published on a real chain",
      description: "Co-signed publication test",
      category: "Other",
      version: "1.0.0",
      creator: { id: `${PREFIX}-creator`, name: "Anvil creator", bio: "Bio" },
      requirements: [],
      packageContents: ["a"],
      steps: [{ file: "steps/01-first.md", gate: [] }],
      pricing: { priceUsdc: 10, royaltyBps: 500 },
      supply: { maxLicenses: 25 },
      guarantee: { available: false, defaultCriteria: [] },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "steps", "01-first.md"), "# Step 1\n\nDo it.");
    writeFileSync(join(dir, "knowledge", "a.md"), "Knowledge.");
    const versionHash = packageHash(dir);
    const approved = { versionHash, priceUsdc: "10000000", royaltyBps: 500, name: "Anvil Solver", version: "1.0.0" };
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: creatorAddr, name: "Anvil creator", invited: true });
    await db.insert(schema.packageSubmissions).values({ id: SUB, creatorWallet: creatorAddr, agentId: AGENT, slug: SLUG, version: "1.0.0", status: "awaiting_creator_signature", approved, manifest });
    await db.insert(schema.agentPublishedVersions).values({ agentId: AGENT, version: "1.0.0", versionHash, priceUsdc: 10_000_000n });
    await db.insert(schema.knowledgeChunks).values({ agentId: AGENT, version: `staging:${SUB}`, source: "knowledge/a.md", content: "Knowledge." });
  });

  after(async () => {
    await relay?.close();
    await env?.stop();
    rmSync(root, { recursive: true, force: true });
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  let registerTx: Hex;

  it("the creator signs ONE sponsored batch [approve stake, registerAgent, setSupplyCap] built from the approved record", async () => {
    const plan = await tx.publicationPlan(SUB, creatorAddr, port);
    assert.equal(plan.step, "register-agent");
    assert.equal(plan.register?.stakeUnits, "1000000");

    const built = await tx.buildPublicationTx("register-agent", creatorAddr, SUB, port);
    assert.equal(built.feePayer, true);
    assert.equal(built.chainId, 31337);
    assert.equal(built.calls.length, 3, "approve(staking, minStake) + registerAgent + setSupplyCap");
    assert.equal(built.calls[0]!.to, env.deployment.token.toLowerCase());
    assert.equal(built.calls[1]!.to, env.deployment.registry.toLowerCase());

    const before = await balance(creator.address);
    const wallet = chainLib.relayedWalletClient(creator, env.chain, relay.url, env.rpcUrl);
    registerTx = await chainLib.sendCalls(wallet as never, built.calls as never, { feePayer: true });
    hashes.push(registerTx);
    await chainLib.waitForSuccess(chainLib.publicClientFor(env.chain, env.rpcUrl) as never, registerTx);
    assert.equal(before - (await balance(creator.address)), MIN_STAKE, "the creator pays the stake and no fee (RELAY pays)");
    assert.equal(await statusOnChain(), 0, "Pending on-chain");
  });

  it("confirmation by tx hash: a foreign hash is refused; the right one advances to awaiting_onchain_approval", async () => {
    await assert.rejects(
      tx.confirmPublication({ submissionId: SUB, txHash: `0x${"5".repeat(64)}` }, creatorAddr, port),
      (e: unknown) => (e as { code?: string }).code === "tx_not_for_agent",
    );
    const r = await tx.confirmPublication({ submissionId: SUB, txHash: registerTx, kind: "register-agent" }, creatorAddr, port);
    assert.equal(r.status, "awaiting_onchain_approval");
    assert.equal(r.step, "await-admin-approval");
    const [s] = await db.select().from(schema.packageSubmissions).where(d.eq(schema.packageSubmissions.id, SUB));
    assert.equal(s!.registerTx, registerTx.toLowerCase());
    // The cap travelled in the same batch.
    const st = await port.fetchAgentState(AGENT);
    assert.ok(st.exists && st.maxSupply === 25 && st.creator === creatorAddr);
  });

  it("cli:approve path: approveAgent on the admin lane (RELAY pays), the agent is Active on-chain and listed in the database", async () => {
    const relayBefore = await balance(acct(ROLES.relay).address);
    const adminBefore = await balance(acct(ROLES.admin).address);
    const r = await approveOnChain(SUB, { port, deps: { reload: () => undefined } });
    assert.ok(r.approveTx);
    hashes.push(r.approveTx!);
    assert.deepEqual(r.finalize, { outcome: "published", version: "1.0.0" });
    assert.equal(await statusOnChain(), 1, "Active on-chain");
    assert.equal(await balance(acct(ROLES.admin).address), adminBefore, "the admin key pays nothing (D20)");
    assert.ok((await balance(acct(ROLES.relay).address)) < relayBefore, "RELAY paid the fee");

    const [a] = await db.select().from(schema.agents).where(d.eq(schema.agents.id, AGENT));
    assert.equal(a!.status, "active");
    assert.equal(a!.listed, true);
    assert.equal(a!.slug, SLUG);
    assert.equal(a!.price, 10_000_000n);
    assert.equal(a!.maxLicenses, 25);
    const [sent] = await db.select().from(schema.sentTxs).where(d.and(d.eq(schema.sentTxs.ref, AGENT), d.eq(schema.sentTxs.kind, "admin-approve-agent")));
    assert.equal(sent!.status, "confirmed");
    assert.equal(sent!.lane, 4, "admin nonce lane");
    const [s] = await db.select().from(schema.packageSubmissions).where(d.eq(schema.packageSubmissions.id, SUB));
    assert.equal(s!.status, "published");
    assert.equal(s!.approveTx, r.approveTx);
  });

  it("cli:suspend on and off: platform_status and the on-chain status follow", async () => {
    const off = await suspendSolver(SLUG, { reason: "test", port });
    assert.ok(off.chainTx);
    hashes.push(off.chainTx!);
    assert.equal(await statusOnChain(), 2, "Suspended on-chain");
    let [a] = await db.select().from(schema.agents).where(d.eq(schema.agents.id, AGENT));
    assert.equal(a!.platformStatus, "suspended");
    assert.equal(a!.status, "suspended");

    const on = await suspendSolver(SLUG, { resume: true, port });
    assert.ok(on.chainTx);
    hashes.push(on.chainTx!);
    assert.equal(await statusOnChain(), 1, "Active again");
    [a] = await db.select().from(schema.agents).where(d.eq(schema.agents.id, AGENT));
    assert.equal(a!.platformStatus, "active");
    assert.equal(a!.status, "active");
  });

  it("a reviewed price change carries the creator's pay-per-use price (never a silent 0) and is checked against the record", async () => {
    const { solversRegistryAbi } = await import("@solvers/contracts-client");
    const { decodeFunctionData } = await import("viem");
    const agentId = `0x${AGENT}${"0".repeat(32)}` as Hex;
    const pc = chainLib.publicClientFor(env.chain, env.rpcUrl);
    const wallet = chainLib.relayedWalletClient(creator, env.chain, relay.url, env.rpcUrl);
    // The creator turns credits on (what POST /tx/creator/:id/pricing builds): 2 per use.
    const ppu = await chainLib.sendCalls(wallet as never, chainLib.updatePricingCalls(env.deployment, { agentId, price: 10_000_000n, pricePerUse: 2_000_000n }) as never, { feePayer: true });
    hashes.push(ppu);
    await chainLib.waitForSuccess(pc as never, ppu);

    // The review approves a new price (same version): the next step is update-pricing.
    const SUB2 = `${PREFIX}-s2`;
    const [s1] = await db.select().from(schema.packageSubmissions).where(d.eq(schema.packageSubmissions.id, SUB));
    const approved = { ...(s1!.approved as { versionHash: string; royaltyBps: number; name: string; version: string }), priceUsdc: "12000000" };
    await db.insert(schema.packageSubmissions).values({ id: SUB2, creatorWallet: creatorAddr, agentId: AGENT, slug: SLUG, version: "1.0.0", status: "awaiting_creator_signature", approved, manifest: s1!.manifest });
    assert.equal((await tx.publicationPlan(SUB2, creatorAddr, port)).step, "update-pricing");
    const built = await tx.buildPublicationTx("update-pricing", creatorAddr, SUB2, port);
    assert.equal(built.calls.length, 1);
    const call = decodeFunctionData({ abi: solversRegistryAbi, data: built.calls[0]!.data });
    assert.equal(call.functionName, "updatePricing");
    assert.deepEqual(call.args, [agentId, 12_000_000n, 2_000_000n], "the creator's pay-per-use price travels with the reviewed price");

    const hash = await chainLib.sendCalls(wallet as never, built.calls as never, { feePayer: true });
    hashes.push(hash);
    await chainLib.waitForSuccess(pc as never, hash);
    const st = await port.fetchAgentState(AGENT);
    assert.ok(st.exists && st.price === 12_000_000n && st.pricePerUse === 2_000_000n);
    assert.deepEqual(await port.verifyCreatorTx(hash, AGENT, { creatorWallet: creatorAddr, approved, kind: "pricing" }), { ok: true, kinds: ["pricing"] });
    // Nothing was sold yet, so the royalty is still part of the comparison: a record with 300 bps (chain: 500) asks for
    // update-pricing, whose batch is just setRoyaltyBps.
    const { nextPublicationStep } = await import("../src/publish/approval-rules.js");
    assert.equal(nextPublicationStep({ ...approved, royaltyBps: 300 }, st, creatorAddr), "update-pricing");
    const r2 = await port.buildUpdatePricing(creatorAddr, AGENT, { ...approved, royaltyBps: 300 }, st);
    assert.deepEqual(r2.calls.map((c) => decodeFunctionData({ abi: solversRegistryAbi, data: c.data }).functionName), ["setRoyaltyBps"]);
  });
});
