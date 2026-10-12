// Indexer end to end (D9) on `anvil --tempo` with the six contracts and the disposable test database.
// Needs TEST_DATABASE_URL (migrated; container solvers-tempo-pg on 5546) and `anvil` (Foundry).
//
// Isolation on the shared test DB: a random agent id, random buyer/creator wallets, license and escrow ids moved to a
// random high range (anvil_setStorageAt on the counters), its own kv cursor key; everything is deleted at the end.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, keccak256, parseAbi, toBytes, toHex, type Address, type Hex, type Log } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, anvilAvailable, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;

const PRICE = 10_000_000n;
const PER_USE = 1_000_000n;
const TIP403 = "0x403c000000000000000000000000000000000000" as Address;
const tip403Abi = parseAbi([
  "function policyIdCounter() view returns (uint64)",
  "function createPolicy(address admin, uint8 policyType) returns (uint64)",
  "function modifyPolicyWhitelist(uint64 policyId, address account, bool allowed)",
  "function setReceivePolicy(uint64 senderPolicyId, uint64 tokenFilterId, address recoveryAuthority)",
]);
// ERC-7201 roots (first field = the id counter) of SolversLicense and SolversEscrow.
const LICENSE_STORAGE = "0x3a30cef44f7755833df2e19d37b371e39266205f853e05a67bf123426e8fde00" as Hex;
const ESCROW_STORAGE = "0x34214e68b974a499e6e40726e1f62f10ad1aaf1ff9aea2ee226dd1443e772300" as Hex;
const GUARDIAN_ROLE = keccak256(toBytes("GUARDIAN_ROLE"));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const lc = (a: string) => a.toLowerCase();
/** DB form of a version hash: 64 lowercase hex without 0x. */
const db32 = (h: string) => h.toLowerCase().replace(/^0x/, "");

