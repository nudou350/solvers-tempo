// Store routes against a real chain: GET /api/config, /api/tx/confirm (indexes right away), GET /api/license/:id, the
// transfer quote and the royalty transfer, review, claim, creator operations, guarantee builders, balance and faucet.
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
// Rows touched: prefix "storetest" (creator, agent slug) and the wallets of the anvil fixture.
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, anvilAvailable, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;

const AGENT_HEX = "5703e7e5700000000000000000000a01";
const SLUG = "storetest-solver";
const CREATOR_ID = "storetest-creator";
const PRICE = 10_000_000n;
const addr = (i: number) => privateKeyToAccount(KEYS[i]!).address.toLowerCase() as Address;
/** Site admin (ADMIN_WALLETS): reviews on the site, signs nothing on-chain. */
const SITE_ADMIN = "0x00000000000000000000000000000000000000ab";

describe("store routes on a chain", { skip }, () => {
  let env: AnvilEnv;
  let base = "";
  let close: () => Promise<void> = async () => undefined;
  let db: typeof import("../src/db/index.js");
  let chainMod: typeof import("../src/chain/index.js");
  let signSession: (w: string) => Promise<string>;
  const agentId = `0x${AGENT_HEX}${"0".repeat(32)}` as Hex;
  const creator = () => addr(ROLES.creator);
  const buyer = () => addr(ROLES.buyer);
  const buyer2 = () => addr(ROLES.buyer2);

  /** `ip`: client address through the trusted proxy hop (X-Forwarded-For), so a test can use its own per-IP budget of costly routes. */
  const call = async (method: string, path: string, wallet: string | null, body?: unknown, ip?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (wallet) headers.authorization = `Bearer ${await signSession(wallet)}`;
    if (ip) headers["x-forwarded-for"] = ip;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> & { calls?: { to: string; data: Hex }[] } };
  };

  /** Sends calls from an anvil key (self-paid) and confirms them through the API. */
  const sendAs = async (key: number, calls: { to: string; data: Hex }[]) => {
    const { serverWalletClient, sendCalls, waitForSuccess } = await import("@solvers/chain");
    const w = serverWalletClient(privateKeyToAccount(KEYS[key]!), env.chain, env.rpcUrl);
    const hash = await sendCalls(w as never, calls as never);
    await waitForSuccess(chainMod.chainContext().publicClient as never, hash);
    // A fresh anvil repeats the hashes of earlier runs: forget this hash's idempotency rows so it is indexed again.
    const { eq } = await import("drizzle-orm");
    await db.db.delete(db.schema.processedEvents).where(eq(db.schema.processedEvents.txHash, hash.toLowerCase()));
    return hash;
  };

  /** Removes everything this suite writes (its agent id and creator prefix, the fixture wallets' rows): runs before and after, so other anvil suites never meet a leftover row (e.g. a chain_index or creator wallet). */
  const cleanup = async () => {
    const s = db.schema;
    const { eq, inArray } = await import("drizzle-orm");
    const wallets = [creator(), buyer(), buyer2()];
    await db.db.delete(s.licenses).where(eq(s.licenses.agentId, AGENT_HEX));
    await db.db.delete(s.reviewDrafts).where(eq(s.reviewDrafts.agentId, AGENT_HEX));
    await db.db.delete(s.reviews).where(eq(s.reviews.agentId, AGENT_HEX));
    const oldEscrows = await db.db.select({ id: s.escrows.id }).from(s.escrows).where(eq(s.escrows.agentId, AGENT_HEX));
    if (oldEscrows.length) await db.db.delete(s.milestones).where(inArray(s.milestones.escrowId, oldEscrows.map((e) => e.id)));
    await db.db.delete(s.escrows).where(eq(s.escrows.agentId, AGENT_HEX));
    await db.db.delete(s.chainTxs).where(eq(s.chainTxs.agentId, AGENT_HEX));
    await db.db.delete(s.agents).where(eq(s.agents.id, AGENT_HEX));
    await db.db.delete(s.creators).where(eq(s.creators.id, CREATOR_ID));
    await db.db.delete(s.creators).where(eq(s.creators.wallet, creator()));
    await db.db.delete(s.kv).where(inArray(s.kv.key, [`faucet:w:${buyer2()}`, "faucet:ip:::1", "faucet:ip:127.0.0.1", "faucet:ip:::ffff:127.0.0.1"]));
    if (oldEscrows.length) {
      const { or, like } = await import("drizzle-orm");
      await db.db.delete(s.kv).where(or(...oldEscrows.map((e) => like(s.kv.key, `dispute-draft:${e.id}:%`))));
    }
    await db.db.delete(s.userReputation).where(inArray(s.userReputation.wallet, wallets));
    // A fresh anvil restarts the fixture keys' nonces (and repeats tx hashes): drop their journal rows.
    await db.db.delete(s.sentTxs).where(inArray(s.sentTxs.account, [ROLES.admin, ROLES.platform, ROLES.verifier].map(addr)));
  };

  before(async () => {
    env = await startAnvil();
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "31337",
      RPC_URL: env.rpcUrl,
      PAYMENT_TOKEN: PATH_USD,
      PLATFORM_PRIVATE_KEY: KEYS[ROLES.platform],
      RELAY_PRIVATE_KEY: KEYS[ROLES.relay],
      VERIFIER_PRIVATE_KEY: KEYS[ROLES.verifier],
      ADMIN_PRIVATE_KEY: KEYS[ROLES.admin],
      TREASURY_ADDRESS: env.deployment.treasury,
      JWT_SECRET: "j".repeat(40),
      SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
      FAUCET_ENABLED: "true",
      FAUCET_AMOUNT: "3",
      INDEXER_ENABLED: "false",
      ADMIN_WALLETS: SITE_ADMIN,
    });
    chainMod = await import("../src/chain/index.js");
    const { loadAccount, serverWalletClient, publicClientFor } = await import("@solvers/chain");
    const acct = (i: number) => loadAccount(KEYS[i], "K");
    chainMod.setChainContext({
      chain: env.chain,
      deployment: env.deployment,
      publicClient: publicClientFor(env.chain, env.rpcUrl),
      accounts: { platform: acct(ROLES.platform), relay: acct(ROLES.relay), verifier: acct(ROLES.verifier), admin: acct(ROLES.admin) },
      wallets: {
        platform: serverWalletClient(acct(ROLES.platform), env.chain, env.rpcUrl),
        verifier: serverWalletClient(acct(ROLES.verifier), env.chain, env.rpcUrl),
        admin: serverWalletClient(acct(ROLES.admin), env.chain, env.rpcUrl),
      },
    });
    db = await import("../src/db/index.js");
    ({ signSession } = await import("../src/auth/jwt.js"));
    const s = db.schema;
    const { eq, inArray } = await import("drizzle-orm");
    await cleanup();

    // The creator registers (self-paid batch) and the admin approves through the nonce lanes.
    const { publishAgentCalls, approveAgentCalls } = await import("@solvers/chain");
    await sendAs(
      ROLES.creator,
      publishAgentCalls(env.deployment, {
        registration: { agentId, metadataUri: "u", version: "1.0.0", versionHash: keccak256(toBytes("v1")), price: PRICE, pricePerUse: 1_000_000n, royaltyBps: 500 },
        minStake: 0n,
      }),
    );
    const lanes = await import("../src/chain/lanes.js");
    await lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: approveAgentCalls(env.deployment, agentId), kind: "storetest-approve" });

    await db.db.insert(s.creators).values({ id: CREATOR_ID, wallet: creator(), name: "Store Test" });
    await db.db.insert(s.agents).values({
      id: AGENT_HEX,
      slug: SLUG,
      name: "Store Test Solver",
      tagline: "Tests the store",
      description: "d",
      category: "code",
      creatorId: CREATOR_ID,
      chainIndex: 900_001,
      version: "1.0.0",
      versionHash: keccak256(toBytes("v1")),
      price: PRICE,
      pricePerUse: 1_000_000n,
      royaltyBps: 500,
      status: "active",
      listed: true,
    });

    const { createApp } = await import("../src/app.js");
    const { escrowRouter } = await import("../src/store/escrow.js");
    const { creatorTxRouter } = await import("../src/store/creator-tx.js");
    const app = createApp([
      (a) => {
        a.use("/api", escrowRouter);
        a.use("/api", creatorTxRouter);
      },
    ]);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });

  after(async () => {
    await close();
    if (db) await cleanup().catch(() => undefined);
    await db?.pool.end();
    await env?.stop();
  });

  it("GET /api/config: chain, contracts, payment token and the Registry config", async () => {
    const { status, body } = await call("GET", "/api/config", null);
    assert.equal(status, 200);
    const { PublicConfig } = await import("@solvers/shared");
    const cfg = PublicConfig.parse(body);
    assert.equal(cfg.chainId, 31337);
    assert.equal(cfg.contracts.license, env.deployment.license.toLowerCase());
    assert.equal(cfg.paymentToken.address, PATH_USD);
    assert.equal(cfg.feeBps, 1000);
    assert.equal(cfg.royalty.platformBps, 500);
    assert.equal(cfg.minPriceUnits, "5000000");
    assert.equal(cfg.faucetEnabled, true);
    // The server clock (browsers derive validBefore from it, the relay checks against it).
    assert.ok(Math.abs(cfg.serverTime - Math.floor(Date.now() / 1000)) <= 5);
  });

  it("purchase → /api/tx/confirm indexes it; GET /api/license/:id serves the ERC-721 metadata", async () => {
    const { purchaseLicenseCalls } = await import("@solvers/chain");
    const hash = await sendAs(ROLES.buyer, purchaseLicenseCalls(env.deployment, { agentId, price: PRICE, purchaseId: keccak256(toBytes("solvers:v1:storetest-1")) }));
    const { status, body } = await call("POST", "/api/tx/confirm", buyer(), { txHash: hash });
    assert.equal(status, 200);
    assert.equal(body.status, "confirmed");
    const names = (body.events as { name: string }[]).map((e) => e.name);
    assert.ok(names.includes("LicensePurchased"), names.join(","));
    const lic = await call("GET", "/api/me/licenses", buyer());
    assert.deepEqual((lic.body as unknown as { id: string }[]).map((l) => l.id), ["1"]);

    const meta = await call("GET", "/api/license/1", null);
    assert.equal(meta.status, 200);
    assert.match(String(meta.body.name), /license #1/);
    const attrs = meta.body.attributes as { trait_type: string; value: unknown }[];
    assert.equal(attrs.find((a) => a.trait_type === "Original price")?.value, 10);
    assert.equal(attrs.find((a) => a.trait_type === "Agent ID")?.value, AGENT_HEX);
    assert.equal((await call("GET", "/api/license/99", null)).status, 404);
  });

  it("assertCanPurchase: the owner gets already_owned, the creator creator_cannot_buy", async () => {
    const { assertCanPurchase } = await import("../src/store/purchase-guards.js");
    const { findAgentRow } = await import("../src/store/catalog.js");
    const row = await findAgentRow(SLUG);
    await assert.rejects(assertCanPurchase(buyer(), row), (e: { code?: string }) => e.code === "already_owned");
    await assert.rejects(assertCanPurchase(creator(), row), (e: { code?: string }) => e.code === "creator_cannot_buy");
    await assertCanPurchase(buyer2(), row);
  });

  it("transfer quote and royalty transfer: 5% + 5% of the original price, stale quote refused", async () => {
    const q = await call("GET", "/api/me/licenses/1/transfer-quote", buyer());
    assert.equal(q.status, 200);
    assert.equal(q.body.totalUnits, "1000000");
    assert.equal(q.body.creatorAmountUnits, "500000");
    assert.equal((await call("GET", "/api/me/licenses/1/transfer-quote", buyer2())).status, 403);

    const low = await call("POST", "/api/tx/transfer", buyer(), { licenseId: "1", to: buyer2(), maxRoyaltyUnits: "999999" });
    assert.equal(low.status, 409);
    assert.equal(low.body.code, "royalty_changed");

    const tx = await call("POST", "/api/tx/transfer", buyer(), { licenseId: "1", to: buyer2(), maxRoyaltyUnits: "1000000" });
    assert.equal(tx.status, 200);
    assert.equal(tx.body.feePayer, true);
    assert.equal(tx.body.chainId, 31337);
    const [approve, transfer] = tx.body.calls!;
    assert.equal(approve!.to, PATH_USD);
    const [spender, amount] = decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args as [string, bigint];
    assert.equal(spender.toLowerCase(), env.deployment.license.toLowerCase());
    assert.equal(amount, 1_000_000n);
    assert.equal(transfer!.to, env.deployment.license.toLowerCase());

    const hash = await sendAs(ROLES.buyer, tx.body.calls!);
    assert.equal((await call("POST", "/api/tx/confirm", buyer(), { txHash: hash })).body.status, "confirmed");
    const mine = await call("GET", "/api/me/licenses", buyer2());
    assert.deepEqual((mine.body as unknown as { id: string }[]).map((l) => l.id), ["1"]);
  });

  it("review by the new owner: submitReview calls and a draft by content hash", async () => {
    const r = await call("POST", "/api/tx/review", buyer2(), { agentId: AGENT_HEX, rating: 5, text: "great" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.calls!.length, 1);
    assert.equal(r.body.calls![0]!.to, env.deployment.reviews.toLowerCase());
    const { eq } = await import("drizzle-orm");
    const drafts = await db.db.select().from(db.schema.reviewDrafts).where(eq(db.schema.reviewDrafts.authorWallet, buyer2()));
    const { reviewContentHash } = await import("../src/store/review-rules.js");
    assert.equal(drafts[0]?.contentHash, reviewContentHash("great"));
    // The creator never reviews their own Solver.
    assert.equal((await call("POST", "/api/tx/review", creator(), { agentId: AGENT_HEX, rating: 5, text: "" })).status, 403);
  });

  it("claim with nothing held: 409 nothing_to_claim; balance and payouts", async () => {
    const c = await call("POST", "/api/tx/claim", buyer());
    assert.equal(c.status, 409);
    assert.equal(c.body.code, "nothing_to_claim");
    const b = await call("GET", "/api/me/balance", buyer());
    assert.equal(b.body.token, PATH_USD);
    assert.match(String(b.body.units), /^\d+$/);
    assert.deepEqual((await call("GET", "/api/me/payouts", buyer())).body, { totalUnits: "0", contracts: [] });
  });

  it("creator operations: supply cap, royalty locked after the first sale, only the creator", async () => {
    const cap = await call("POST", `/api/tx/creator/${SLUG}/supply-cap`, creator(), { max: 5 });
    assert.equal(cap.status, 200, JSON.stringify(cap.body));
    assert.equal(cap.body.calls![0]!.to, env.deployment.registry.toLowerCase());
    assert.equal((await call("POST", `/api/tx/creator/${SLUG}/supply-cap`, creator(), { max: 0 })).body.code, "supply_invalid");
    const roy = await call("POST", `/api/tx/creator/${SLUG}/royalty`, creator(), { royaltyBps: 300 });
    assert.equal(roy.status, 409);
    assert.equal(roy.body.code, "royalty_locked");
    assert.equal((await call("POST", `/api/tx/creator/${SLUG}/supply-cap`, buyer(), { max: 5 })).status, 403);
    const exit = await call("POST", `/api/tx/creator/${SLUG}/stake/withdraw`, creator());
    assert.equal(exit.body.code, "no_stake_exit");
  });

  it("guarantee builders: release and dispute calls for the buyer, cancel before the deadline refused", async () => {
    const { createEscrowCalls } = await import("@solvers/chain");
    const criteria = keccak256(toBytes("storetest criteria"));
    const hash = await sendAs(
      ROLES.buyer,
      createEscrowCalls(env.deployment, {
        agentId,
        milestones: [{ amount: 6_000_000n, criteriaHash: criteria }],
        reviewWindowSecs: 3600,
        deliveryDays: 0,
        purchaseId: keccak256(toBytes("solvers:v1:storetest-escrow")),
      }),
    );
    assert.equal((await call("POST", "/api/tx/confirm", buyer(), { txHash: hash })).body.status, "confirmed");
    const list = await call("GET", "/api/me/escrows", buyer());
    const escrow = (list.body as unknown as { id: string; status: string }[])[0]!;
    assert.equal(escrow.status, "active");
    const { and, eq } = await import("drizzle-orm");
    await db.db
      .update(db.schema.milestones)
      .set({ criteria: "renders the form" })
      .where(and(eq(db.schema.milestones.escrowId, escrow.id), eq(db.schema.milestones.idx, 0)));

    const rel = await call("POST", `/api/tx/escrow/${escrow.id}/release`, buyer(), { index: 0 });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal(rel.body.calls![0]!.to, env.deployment.escrow.toLowerCase());
    assert.equal((await call("POST", `/api/tx/escrow/${escrow.id}/release`, buyer2(), { index: 0 })).status, 403);

    const bad = await call("POST", `/api/tx/escrow/${escrow.id}/dispute`, buyer(), { index: 0, criterion: "something else", reason: "does not work" });
    assert.equal(bad.body.code, "invalid_criterion");
    const disp = await call("POST", `/api/tx/escrow/${escrow.id}/dispute`, buyer(), { index: 0, criterion: "renders the form", reason: "it does not render" });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));

    const cancel = await call("POST", `/api/tx/escrow/${escrow.id}/cancel-undelivered`, buyer(), { index: 0 });
    assert.equal(cancel.body.code, "cancel_not_allowed");
    const stale = await call("POST", `/api/tx/escrow/${escrow.id}/stale-dispute`, buyer(), { index: 0 });
    assert.equal(stale.body.code, "not_disputed");
  });

  it("dispute texts: drafts per reason hash, nothing on the milestone before the signature; the signed one is promoted", async () => {
    const { and, eq, like } = await import("drizzle-orm");
    const s = db.schema;
    const escrow = ((await call("GET", "/api/me/escrows", buyer(), undefined, "10.0.0.1")).body as unknown as { id: string }[])[0]!;
    const a = await call("POST", `/api/tx/escrow/${escrow.id}/dispute`, buyer(), { index: 0, criterion: "renders the form", reason: "it does not render" }, "10.0.0.1");
    const b = await call("POST", `/api/tx/escrow/${escrow.id}/dispute`, buyer(), { index: 0, criterion: "renders the form", reason: "the button is missing" }, "10.0.0.1");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const drafts = await db.db.select().from(s.kv).where(like(s.kv.key, `dispute-draft:${escrow.id}:0:%`));
    assert.equal(drafts.length, 2, "one draft per reason hash; the second build does not overwrite the first");
    const ms = () => db.db.select().from(s.milestones).where(and(eq(s.milestones.escrowId, escrow.id), eq(s.milestones.idx, 0)));
    assert.equal((await ms())[0]!.disputeReason, null, "nothing on the milestone before the signature");

    // The buyer signs the FIRST build: confirm indexes the dispute and promotes the draft with the on-chain hash.
    const hash = await sendAs(ROLES.buyer, a.body.calls!);
    assert.equal((await call("POST", "/api/tx/confirm", buyer(), { txHash: hash }, "10.0.0.1")).body.status, "confirmed");
    const [m] = await ms();
    assert.equal(m!.status, "disputed");
    assert.equal(m!.disputeCriterion, "renders the form");
    assert.equal(m!.disputeReason, "it does not render");
    assert.equal((await db.db.select().from(s.kv).where(like(s.kv.key, `dispute-draft:${escrow.id}:0:%`))).length, 0, "the other drafts are dropped");
  });

  it("a license id that was never minted: 404, not a 500", async () => {
    const r = await call("GET", "/api/me/licenses/999999/transfer-quote", buyer(), undefined, "10.0.0.2");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    const { licenseOnChain } = await import("../src/store/chain-reads.js");
    assert.equal(await licenseOnChain(999_999n), null);
  });

  it("admin approve on the site signs nothing on-chain: it only relists an agent that is already Active", async () => {
    const { eq, and } = await import("drizzle-orm");
    const s = db.schema;
    assert.equal((await call("POST", `/api/admin/agents/${AGENT_HEX}/approve`, buyer(), undefined, "10.0.0.2")).status, 403);
    await db.db.update(s.agents).set({ listed: false }).where(eq(s.agents.id, AGENT_HEX));
    const r = await call("POST", `/api/admin/agents/${AGENT_HEX}/approve`, SITE_ADMIN, undefined, "10.0.0.2");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.listed, true);
    assert.equal(r.body.txHash, undefined);
    const sent = await db.db.select().from(s.sentTxs).where(and(eq(s.sentTxs.kind, "admin-approve-agent"), eq(s.sentTxs.ref, AGENT_HEX)));
    assert.equal(sent.length, 0, "no approveAgent was sent");
  });

  it("faucet on the local chain: a transfer from the PLATFORM float, then a cooldown", async () => {
    const f = await call("POST", "/api/faucet", buyer2());
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.amountUnits, "3000000");
    assert.match(String(f.body.txHash), /^0x[0-9a-f]{64}$/);
    // 429 either way: the wallet cooldown, or the per-IP limit of costly routes this suite already used up.
    const again = await call("POST", "/api/faucet", buyer2());
    assert.equal(again.status, 429);
    assert.ok(["faucet_cooldown", "rate_limited"].includes(String(again.body.code)));
  });
});
