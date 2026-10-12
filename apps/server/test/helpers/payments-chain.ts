// Fixture of the payments tests: `anvil --tempo` with the six proxies (@solvers/chain/testing), the chain context of the
// server keys, and helpers to register agents (on-chain + DB row), act as creator/admin/buyer and clean up.
// Needs TEST_DATABASE_URL (disposable, migrated) and anvil. Rows created here use agent ids that are recorded and
// deleted in `cleanup()`; shared tables are never truncated.
import { randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, keccak256, toBytes, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

export const PRICE = 10_000_000n;
export const PRICE_PER_USE = 1_000_000n;

export type PaymentsChain = Awaited<ReturnType<typeof setupPaymentsChain>>;

export async function setupPaymentsChain(extraEnv: Record<string, string> = {}) {
  const url = process.env.TEST_DATABASE_URL!;
  const anvil: AnvilEnv = await startAnvil();
  Object.assign(process.env, {
    DATABASE_URL: url,
    CHAIN_ID: "31337",
    RPC_URL: anvil.rpcUrl,
    PLATFORM_PRIVATE_KEY: KEYS[ROLES.platform],
    RELAY_PRIVATE_KEY: KEYS[ROLES.relay],
    VERIFIER_PRIVATE_KEY: KEYS[ROLES.verifier],
    ADMIN_PRIVATE_KEY: KEYS[ROLES.admin],
    TREASURY_ADDRESS: anvil.deployment.treasury,
    JWT_SECRET: "j".repeat(40),
    SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
    PIX_SIMULATE: "true",
    MP_WEBHOOK_SECRET: "whsec-payments-test",
    GUARANTEE_MIN_SALES: "0",
    GUARANTEE_MIN_RATING: "0",
    BRL_PER_USD: "5.4",
    ...extraEnv,
  });
  const chainMod = await import("../../src/chain/index.js");
  const chain = await import("@solvers/chain");
  const acct = (i: number) => chain.loadAccount(KEYS[i], "K");
  chainMod.setChainContext({
    chain: anvil.chain,
    deployment: anvil.deployment,
    publicClient: chain.publicClientFor(anvil.chain, anvil.rpcUrl),
    accounts: { platform: acct(ROLES.platform), relay: acct(ROLES.relay), verifier: acct(ROLES.verifier), admin: acct(ROLES.admin) },
    wallets: {
      platform: chain.serverWalletClient(acct(ROLES.platform), anvil.chain, anvil.rpcUrl),
      verifier: chain.serverWalletClient(acct(ROLES.verifier), anvil.chain, anvil.rpcUrl),
      admin: chain.serverWalletClient(acct(ROLES.admin), anvil.chain, anvil.rpcUrl),
    },
  });
  const ctx = chainMod.chainContext();
  const dbMod = await import("../../src/db/index.js");
  const lanes = await import("../../src/chain/lanes.js");
  const { solversRegistryAbi } = await import("@solvers/contracts-client");
  const { agentIdToBytes32 } = await import("@solvers/shared");
  const fx = await import("../../src/store/fx.js");
  fx.setFxQuoteForTests({ rate: 5.4, source: "env" });
  const intent = await import("../../src/payments/intent.js");
  intent.setPackageCheck(() => true);

  const agentIds: string[] = [];
  const address = (i: number) => privateKeyToAccount(KEYS[i]!).address.toLowerCase() as Hex;
  // Each anvil starts every nonce lane at 0 again: journal rows of the public anvil dev keys left by earlier runs would
  // collide with the (account, lane, nonce) key. Only these test-only accounts are touched.
  const devAccounts = KEYS.map((_, i) => address(i));
  const clearDevJournal = async () => {
    const { inArray } = await import("drizzle-orm");
    await dbMod.db.delete(dbMod.schema.sentTxs).where(inArray(dbMod.schema.sentTxs.account, devAccounts));
  };
  await clearDevJournal();
  const wallet = (i: number) => chain.serverWalletClient(acct(i), anvil.chain, anvil.rpcUrl);

  /** Sends `calls` from anvil key `i` and waits for success; `sponsored` = the RELAY key pays the fee (as the relay does). */
  async function sendAs(i: number, calls: readonly { to: Hex; data: Hex }[], o: { sponsored?: boolean } = {}): Promise<TransactionReceipt> {
    const opts = o.sponsored ? { feePayer: acct(ROLES.relay) } : {};
    return chain.waitForSuccess(ctx.publicClient as never, await chain.sendCalls(wallet(i) as never, calls as never, opts));
  }

  async function admin(functionName: string, args: unknown[]) {
    await lanes.sendServerCalls({
      signer: "admin",
      lane: "admin",
      calls: [{ to: anvil.deployment.registry, data: encodeFunctionData({ abi: solversRegistryAbi, functionName, args } as never) }],
      kind: `test-admin-${functionName}`,
    });
  }

  /** Registers + approves an agent on-chain and inserts its catalog row. */
  async function newAgent(o: { price?: bigint; pricePerUse?: bigint; maxSupply?: number } = {}) {
    const id = randomBytes(16).toString("hex");
    const price = o.price ?? PRICE;
    const pricePerUse = o.pricePerUse ?? PRICE_PER_USE;
    await sendAs(
      ROLES.creator,
      chain.publishAgentCalls(anvil.deployment, {
        registration: {
          agentId: agentIdToBytes32(id),
          metadataUri: "u",
          version: "1.0.0",
          versionHash: keccak256(toBytes(id)),
          price,
          pricePerUse,
          royaltyBps: 500,
        },
        minStake: 0n,
        ...(o.maxSupply ? { maxSupply: o.maxSupply } : {}),
      }),
    );
    await lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: chain.approveAgentCalls(anvil.deployment, agentIdToBytes32(id)), kind: "test-approve" });
    await dbMod.db.insert(dbMod.schema.agents).values({
      id,
      slug: `paytest-${id.slice(0, 12)}`,
      name: `Pay test ${id.slice(0, 6)}`,
      tagline: "t",
      description: "d",
      category: "Test",
      creatorId: "paytest-creator",
      version: "1.0.0",
      versionHash: keccak256(toBytes(id)).slice(2), // DB form (X29)
      price,
      pricePerUse,
      status: "active",
      listed: true,
      guaranteeAvailable: true,
      details: {
        guaranteeTemplate: {
          priceUsdc: 20,
          milestones: [
            { title: "Plan", criteria: ["a plan"], sharePct: 40, verify: "manual" },
            { title: "Build", criteria: ["tests pass"], sharePct: 60, verify: "tests" },
          ],
        },
      },
    });
    // The reviewed record: purchase intents refuse an on-chain version/price that was never approved.
    await dbMod.db
      .insert(dbMod.schema.agentPublishedVersions)
      .values({ agentId: id, version: "1.0.0", versionHash: keccak256(toBytes(id)).slice(2), priceUsdc: price });
    agentIds.push(id);
    return id;
  }

  /** A reviewed price change: on-chain pricing plus the approved record of the new price. */
  async function setPrice(agentId: string, price: bigint, pricePerUse = PRICE_PER_USE) {
    await sendAs(ROLES.creator, chain.updatePricingCalls(anvil.deployment, { agentId: agentIdToBytes32(agentId), price, pricePerUse }));
    await dbMod.db
      .update(dbMod.schema.agentPublishedVersions)
      .set({ priceUsdc: price })
      .where((await import("drizzle-orm")).eq(dbMod.schema.agentPublishedVersions.agentId, agentId));
  }

  const balance = (a: Hex) => ctx.publicClient.readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  async function cleanup() {
    const { inArray } = await import("drizzle-orm");
    const s = dbMod.schema;
    if (agentIds.length) {
      const rows = await dbMod.db.select({ id: s.paymentLedger.id }).from(s.paymentLedger).where(inArray(s.paymentLedger.agentId, agentIds));
      const ids = rows.map((r) => r.id);
      if (ids.length) await dbMod.db.delete(s.sentTxs).where(inArray(s.sentTxs.ref, ids));
      await dbMod.db.delete(s.paymentLedger).where(inArray(s.paymentLedger.agentId, agentIds));
      // Mirrors written by the immediate indexing of fulfilments (D9): licenses, credits, escrows and their steps, chain_txs.
      const escrowIds = (await dbMod.db.select({ id: s.escrows.id }).from(s.escrows).where(inArray(s.escrows.agentId, agentIds))).map((r) => r.id);
      if (escrowIds.length) await dbMod.db.delete(s.milestones).where(inArray(s.milestones.escrowId, escrowIds));
      await dbMod.db.delete(s.escrows).where(inArray(s.escrows.agentId, agentIds));
      await dbMod.db.delete(s.licenses).where(inArray(s.licenses.agentId, agentIds));
      await dbMod.db.delete(s.credits).where(inArray(s.credits.agentId, agentIds));
      await dbMod.db.delete(s.chainTxs).where(inArray(s.chainTxs.agentId, agentIds));
      await dbMod.db.delete(s.agentPublishedVersions).where(inArray(s.agentPublishedVersions.agentId, agentIds));
      await dbMod.db.delete(s.agents).where(inArray(s.agents.id, agentIds));
    }
    await clearDevJournal();
  }

  return {
    anvil,
    ctx,
    db: dbMod,
    lanes,
    address,
    sendAs,
    admin,
    newAgent,
    setPrice,
    balance,
    cleanup,
    platform: address(ROLES.platform),
    buyers: [address(ROLES.buyer), address(ROLES.buyer2), address(3), address(4), address(9)] as Hex[],
    buyerKeys: [ROLES.buyer, ROLES.buyer2, 3, 4, 9],
    stop: async () => {
      await cleanup().catch((e) => console.error("cleanup failed", e));
      await dbMod.pool.end();
      await anvil.stop();
    },
  };
}
