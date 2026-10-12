// Integration tests against `anvil --tempo` (phase-3 spike, plan §6 phase 3 step 4 b-d). Skipped when anvil is absent.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, erc20Abi, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";

import {
  NONCE_LANES,
  createSponsorRelay,
  decodeSolversError,
  parseSolversEvents,
  publishAgentCalls,
  purchaseLicenseCalls,
  purchaseLicenseForCalls,
  relayedWalletClient,
  sendCalls,
  serverWalletClient,
  setEvalCalls,
  transferWithRoyaltyCalls,
  waitForSuccess,
  approveAgentCalls,
  type Call,
} from "./index.js";
import { KEYS, PATH_USD, ROLES, anvilAvailable, serveRelay, startAnvil, type AnvilEnv } from "./testing/anvil.js";

const skip = !anvilAvailable();
const AGENT = "0xc71ad0a50f750e75c71ad0a50f750e7500000000000000000000000000000000" as Hex;
const PRICE = 10_000_000n;
const acct = (i: number) => privateKeyToAccount(KEYS[i]!);

describe("Tempo chain client on anvil --tempo", { skip: skip && "anvil not installed" }, () => {
  let env: AnvilEnv;
  let relay: { url: string; close: () => Promise<void> };
  const refusals: string[] = [];
  const sponsored: Hex[] = [];
  const contexts: string[] = [];
  let handle: (body: unknown, ctx: { ip?: string }) => Promise<unknown>;
  let pub: ReturnType<typeof createPublicClient>;
  const bal = async (a: Address) =>
    pub.readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  before(async () => {
    env = await startAnvil();
    pub = createPublicClient({ chain: env.chain, transport: http(env.rpcUrl) });
    const d = env.deployment;
    const r = createSponsorRelay({
      chain: env.chain,
      rpcUrl: env.rpcUrl,
      feePayer: acct(ROLES.relay),
      policy: {
        chainId: 31337,
        contracts: [d.registry, d.license, d.credits, d.reviews, d.escrow, d.staking],
        token: d.token,
        maxGasPerTx: 6_000_000n,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        feeToken: PATH_USD,
      },
      check: async (_tx, ctx) => {
        contexts.push(ctx.ip ?? "");
        return null;
      },
      onRefused: (reason) => refusals.push(reason),
      onSponsored: (e) => {
        sponsored.push(e.signPayload);
      },
    });
    relay = await serveRelay(r.handle);
    handle = r.handle;

    // creator publishes through the relay (approve-free: minStake 0), admin approves in-process sponsored
    const creator = relayedWalletClient(acct(ROLES.creator), env.chain, relay.url, env.rpcUrl);
    const pubCalls = publishAgentCalls(d, {
      registration: {
        agentId: AGENT,
        metadataUri: "https://api.test/a.json",
        version: "1.0.0",
        versionHash: keccak256(toBytes("v1")),
        price: PRICE,
        pricePerUse: 1_000_000n,
        royaltyBps: 500,
      },
      minStake: 0n,
      maxSupply: 2,
    });
    await waitForSuccess(pub as never, await sendCalls(creator as never, pubCalls, { feePayer: true }));
    const admin = serverWalletClient(acct(ROLES.admin), env.chain, env.rpcUrl);
    await waitForSuccess(
      pub as never,
      await sendCalls(admin as never, approveAgentCalls(d, AGENT), { feePayer: acct(ROLES.relay), nonceKey: NONCE_LANES.admin }),
    );
  });

  after(async () => {
    await relay?.close();
    await env?.stop();
  });

  test("(b) sponsored batch through the relay: buyer pays exactly the price, the relay key pays the fee", async () => {
    const d = env.deployment;
    const buyer = acct(ROLES.buyer);
    const relayAddr = acct(ROLES.relay).address;
    const [b0, r0] = [await bal(buyer.address), await bal(relayAddr)];
    const wallet = relayedWalletClient(buyer, env.chain, relay.url, env.rpcUrl);
    const purchaseId = keccak256(toBytes("solvers:v1:test-1"));
    const hash = await sendCalls(wallet as never, purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId }), {
      feePayer: true,
    });
    const receipt = await waitForSuccess(pub as never, hash);
    assert.equal(b0 - (await bal(buyer.address)), PRICE, "buyer pays the price and no fee");
    assert.ok((await bal(relayAddr)) < r0, "relay paid the fee");
    assert.equal(String((receipt as unknown as { feePayer?: string }).feePayer).toLowerCase(), relayAddr.toLowerCase());
    assert.ok(sponsored.length >= 2, "onSponsored ran before the fill was returned");
    assert.ok(contexts.some((ip) => ip.includes("127.0.0.1")), "the check hook sees the request context");

    // (d) logIndex numbering across the batched calls: one receipt, strictly increasing from 0
    const idx = receipt.logs.map((l) => l.logIndex);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
    assert.equal(idx[0], 0);
    const events = parseSolversEvents(receipt.logs, d).map((e) => e.eventName);
    assert.deepEqual(events.filter((n) => n === "SaleAuthorized" || n === "LicensePurchased"), ["SaleAuthorized", "LicensePurchased"]);
    assert.ok(events.includes("Transfer"), "ERC-721 mint event decoded");
  });

  test("the relay refuses calls outside the policy (foreign target, token transfer, missing validBefore)", async () => {
    const d = env.deployment;
    const wallet = relayedWalletClient(acct(ROLES.buyer2), env.chain, relay.url, env.rpcUrl);
    const transfer: Call = {
      to: d.token,
      data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000001",
    };
    await assert.rejects(sendCalls(wallet as never, [transfer], { feePayer: true }));
    assert.ok(refusals.includes("token call not allowed"), refusals.join(","));
    await assert.rejects(sendCalls(wallet as never, [{ to: acct(1).address, data: "0x" }], { feePayer: true }));
    assert.ok(refusals.some((r) => r.startsWith("target not allowed")));
  });

  test("server keys: in-process fee payer on independent 2D nonce lanes, in parallel", async () => {
    const d = env.deployment;
    const platform = serverWalletClient(acct(ROLES.platform), env.chain, env.rpcUrl);
    const verifier = serverWalletClient(acct(ROLES.verifier), env.chain, env.rpcUrl);
    const relayAcct = acct(ROLES.relay);
    const p0 = await bal(acct(ROLES.platform).address);
    const [h1, h2, h3] = await Promise.all([
      sendCalls(
        platform as never,
        purchaseLicenseForCalls(d, {
          buyer: acct(ROLES.buyer2).address,
          agentId: AGENT,
          price: PRICE,
          purchaseId: keccak256(toBytes("solvers:v1:pix-1")),
        }),
        { feePayer: relayAcct, nonceKey: NONCE_LANES.platform },
      ),
      sendCalls(
        verifier as never,
        setEvalCalls(d, { agentId: AGENT, versionHash: keccak256(toBytes("v1")), scoreBps: 8800, evalHash: keccak256(toBytes("e")) }),
        { feePayer: relayAcct, nonceKey: NONCE_LANES.verifier },
      ),
      sendCalls(
        platform as never,
        setEvalCalls(d, { agentId: AGENT, versionHash: keccak256(toBytes("vX")), scoreBps: 1, evalHash: keccak256(toBytes("x")) }),
        { feePayer: relayAcct, nonceKey: NONCE_LANES.usage },
      ).catch((e: unknown) => e),
    ]);
    await waitForSuccess(pub as never, h1);
    await waitForSuccess(pub as never, h2);
    assert.equal(p0 - (await bal(acct(ROLES.platform).address)), PRICE, "float pays exactly the price, no fee");
    // the third call is sent by a key without VERIFIER_ROLE: decode the revert
    if (typeof h3 === "string") {
      const r = await pub.waitForTransactionReceipt({ hash: h3 as Hex });
      assert.equal(r.status, "reverted");
    } else {
      assert.equal(decodeSolversError(h3).name, "AccessControlUnauthorizedAccount");
    }
  });

  test("(c) simulation of a 0x76 batch and custom-error decoding (sold out)", async () => {
    const d = env.deployment;
    const buyer = acct(ROLES.buyer);
    // cap is 2 and two licenses exist: simulating a third purchase must fail with SoldOut
    const calls = purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes("solvers:v1:x")) });
    const err = await pub
      .estimateGas({ account: buyer.address, calls: calls.map((c) => ({ to: c.to, data: c.data })) } as never)
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(err, "estimateGas of the batch reverts");
    assert.equal(decodeSolversError(err).name, "SoldOut");
    // a valid batch estimates fine (raise the cap first)
    const creator = relayedWalletClient(acct(ROLES.creator), env.chain, relay.url, env.rpcUrl);
    await waitForSuccess(
      pub as never,
      await sendCalls(
        creator as never,
        [
          {
            to: d.registry,
            data: (await import("viem")).encodeFunctionData({ abi: solversRegistryAbi, functionName: "setSupplyCap", args: [AGENT, 10] }),
          },
        ],
        { feePayer: true },
      ),
    );
    const gas = await pub.estimateGas({ account: buyer.address, calls: calls.map((c) => ({ to: c.to, data: c.data })) } as never);
    assert.ok(gas > 500_000n, `batch estimate ${gas}`);
  });

  test("royalty transfer through the relay pays exactly 5% + 5% of the original price", async () => {
    const d = env.deployment;
    const owner = acct(ROLES.buyer);
    const tokenId = 1n;
    const [c0, t0] = [await bal(acct(ROLES.creator).address), await bal(d.treasury)];
    const q = (await pub.readContract({
      address: d.license,
      abi: solversLicenseAbi,
      functionName: "quoteRoyalty",
      args: [tokenId],
    })) as readonly [Address, bigint, Address, bigint];
    assert.equal(q[1], 500_000n);
    assert.equal(q[3], 500_000n);
    const wallet = relayedWalletClient(owner, env.chain, relay.url, env.rpcUrl);
    await waitForSuccess(
      pub as never,
      await sendCalls(wallet as never, transferWithRoyaltyCalls(d, { to: acct(ROLES.buyer2).address, tokenId, maxRoyalty: q[1] + q[3] }), {
        feePayer: true,
      }),
    );
    assert.equal((await bal(acct(ROLES.creator).address)) - c0, 500_000n);
    assert.equal((await bal(d.treasury)) - t0, 500_000n);
  });

  test("the relay answers only its JSON-RPC methods", async () => {
    const res = (await handle({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [PATH_USD, "latest"] }, {})) as {
      error?: { code: number };
    };
    assert.equal(res.error?.code, -32601);
    const ok = (await handle({ jsonrpc: "2.0", id: 2, method: "eth_chainId" }, {})) as { result?: unknown };
    assert.ok(ok.result);
  });

  test("fees: the sponsor's fee token overrides the client's on fills; an excessive priority fee is refused", async () => {
    const d = env.deployment;
    const wallet = relayedWalletClient(acct(ROLES.buyer2), env.chain, relay.url, env.rpcUrl);
    const vb = () => Math.floor(Date.now() / 1000) + 60;
    const hash = await wallet.sendTransaction({
      calls: purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes("fee-token")) }),
      feePayer: true,
      feeToken: "0x20c0000000000000000000000000000000000001",
      validBefore: vb(),
    } as never);
    const receipt = await waitForSuccess(pub as never, hash);
    assert.equal(String((receipt as unknown as { feeToken?: string }).feeToken).toLowerCase(), PATH_USD);
    const before = refusals.length;
    await assert.rejects(
      wallet.sendTransaction({
        calls: purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes("tip")) }),
        feePayer: true,
        maxPriorityFeePerGas: 10_000_000_000n,
        maxFeePerGas: 50_000_000_000n,
        validBefore: vb(),
      } as never),
    );
    assert.ok(refusals.slice(before).includes("priority fee above the cap"), refusals.slice(before).join(","));
  });

  test("an expired transaction (validBefore in the past) is not sponsored", async () => {
    const d = env.deployment;
    const wallet = relayedWalletClient(acct(ROLES.buyer2), env.chain, relay.url, env.rpcUrl);
    await assert.rejects(
      sendCalls(wallet as never, purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes("late")) }), {
        feePayer: true,
        validitySecs: -10,
      }),
    );
  });
});
