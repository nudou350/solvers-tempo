// Server transactions on 2D nonce lanes with the in-process RELAY fee payer (src/chain/lanes.ts).
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { erc20Abi, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, PATH_USD, ROLES, anvilAvailable, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;
const AGENT = "0xc71ad0a50f750e75c71ad0a50f750e7500000000000000000000000000000000" as Hex;
const PRICE = 10_000_000n;

describe("sendServerCalls on nonce lanes", { skip }, () => {
  let env: AnvilEnv;
  let lanes: typeof import("../src/chain/lanes.js");
  let db: typeof import("../src/db/index.js");
  const bal = async (a: Hex) =>
    env && (await import("@solvers/chain")).publicClientFor(env.chain, env.rpcUrl).readContract({
      address: PATH_USD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [a],
    });

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
    });
    const chainMod = await import("../src/chain/index.js");
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
    assert.deepEqual(await chainMod.validateChain(chainMod.chainContext()), []);
    lanes = await import("../src/chain/lanes.js");
    db = await import("../src/db/index.js");
    await db.db.delete(db.schema.sentTxs);

    // a creator registers (self-paid), the admin approves through the lanes
    const { publishAgentCalls, approveAgentCalls, sendCalls, waitForSuccess } = await import("@solvers/chain");
    const creator = serverWalletClient(acct(ROLES.creator), env.chain, env.rpcUrl);
    await waitForSuccess(
      chainMod.chainContext().publicClient as never,
      await sendCalls(
        creator as never,
        publishAgentCalls(env.deployment, {
          registration: {
            agentId: AGENT,
            metadataUri: "u",
            version: "1.0.0",
            versionHash: keccak256(toBytes("v1")),
            price: PRICE,
            pricePerUse: 1_000_000n,
            royaltyBps: 500,
          },
          minStake: 0n,
        }),
      ),
    );
    await lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: approveAgentCalls(env.deployment, AGENT), kind: "admin-approve" });
  });

  after(async () => {
    await db?.pool.end();
    await env?.stop();
  });

  it("a platform purchase is sponsored by RELAY and journaled before broadcast", async () => {
    const { purchaseLicenseForCalls } = await import("@solvers/chain");
    const platform = privateKeyToAccount(KEYS[ROLES.platform]!).address;
    const relay = privateKeyToAccount(KEYS[ROLES.relay]!).address;
    const [p0, r0] = [await bal(platform), await bal(relay)];
    const res = await lanes.sendServerCalls({
      signer: "platform",
      lane: "platform",
      calls: purchaseLicenseForCalls(env.deployment, {
        buyer: privateKeyToAccount(KEYS[ROLES.buyer]!).address,
        agentId: AGENT,
        price: PRICE,
        purchaseId: keccak256(toBytes("solvers:v1:pix-lanes-1")),
      }),
      kind: "pix-fulfil",
      ref: "charge-1",
    });
    assert.equal(p0! - (await bal(platform))!, PRICE, "the float pays exactly the price");
    assert.ok((await bal(relay))! < r0!, "RELAY pays the fee");
    const rows = await lanes.sentTxsFor("pix-fulfil", "charge-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.txHash, res.hash);
    assert.equal(rows[0]!.status, "confirmed");
  });

  it("one key, two lanes in parallel, and two sends on the same lane are serialized", async () => {
    const { setEvalCalls } = await import("@solvers/chain");
    const ev = (n: string) =>
      setEvalCalls(env.deployment, { agentId: AGENT, versionHash: keccak256(toBytes(n)), scoreBps: 100, evalHash: keccak256(toBytes(n)) });
    const { recordUsageBatchCalls } = await import("@solvers/chain");
    const usage = (n: number) =>
      recordUsageBatchCalls(env.deployment, { agentId: AGENT, count: BigInt(n), merkleRoot: keccak256(toBytes(`root-${n}`)) });
    const results = await Promise.all([
      lanes.sendServerCalls({ signer: "platform", lane: "usage", calls: usage(1), kind: "usage-batch", ref: "b1" }),
      lanes.sendServerCalls({ signer: "platform", lane: "usage", calls: usage(2), kind: "usage-batch", ref: "b2" }),
      lanes.sendServerCalls({ signer: "verifier", lane: "verifier", calls: ev("a"), kind: "set-eval" }),
    ]);
    assert.equal(results[1].nonce, results[0].nonce + 1n, "same lane: consecutive nonces");
    for (const r of results) assert.equal(r.receipt.status, "success");
  });

  it("a reverting server transaction is journaled as reverted and throws", async () => {
    const { approveAgentCalls } = await import("@solvers/chain");
    await assert.rejects(
      lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: approveAgentCalls(env.deployment, AGENT), kind: "admin-approve-again", gas: 500_000n }),
      /reverted/,
    );
    const rows = await lanes.sentTxsFor("admin-approve-again", "");
    const all = await db.db.select().from(db.schema.sentTxs);
    const row = all.find((r) => r.kind === "admin-approve-again");
    assert.equal(row?.status, "reverted");
    assert.equal(rows.length, 0); // ref was not set
  });

  it("boot validation refuses a hot key holding a role that is not its own (guardian, admin)", async () => {
    const chainMod = await import("../src/chain/index.js");
    const { solversRegistryAbi } = await import("@solvers/contracts-client");
    const { encodeFunctionData } = await import("viem");
    const c = chainMod.chainContext();
    const role = (fn: "grantRole" | "revokeRole") => [
      {
        to: c.deployment.registry,
        data: encodeFunctionData({ abi: solversRegistryAbi, functionName: fn, args: [chainMod.ROLE.GUARDIAN, c.accounts.verifier.address] }),
      },
    ];
    await lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: role("grantRole"), kind: "admin-grant-test" });
    try {
      assert.deepEqual(await chainMod.validateChain(c), ["VERIFIER key must not hold GUARDIAN_ROLE"]);
    } finally {
      await lanes.sendServerCalls({ signer: "admin", lane: "admin", calls: role("revokeRole"), kind: "admin-revoke-test" });
    }
    assert.deepEqual(await chainMod.validateChain(c), []);
  });
});