describe("indexer on anvil --tempo", { skip }, () => {
  let env: AnvilEnv;
  let chain: typeof import("@solvers/chain");
  let dbm: typeof import("../src/db/index.js");
  let poller: typeof import("../src/indexer/poller.js");
  let processor: typeof import("../src/indexer/processor.js");
  let ctxMod: typeof import("../src/chain/index.js");
  let drizzle: typeof import("drizzle-orm");

  const AGENT_DB_ID = randomBytes(16).toString("hex");
  let AGENT: Hex;
  const V1 = keccak256(toBytes(`v1-${AGENT_DB_ID}`));
  const V2 = keccak256(toBytes(`v2-${AGENT_DB_ID}`));
  const KEY = `indexer:evm:test:${AGENT_DB_ID}`;
  const creator = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const buyer2 = privateKeyToAccount(generatePrivateKey());
  const receiver = privateKeyToAccount(generatePrivateKey());
  const guardian = privateKeyToAccount(generatePrivateKey()).address;
  const platform = privateKeyToAccount(KEYS[ROLES.platform]!);
  const verifier = privateKeyToAccount(KEYS[ROLES.verifier]!);
  const admin = privateKeyToAccount(KEYS[ROLES.admin]!);
  const myWallets = [creator, buyer, buyer2, receiver].map((a) => lc(a.address));
  const REVIEW_TEXT = `Solid work ${AGENT_DB_ID}`;

  const sales: import("../src/payments/hooks.js").SaleAuthorizedEvent[] = [];
  const governance: import("../src/indexer/governance.js").GovernanceChange[] = [];
  let startBlock = 0n;
  let token1 = 0n;
  let token2 = 0n;
  let escrowA = 0n;
  let escrowB = 0n;
  let mintTx1: Hex;

  const pc = () => ctxMod.chainContext().publicClient;
  async function send(from: PrivateKeyAccount, calls: { to: Address; data: Hex }[]) {
    const w = chain.serverWalletClient(from, env.chain, env.rpcUrl);
    const receipt = await chain.waitForSuccess(pc() as never, await chain.sendCalls(w as never, calls));
    return receipt;
  }
  const call = (to: Address, abi: readonly unknown[], functionName: string, args: unknown[]) => ({
    to,
    data: encodeFunctionData({ abi, functionName, args } as never),
  });
  const eventsOf = (logs: Log[]) => chain.parseSolversEvents(logs, env.deployment);
  const argOf = (logs: Log[], name: string, field: string) => {
    const ev = eventsOf(logs).find((e) => e.eventName === name);
    assert.ok(ev, `${name} emitted`);
    return (ev.args as Record<string, unknown>)[field];
  };
  const pid = (s: string) => keccak256(toBytes(`solvers:v1:indexer-test:${AGENT_DB_ID}:${s}`));

  before(async () => {
    env = await startAnvil();
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
      TELEGRAM_BOT_TOKEN: "",
    });
    chain = await import("@solvers/chain");
    drizzle = await import("drizzle-orm");
    ctxMod = await import("../src/chain/index.js");
    const acct = (i: number) => chain.loadAccount(KEYS[i], "K");
    ctxMod.setChainContext({
      chain: env.chain,
      deployment: env.deployment,
      publicClient: chain.publicClientFor(env.chain, env.rpcUrl),
      accounts: { platform: acct(ROLES.platform), relay: acct(ROLES.relay), verifier: acct(ROLES.verifier), admin: acct(ROLES.admin) },
      wallets: {
        platform: chain.serverWalletClient(acct(ROLES.platform), env.chain, env.rpcUrl),
        verifier: chain.serverWalletClient(acct(ROLES.verifier), env.chain, env.rpcUrl),
        admin: chain.serverWalletClient(acct(ROLES.admin), env.chain, env.rpcUrl),
      },
    });
    dbm = await import("../src/db/index.js");
    poller = await import("../src/indexer/poller.js");
    processor = await import("../src/indexer/processor.js");
    const hooks = await import("../src/payments/hooks.js");
    hooks.setSaleAuthorizedHandler(async (e) => {
      sales.push(e);
    });
    (await import("../src/indexer/governance.js")).onGovernanceChange((g) => {
      governance.push(g);
    });
    const { agentIdToBytes32 } = await import("@solvers/shared");
    AGENT = agentIdToBytes32(AGENT_DB_ID);
    const d = env.deployment;

    // License and escrow ids in a random high range, so rows keyed by id never collide with other tests on the shared DB.
    const base = 1_000_000_000_000n + BigInt(randomBytes(5).readUIntBE(0, 5)) * 1000n;
    for (const [addr, slot] of [
      [d.license, LICENSE_STORAGE],
      [d.escrow, ESCROW_STORAGE],
    ] as const) {
      await pc().request({ method: "anvil_setStorageAt", params: [addr, slot, toHex(base, { size: 32 })] } as never);
    }

    // Fund the random wallets (fees and purchases are paid in pathUSD).
    const funder = privateKeyToAccount(KEYS[ROLES.buyer]!);
    const fund = await send(
      funder,
      myWallets.map((w) => call(PATH_USD, erc20Abi, "transfer", [w, 200_000_000n])),
    );
    startBlock = fund.blockNumber;

    // The approved version (review) the chain is checked against; the review draft the indexer publishes.
    await dbm.db.insert(dbm.schema.agentPublishedVersions).values({ agentId: AGENT_DB_ID, version: "1.0.0", versionHash: db32(V1), priceUsdc: PRICE });
    await dbm.db.insert(dbm.schema.reviewDrafts).values({ agentId: AGENT_DB_ID, authorWallet: lc(buyer2.address), contentHash: sha(REVIEW_TEXT), rating: 4, text: REVIEW_TEXT });

    // 1. creator registers (cap 10), admin approves
    await send(
      creator,
      chain.publishAgentCalls(d, {
        registration: { agentId: AGENT, metadataUri: "https://api.test/a.json", version: "1.0.0", versionHash: V1, price: PRICE, pricePerUse: PER_USE, royaltyBps: 500 },
        minStake: 0n,
        maxSupply: 10,
      }),
    );
    await send(admin, chain.approveAgentCalls(d, AGENT));

    // 2. direct purchase (buyer) and platform purchase for buyer2
    const r1 = await send(buyer, chain.purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId: pid("l1") }));
    token1 = argOf(r1.logs, "LicensePurchased", "tokenId") as bigint;
    mintTx1 = lc(r1.transactionHash) as Hex;
    const r2 = await send(platform, chain.purchaseLicenseForCalls(d, { buyer: buyer2.address, agentId: AGENT, price: PRICE, purchaseId: pid("l2") }));
    token2 = argOf(r2.logs, "LicensePurchased", "tokenId") as bigint;
    assert.ok(token1 > base && token2 === token1 + 1n);

    // 3. transfer with royalty buyer -> receiver (5% + 5% of the original price)
    await send(buyer, chain.transferWithRoyaltyCalls(d, { to: receiver.address, tokenId: token1, maxRoyalty: 1_000_000n }));

    // 4. credits (5 × 1 USD)
    await send(buyer, chain.buyCreditsCalls(d, { agentId: AGENT, amount: 5, maxTotal: 5n * PER_USE, purchaseId: pid("c1") }));

    // 5. reviews: buyer2 with license 2 (draft text), receiver with the transferred license 1 (no draft)
    await send(buyer2, chain.submitReviewCalls(d, { agentId: AGENT, tokenId: token2, rating: 4, contentHash: `0x${sha(REVIEW_TEXT)}` }));
    await send(receiver, chain.submitReviewCalls(d, { agentId: AGENT, tokenId: token1, rating: 5, contentHash: keccak256(toBytes("onchain-only")) }));

    // 6. escrow A (buyer): pass + release milestone 0, dispute + refund milestone 1
    const rA = await send(
      buyer,
      chain.createEscrowCalls(d, {
        agentId: AGENT,
        milestones: [
          { amount: 3_000_000n, criteriaHash: keccak256(toBytes("m0")) },
          { amount: 4_000_000n, criteriaHash: keccak256(toBytes("m1")) },
        ],
        reviewWindowSecs: 3600,
        deliveryDays: 0,
        purchaseId: pid("e1"),
      }),
    );
    escrowA = argOf(rA.logs, "EscrowCreated", "escrowId") as bigint;
    await send(verifier, chain.markPassedCalls(d, { escrowId: escrowA, index: 0, deliverableHash: keccak256(toBytes("deliv")) }));
    await send(buyer, chain.releaseMilestoneCalls(d, { escrowId: escrowA, index: 0 }));
    await send(buyer, chain.openDisputeCalls(d, { escrowId: escrowA, index: 1, reasonHash: keccak256(toBytes("bad")) }));
    await send(admin, chain.resolveDisputeCalls(d, { escrowId: escrowA, index: 1, refund: true }));

    // 7. escrow B for buyer2 (platform float); buyer2 refuses incoming transfers, so the refund is deferred, then claimed
    const rB = await send(
      platform,
      chain.createEscrowForCalls(d, {
        buyer: buyer2.address,
        agentId: AGENT,
        milestones: [{ amount: 5_000_000n, criteriaHash: keccak256(toBytes("b0")) }],
        reviewWindowSecs: 3600,
        deliveryDays: 0,
        purchaseId: pid("e2"),
      }),
    );
    escrowB = argOf(rB.logs, "EscrowCreated", "escrowId") as bigint;
    const policyId = (await pc().readContract({ address: TIP403, abi: tip403Abi, functionName: "policyIdCounter" })) as bigint;
    await send(buyer2, [call(TIP403, tip403Abi, "createPolicy", [buyer2.address, 0])]);
    await send(buyer2, [call(TIP403, tip403Abi, "setReceivePolicy", [policyId, 1n, "0x0000000000000000000000000000000000000000"])]);
    await send(buyer2, chain.openDisputeCalls(d, { escrowId: escrowB, index: 0, reasonHash: keccak256(toBytes("never delivered")) }));
    const rRefund = await send(admin, chain.resolveDisputeCalls(d, { escrowId: escrowB, index: 0, refund: true }));
    assert.ok(eventsOf(rRefund.logs).some((e) => e.eventName === "PayoutDeferred"), "the refund to a blocked wallet is deferred");
    await send(buyer2, [call(TIP403, tip403Abi, "modifyPolicyWhitelist", [policyId, d.escrow, true])]);
    await send(buyer2, chain.claimCalls(d.escrow));

    // 8. governance (unique: a random guardian) and an unreviewed version change by the creator
    await send(admin, [call(d.registry, [{ type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "role" }, { type: "address", name: "account" }], outputs: [] }], "grantRole", [GUARDIAN_ROLE, guardian])]);
    await send(creator, chain.updateVersionCalls(d, { agentId: AGENT, version: "1.1.0", versionHash: V2 }));
  });

  after(async () => {
    if (dbm) {
      const s = dbm.schema;
      const { eq, inArray } = drizzle;
      const logs = env ? await pc().getLogs({ address: Object.values({ ...env.deployment }).filter((v): v is Address => typeof v === "string" && v.startsWith("0x") && v.length === 42), fromBlock: startBlock }) : [];
      const hashes = [...new Set(logs.map((l) => lc(l.transactionHash!)))];
      const escrowIds = [escrowA, escrowB].filter((x) => x > 0n).map(String);
      if (hashes.length) {
        await dbm.db.delete(s.processedEvents).where(inArray(s.processedEvents.txHash, hashes));
        await dbm.db.delete(s.chainTxs).where(inArray(s.chainTxs.txHash, hashes));
        await dbm.db.delete(s.indexerFailures).where(inArray(s.indexerFailures.txHash, hashes));
      }
      if (escrowIds.length) await dbm.db.delete(s.milestones).where(inArray(s.milestones.escrowId, escrowIds));
      for (const t of [s.escrows, s.licenses, s.credits, s.reviews, s.reviewDrafts, s.agentPublishedVersions] as const) {
        await dbm.db.delete(t).where(eq(t.agentId, AGENT_DB_ID));
      }
      await dbm.db.delete(s.agents).where(eq(s.agents.id, AGENT_DB_ID));
      await dbm.db.delete(s.userReputation).where(inArray(s.userReputation.wallet, myWallets));
      await dbm.db.delete(s.payoutsDeferred).where(inArray(s.payoutsDeferred.recipient, myWallets));
      await dbm.db.delete(s.kv).where(eq(s.kv.key, KEY));
      await dbm.pool.end();
    }
    await env?.stop();
  });

  const poll = (o: Partial<import("../src/indexer/poller.js").PollOptions> = {}) =>
    poller.pollOnce({ cursorKey: KEY, startBlock, confirmations: 0, batch: 4, maxRanges: 10_000, retry: false, ...o });

  async function counts() {
    const { eq, sql } = drizzle;
    const s = dbm.schema;
    const [tx] = await dbm.db.select({ n: sql<number>`count(*)::int` }).from(s.chainTxs).where(eq(s.chainTxs.agentId, AGENT_DB_ID));
    const [lic] = await dbm.db.select({ n: sql<number>`count(*)::int` }).from(s.licenses).where(eq(s.licenses.agentId, AGENT_DB_ID));
    const [ms] = await dbm.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.milestones)
      .where(drizzle.inArray(s.milestones.escrowId, [String(escrowA), String(escrowB)]));
    return { tx: tx!.n, lic: lic!.n, ms: ms!.n };
  }

  it("mirrors every flow from the logs (agents, licenses, credits, reviews, escrows, reputation, chain_txs, deferred)", async () => {
    const res = await poll();
    assert.equal(res.failedTxs, 0, "no failed transaction");
    assert.ok(res.ranges > 1, "the range was scanned in several chunks");
    assert.ok(res.applied > 20 && res.applied === res.events, `all ${res.events} events applied once`);
    const latest = await pc().getBlockNumber({ cacheTime: 0 });
    const cur = await poller.readCursor(KEY);
    assert.equal(cur?.block, latest);
    assert.equal(cur?.blockHash, lc((await pc().getBlock({ blockNumber: latest })).hash));

    const { eq, and } = drizzle;
    const s = dbm.schema;
    const [agent] = await dbm.db.select().from(s.agents).where(eq(s.agents.id, AGENT_DB_ID));
    assert.ok(agent, "agent row created from the chain");
    assert.equal(agent.status, "active");
    assert.equal(agent.totalSales, 2n);
    assert.equal(agent.maxLicenses, 10);
    assert.equal(agent.ratingSum, 9n);
    assert.equal(agent.ratingCount, 2);
    assert.equal(agent.royaltyBps, 500);
    assert.equal(agent.disputesLost, 2, "both refunds count against the agent");
    assert.equal(agent.pricePerUse, PER_USE);
    assert.equal(typeof agent.chainIndex, "number");
    assert.equal(agent.creatorId, lc(creator.address));
    // the creator moved to an unreviewed version: the mirror keeps the approved one and blocks sales
    assert.equal(agent.syncFlag, "unapproved_chain_version");
    assert.equal(agent.version, "1.0.0");
    assert.equal(agent.versionHash, db32(V1));
    assert.equal(agent.platformStatus, "active", "never written by the indexer");

    const lic1 = (await dbm.db.select().from(s.licenses).where(eq(s.licenses.id, String(token1))))[0]!;
    const lic2 = (await dbm.db.select().from(s.licenses).where(eq(s.licenses.id, String(token2))))[0]!;
    assert.equal(lic1.ownerWallet, lc(receiver.address), "owner after the royalty transfer");
    assert.equal(lic1.originalPrice, PRICE);
    assert.equal(lic1.txHash, mintTx1, "mint transaction");
    assert.equal(lic1.versionHash, db32(V1), "version current at mint");
    assert.ok(lic1.reviewId, "license 1 backs the receiver's review");
    assert.equal(lic1.burned, false);
    assert.equal(lic2.ownerWallet, lc(buyer2.address));
    assert.ok(lic2.reviewId && lic2.reviewId !== lic1.reviewId);

    const [cr] = await dbm.db.select().from(s.credits).where(and(eq(s.credits.agentId, AGENT_DB_ID), eq(s.credits.ownerWallet, lc(buyer.address))));
    assert.deepEqual([cr?.remaining, cr?.purchased], [5, 5]);

    const reviews = await dbm.db.select().from(s.reviews).where(eq(s.reviews.agentId, AGENT_DB_ID));
    const rv2 = reviews.find((r) => r.authorWallet === lc(buyer2.address))!;
    const rvR = reviews.find((r) => r.authorWallet === lc(receiver.address))!;
    assert.equal(rv2.rating, 4);
    assert.equal(rv2.text, REVIEW_TEXT, "text published from the draft with the same hash");
    assert.equal(rv2.versionHash, db32(V1), "version current at submission (D6)");
    assert.equal(rv2.tokenId, String(token2));
    assert.equal(rv2.id, `${AGENT_DB_ID}:${lc(buyer2.address)}`);
    assert.equal(rvR.rating, 5);
    assert.equal(rvR.text, "", "no draft: no text the hash does not prove");
    const drafts = await dbm.db.select().from(s.reviewDrafts).where(eq(s.reviewDrafts.agentId, AGENT_DB_ID));
    assert.equal(drafts.length, 0, "the used draft is deleted");

    const [eA] = await dbm.db.select().from(s.escrows).where(eq(s.escrows.id, String(escrowA)));
    const [eB] = await dbm.db.select().from(s.escrows).where(eq(s.escrows.id, String(escrowB)));
    assert.equal(eA?.status, "approved", "one released + one refunded = Completed");
    assert.equal(eA?.buyerWallet, lc(buyer.address));
    assert.equal(eA?.creatorWallet, lc(creator.address));
    assert.equal(eA?.feeBps, 1000);
    assert.equal(eA?.purchaseId, lc(pid("e1")));
    assert.equal(eB?.status, "refunded");
    assert.equal(eB?.buyerWallet, lc(buyer2.address));
    const msA = await dbm.db.select().from(s.milestones).where(eq(s.milestones.escrowId, String(escrowA)));
    assert.deepEqual(
      msA.sort((x, y) => x.idx - y.idx).map((m) => [m.status, m.amount, !!m.passedAt, !!m.disputedAt]),
      [
        ["approved", 3_000_000n, true, false],
        ["refunded", 4_000_000n, false, true],
      ],
    );

    const reps = await dbm.db.select().from(s.userReputation).where(drizzle.inArray(s.userReputation.wallet, [lc(buyer.address), lc(buyer2.address)]));
    const repBuyer = reps.find((r) => r.wallet === lc(buyer.address));
    const repBuyer2 = reps.find((r) => r.wallet === lc(buyer2.address));
    assert.equal(repBuyer?.purchases, 2, "license + credits (escrows do not count as purchases)");
    assert.equal(repBuyer?.disputesOpened, 1);
    assert.equal(repBuyer2?.purchases, 1);
    assert.equal(repBuyer2?.disputesOpened, 1);

    const txs = await dbm.db.select().from(s.chainTxs).where(eq(s.chainTxs.agentId, AGENT_DB_ID));
    const by = (k: string) => txs.filter((t) => t.kind === k);
    assert.deepEqual(by("purchase").map((t) => [t.amount, t.fee, t.creatorAmount, t.creatorWallet]), [
      [PRICE, 1_000_000n, 9_000_000n, lc(creator.address)],
      [PRICE, 1_000_000n, 9_000_000n, lc(creator.address)],
    ]);
    assert.deepEqual(
      by("purchase").map((t) => t.wallet).sort(),
      [lc(buyer.address), lc(buyer2.address)].sort(),
      "a platform purchase is recorded for the buyer, not the payer",
    );
    assert.deepEqual(by("royalty").map((t) => [t.wallet, t.amount, t.fee, t.creatorAmount]), [[lc(buyer.address), 1_000_000n, 500_000n, 500_000n]]);
    assert.deepEqual(by("credits").map((t) => [t.amount, t.fee]), [[5_000_000n, 500_000n]]);
    assert.deepEqual(by("escrow").map((t) => t.amount).sort(), [5_000_000n, 7_000_000n]);
    assert.deepEqual(by("release").map((t) => [t.wallet, t.amount, t.fee, t.creatorAmount, t.feeBps]), [[lc(buyer.address), 3_000_000n, 300_000n, 2_700_000n, 1000]]);
    assert.deepEqual(by("refund").map((t) => [t.amount, t.fee]).sort((x, y) => Number(x[0]! - y[0]!)), [
      [4_000_000n, 0n],
      [5_000_000n, 0n],
    ]);
    assert.ok(txs.every((t) => t.blockTime instanceof Date && t.blockNumber! >= startBlock), "block number and time on every row");
    const claims = await dbm.db.select().from(s.chainTxs).where(and(eq(s.chainTxs.kind, "claim"), eq(s.chainTxs.wallet, lc(buyer2.address))));
    assert.deepEqual(claims.map((c) => c.amount), [5_000_000n]);

    const [deferred] = await dbm.db
      .select()
      .from(s.payoutsDeferred)
      .where(and(eq(s.payoutsDeferred.contract, lc(env.deployment.escrow)), eq(s.payoutsDeferred.recipient, lc(buyer2.address))));
    assert.equal(deferred?.amount, 0n, "deferred refund mirrored, then claimed");

    // payments hook: one call per SaleAuthorized, with the payer (X22)
    assert.equal(sales.length, 5);
    const forBuyer2 = sales.filter((e) => e.buyer === lc(buyer2.address));
    assert.ok(forBuyer2.every((e) => e.payer === lc(platform.address)), "platform purchases carry the PLATFORM payer");
    assert.deepEqual(sales.map((e) => e.kind).sort(), [1, 1, 2, 3, 3]);
    assert.ok(sales.some((e) => e.purchaseId === lc(pid("l1")) && e.payer === lc(buyer.address)));
    // The hook gets the other events of the same transaction (amounts without an RPC call inside the DB transaction).
    for (const e of sales) {
      const purchase = e.siblings.find((x) => ["LicensePurchased", "CreditsBought", "EscrowCreated"].includes(x.eventName));
      assert.ok(purchase, `sibling purchase event for ${e.purchaseId}`);
      assert.ok(e.siblings.every((x) => x.transactionHash.toLowerCase() === e.txHash));
    }

    // governance subscribers
    assert.ok(governance.some((g) => g.name === "RoleGranted" && lc(String(g.args.account)) === lc(guardian)));
  });

  it("re-running is idempotent (processed_events) and processTxHash applies nothing twice", async () => {
    const before = await counts();
    const hookCalls = sales.length;
    await poller.writeCursor(KEY, null);
    const res = await poll();
    assert.ok(res.events > 20);
    assert.equal(res.applied, 0, "nothing applied twice");
    assert.deepEqual(await counts(), before);
    const stats = await processor.processTxHash(mintTx1);
    assert.ok(stats.events >= 3);
    assert.equal(stats.applied, 0);
    assert.equal(sales.length, hookCalls, "the payments hook never runs twice");
  });

  it("a forced reindex refreshes the mirror from the chain without side effects", async () => {
    const { eq } = drizzle;
    const s = dbm.schema;
    await dbm.db.update(s.licenses).set({ ownerWallet: "0x000000000000000000000000000000000000beef" }).where(eq(s.licenses.id, String(token1)));
    const hookCalls = sales.length;
    const r = await poller.scanRange(startBlock, await pc().getBlockNumber({ cacheTime: 0 }), { force: true, batch: 50 });
    assert.equal(r.applied, 0);
    const [lic1] = await dbm.db.select().from(s.licenses).where(eq(s.licenses.id, String(token1)));
    assert.equal(lic1?.ownerWallet, lc(receiver.address), "owner restored from ownerOf");
    assert.equal(sales.length, hookCalls);
  });

  it("a cursor whose block hash no longer matches rewinds 32 blocks and catches up again", async () => {
    await pc().request({ method: "anvil_mine", params: ["0x28"] } as never); // 40 empty blocks
    await poll();
    const latest = await pc().getBlockNumber({ cacheTime: 0 });
    assert.ok(latest - 32n >= startBlock, "enough blocks for a full rewind");
    await poller.writeCursor(KEY, { block: latest, blockHash: `0x${"ab".repeat(32)}` as Hex });
    const res = await poll();
    assert.equal(res.rewoundTo, latest - 32n);
    assert.equal(res.from, latest - 31n);
    assert.equal(res.to, latest);
    assert.equal(res.applied, 0, "rescanned blocks apply nothing twice");
    const cur = await poller.readCursor(KEY);
    assert.equal(cur?.block, latest);
    assert.equal(cur?.blockHash, lc((await pc().getBlock({ blockNumber: latest })).hash));
  });

  it("new events after the cursor are picked up by the next poll (burn marks the license)", async () => {
    const d = env.deployment;
    await send(receiver, [call(d.license, [{ type: "function", name: "burn", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "tokenId" }], outputs: [] }], "burn", [token1])]);
    const res = await poll();
    assert.ok(res.applied >= 1);
    const { eq } = drizzle;
    const [lic1] = await dbm.db.select().from(dbm.schema.licenses).where(eq(dbm.schema.licenses.id, String(token1)));
    assert.equal(lic1?.burned, true);
    assert.equal(lic1?.ownerWallet, lc(receiver.address), "a burn keeps the last owner");
  });
});
