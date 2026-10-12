// The web wallet's send path (lib/wallet/send.ts + lib/wallet/account.ts) against `anvil --tempo` with the six Solvers
// proxies and the platform relay served over HTTP (same fixture as packages/chain). Proves that:
//  - the dev wallet (viem local account) and a hash-only signer (the Privy embedded wallet shape: `secp256k1_sign`)
//    both send a sponsored [approve, purchaseLicense] batch: the buyer pays exactly the price, the relay pays the fee;
//  - a batch the relay declines is refused BEFORE signing (no unsponsored fallback, no fee paid by the buyer).
// Skipped when anvil is not installed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, erc20Abi, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import {
  NONCE_LANES,
  approveAgentCalls,
  createSponsorRelay,
  publishAgentCalls,
  purchaseLicenseCalls,
  relayedWalletClient,
  sendCalls,
  serverWalletClient,
  waitForSuccess,
} from "@solvers/chain";
import { contractErrorName } from "../src/lib/error-map";
import { KEYS, PATH_USD, ROLES, anvilAvailable, serveRelay, startAnvil, type AnvilEnv } from "@solvers/chain/testing";
import { hashSignerAccount } from "../src/lib/wallet/account";
import { SponsorDeclinedError, sendSponsoredCalls } from "../src/lib/wallet/send";

const skip = !anvilAvailable();
const AGENT = "0x1a2b3c4d5e6f708192a3b4c5d6e7f80900000000000000000000000000000000" as Hex;
const PRICE = 7_000_000n;
const acct = (i: number) => privateKeyToAccount(KEYS[i]!);

describe("web wallet send path on anvil --tempo", { skip: skip && "anvil not installed" }, () => {
  let env: AnvilEnv;
  let relay: { url: string; close: () => Promise<void> };
  let pub: ReturnType<typeof createPublicClient>;
  const refusals: string[] = [];
  const bal = async (a: Address) => pub.readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

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
      onRefused: (reason) => refusals.push(reason),
    });
    relay = await serveRelay(r.handle);
    const creator = relayedWalletClient(acct(ROLES.creator), env.chain, relay.url, env.rpcUrl);
    const publish = publishAgentCalls(d, {
      registration: {
        agentId: AGENT,
        metadataUri: "https://api.test/web.json",
        version: "1.0.0",
        versionHash: keccak256(toBytes("web-v1")),
        price: PRICE,
        pricePerUse: 1_000_000n,
        royaltyBps: 500,
      },
      minStake: 0n,
    });
    await waitForSuccess(pub as never, await sendCalls(creator as never, publish, { feePayer: true }));
    const admin = serverWalletClient(acct(ROLES.admin), env.chain, env.rpcUrl);
    await waitForSuccess(pub as never, await sendCalls(admin as never, approveAgentCalls(d, AGENT), { feePayer: acct(ROLES.relay), nonceKey: NONCE_LANES.admin }));
  });

  after(async () => {
    await relay?.close();
    await env?.stop();
  });

  const buy = async (account: Parameters<typeof sendSponsoredCalls>[0]["account"], tag: string) => {
    const d = env.deployment;
    const relayAddr = acct(ROLES.relay).address;
    const [b0, r0] = [await bal(account.address), await bal(relayAddr)];
    const purchaseId = keccak256(toBytes(`solvers:v1:web-${tag}`));
    const hash = await sendSponsoredCalls({
      account,
      chainId: 31337,
      rpcUrl: env.rpcUrl,
      relayUrl: relay.url,
      calls: purchaseLicenseCalls(d, { agentId: AGENT, price: PRICE, purchaseId }),
    });
    const receipt = await waitForSuccess(pub as never, hash);
    assert.equal(b0 - (await bal(account.address)), PRICE, "the buyer pays exactly the price, no fee");
    assert.ok((await bal(relayAddr)) < r0, "the relay key paid the fee");
    assert.equal(String((receipt as unknown as { feePayer?: string }).feePayer).toLowerCase(), relayAddr.toLowerCase());
  };

  test("dev wallet (viem local account): sponsored purchase", async () => {
    await buy(acct(ROLES.buyer), "dev");
  });

  test("hash-only signer (Privy embedded wallet shape): sponsored purchase", async () => {
    const key = KEYS[ROLES.buyer2]!;
    const signed: Hex[] = [];
    const account = hashSignerAccount({
      address: privateKeyToAccount(key).address,
      signHash: async (hash) => {
        signed.push(hash);
        return sign({ hash, privateKey: key, to: "hex" });
      },
      signMessage: (message) => privateKeyToAccount(key).signMessage({ message }),
    });
    await buy(account, "hash");
    assert.equal(signed.length, 1, "exactly one hash signed by the wallet");
  });

  test("a reverting batch surfaces the contract's custom error (decoded by name for the error text)", async () => {
    const purchaseId = keccak256(toBytes("solvers:v1:web-price"));
    const err = await sendSponsoredCalls({
      account: acct(ROLES.buyer),
      chainId: 31337,
      rpcUrl: env.rpcUrl,
      relayUrl: relay.url,
      calls: purchaseLicenseCalls(env.deployment, { agentId: AGENT, price: PRICE + 1n, purchaseId }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err, "the purchase with a stale price must fail");
    assert.equal(contractErrorName(err), "PriceChanged");
  });

  test("a batch the relay declines is refused before the wallet signs (no fee paid)", async () => {
    const key = KEYS[ROLES.buyer]!;
    let signedHashes = 0;
    const account = hashSignerAccount({
      address: privateKeyToAccount(key).address,
      signHash: async (hash) => {
        signedHashes++;
        return sign({ hash, privateKey: key, to: "hex" });
      },
      signMessage: (message) => privateKeyToAccount(key).signMessage({ message }),
    });
    const before = await bal(account.address);
    const transfer = {
      to: env.deployment.token,
      data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000001" as Hex,
    };
    await assert.rejects(
      sendSponsoredCalls({ account, chainId: 31337, rpcUrl: env.rpcUrl, relayUrl: relay.url, calls: [transfer] }),
      (e: unknown) => e instanceof SponsorDeclinedError,
    );
    assert.equal(signedHashes, 0, "nothing was signed");
    assert.equal(await bal(account.address), before, "no fee and no transfer");
    assert.ok(refusals.includes("token call not allowed"), refusals.join(","));
  });
});
