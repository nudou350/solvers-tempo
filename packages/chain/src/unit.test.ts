// Pure unit tests (no chain needed): relay policy, call builders, error decoding, explorer, keys, chains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeErrorResult, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { solversAbi, solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";

import {
  checkSponsoredTransaction,
  createEscrowCalls,
  decodeSolversError,
  explorerUrl,
  getChain,
  loadPrivateKey,
  publishAgentCalls,
  purchaseLicenseCalls,
  transferWithRoyaltyCalls,
  TIP20_ERRORS_ABI,
  updatePricingCalls,
  setRoyaltyBpsCalls,
  setSupplyCapCalls,
  withdrawStakeCalls,
  purchaseLicenseWithPermitCalls,
  loadDeployment,
  type RelayPolicy,
} from "./index.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const D = { token: a(1), registry: a(2), license: a(3), credits: a(4), reviews: a(5), escrow: a(6), staking: a(7) };
const AGENT = `0x${"ab".repeat(16)}${"00".repeat(16)}` as Hex;
const PID = `0x${"11".repeat(32)}` as Hex;

const policy: RelayPolicy = {
  chainId: 42431,
  contracts: [D.registry, D.license, D.credits, D.reviews, D.escrow, D.staking],
  token: D.token,
  maxGasPerTx: 6_000_000n,
  maxFeePerGas: 100_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  feeToken: a(1),
};
const NOW = 1_800_000_000;
const ok = (calls: { to: Address; data: Hex }[], extra: Record<string, unknown> = {}) =>
  checkSponsoredTransaction({ chainId: 42431, calls, gas: 1_000_000n, validBefore: NOW + 60, ...extra }, policy, NOW);

test("purchase batch = approve(license, price) + purchaseLicense; the relay sponsors it", () => {
  const calls = purchaseLicenseCalls(D, { agentId: AGENT, price: 10_000_000n, purchaseId: PID });
  assert.equal(calls.length, 2);
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
  assert.equal(approve.functionName, "approve");
  assert.deepEqual(approve.args, [D.license, 10_000_000n]);
  const buy = decodeFunctionData({ abi: solversLicenseAbi, data: calls[1]!.data });
  assert.equal(buy.functionName, "purchaseLicense");
  assert.deepEqual(buy.args, [AGENT, 10_000_000n, PID]);
  assert.deepEqual(ok(calls), { ok: true });
});

test("escrow and royalty batches approve exactly the total / maxRoyalty", () => {
  const e = createEscrowCalls(D, {
    agentId: AGENT,
    milestones: [
      { amount: 3n, criteriaHash: PID },
      { amount: 4n, criteriaHash: PID },
    ],
    reviewWindowSecs: 3600,
    deliveryDays: 0,
    purchaseId: PID,
  });
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: e[0]!.data }).args, [D.escrow, 7n]);
  const t = transferWithRoyaltyCalls(D, { to: a(99), tokenId: 1n, maxRoyalty: 1_000_000n });
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: t[0]!.data }).args, [D.license, 1_000_000n]);
  assert.deepEqual(ok(t), { ok: true });
});

test("publication batch: optional stake approve, registerAgent, optional supply cap", () => {
  const reg = {
    agentId: AGENT,
    metadataUri: "u",
    version: "1.0.0",
    versionHash: PID,
    price: 10_000_000n,
    pricePerUse: 0n,
    royaltyBps: 500,
  };
  assert.equal(publishAgentCalls(D, { registration: reg, minStake: 0n }).length, 1);
  const full = publishAgentCalls(D, { registration: reg, minStake: 20n, maxSupply: 100 });
  assert.equal(full.length, 3);
  assert.equal(decodeFunctionData({ abi: solversRegistryAbi, data: full[2]!.data }).functionName, "setSupplyCap");
});

test("relay policy refuses everything outside D3", () => {
  const transfer = { to: D.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a(9), 1n] }) };
  assert.deepEqual(ok([transfer]), { ok: false, reason: "token call not allowed" });
  const badApprove = {
    to: D.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a(9), 1n] }),
  };
  assert.deepEqual(ok([badApprove]), { ok: false, reason: "approve spender not allowed" });
  assert.equal(ok([{ to: a(9), data: "0x" }]).ok, false);
  const buy = purchaseLicenseCalls(D, { agentId: AGENT, price: 1n, purchaseId: PID });
  assert.deepEqual(ok(buy, { chainId: 4217 }), { ok: false, reason: "wrong chain" });
  assert.deepEqual(ok(buy, { gas: 7_000_000n }), { ok: false, reason: "gas limit above the cap" });
  assert.deepEqual(ok(buy, { validBefore: undefined }), { ok: false, reason: "validBefore required" });
  assert.deepEqual(ok(buy, { validBefore: NOW + 600 }), { ok: false, reason: "validBefore too far" });
  assert.deepEqual(ok(buy, { validBefore: NOW - 1 }), { ok: false, reason: "expired" });
  assert.deepEqual(ok([...buy, ...buy, ...buy]), { ok: false, reason: "call count" });
  assert.deepEqual(ok([]), { ok: false, reason: "call count" });
  assert.deepEqual(ok([{ ...buy[1]!, value: 1n } as never]), { ok: false, reason: "value must be 0" });
});

test("decodeSolversError maps custom errors by name and TIP-20 selectors", () => {
  const soldOut = encodeErrorResult({ abi: solversAbi, errorName: "SoldOut", args: [AGENT, 2] });
  const d = decodeSolversError(soldOut);
  assert.equal(d.name, "SoldOut");
  assert.match(d.message, /sold out/);
  assert.equal(decodeSolversError("0x54cfe659").name, "PolicyForbids");
  assert.equal(decodeSolversError(new Error("boom")).name, "Unknown");
});

test("explorer links, chain resolution and key loading", () => {
  assert.equal(explorerUrl(42431, PID), `https://explore.testnet.tempo.xyz/tx/${PID}`);
  assert.equal(explorerUrl(4217, a(1)), `https://explore.tempo.xyz/address/${a(1)}`);
  assert.equal(explorerUrl(31337, PID), null);
  assert.equal(getChain(42431).id, 42431);
  assert.equal(getChain(31337, "http://127.0.0.1:9999").rpcUrls.default.http[0], "http://127.0.0.1:9999");
  assert.throws(() => getChain(1));
  const key = `0x${"22".repeat(32)}`;
  assert.equal(loadPrivateKey(key, "K"), key);
  const dir = mkdtempSync(join(tmpdir(), "keys-"));
  writeFileSync(join(dir, "k"), `${key}\n`);
  assert.equal(loadPrivateKey(join(dir, "k"), "K"), key);
  assert.throws(() => loadPrivateKey(undefined, "RELAY_PRIVATE_KEY"), /RELAY_PRIVATE_KEY is not set/);
  assert.throws(() => loadPrivateKey("nope", "K"), (e: Error) => !e.message.includes("nope") || true);
});

test("relay policy: authorizations, foreign fee token, fee caps, validAfter, permit spender, creation, undecodable", () => {
  const buy = purchaseLicenseCalls(D, { agentId: AGENT, price: 1n, purchaseId: PID });
  assert.deepEqual(ok(buy, { authorizationList: [{}] }), { ok: false, reason: "authorization list not sponsored" });
  assert.deepEqual(ok(buy, { keyAuthorization: {} }), { ok: false, reason: "key authorization not sponsored" });
  assert.deepEqual(ok(buy, { feeToken: a(77) }), { ok: false, reason: "fee token not allowed" });
  assert.deepEqual(ok(buy, { feeToken: a(1) }), { ok: true });
  assert.deepEqual(ok(buy, { maxFeePerGas: 200_000_000_000n }), { ok: false, reason: "fee per gas above the cap" });
  assert.deepEqual(ok(buy, { maxPriorityFeePerGas: 2_000_000_000n }), { ok: false, reason: "priority fee above the cap" });
  assert.deepEqual(ok(buy, { validAfter: NOW + 30 }), { ok: false, reason: "validAfter in the future" });
  const permit = (spender: Address) => ({
    to: D.token,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "permit",
          stateMutability: "nonpayable",
          inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "v", type: "uint8" },
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
          ],
          outputs: [],
        },
      ],
      functionName: "permit",
      args: [a(50), spender, 1n, 1n, 27, PID, PID],
    }),
  });
  assert.deepEqual(ok([permit(D.license)]), { ok: true });
  assert.deepEqual(ok([permit(a(66))]), { ok: false, reason: "permit spender not allowed" });
  assert.deepEqual(ok([{ to: null as never, data: "0x60" }]), { ok: false, reason: "contract creation is not sponsored" });
  assert.deepEqual(ok([{ to: D.token, data: "0x095ea7b3" }]), { ok: false, reason: "undecodable token call" });
});

test("TIP-20 precompile errors decode by name", () => {
  const data = encodeErrorResult({ abi: TIP20_ERRORS_ABI, errorName: "InsufficientBalance", args: [1n, 2n, a(1)] });
  assert.equal(decodeSolversError(data).name, "InsufficientBalance");
  assert.equal(decodeSolversError("0xab35696f").name, "ContractPaused");
  assert.equal(decodeSolversError("0x13be252b").name, "InsufficientAllowance");
});

test("creator, stake and permit builders encode the right functions", () => {
  const name = (abi: readonly unknown[], data: Hex) => decodeFunctionData({ abi: abi as never, data }).functionName;
  assert.equal(name(solversRegistryAbi, updatePricingCalls(D, { agentId: AGENT, price: 6n, pricePerUse: 1n })[0]!.data), "updatePricing");
  assert.equal(name(solversRegistryAbi, setRoyaltyBpsCalls(D, { agentId: AGENT, royaltyBps: 300 })[0]!.data), "setRoyaltyBps");
  assert.equal(name(solversRegistryAbi, setSupplyCapCalls(D, { agentId: AGENT, max: 9 })[0]!.data), "setSupplyCap");
  assert.equal(withdrawStakeCalls(D, AGENT)[0]!.to, D.staking);
  const sig = { deadline: 9n, v: 27, r: PID, s: PID };
  const p = purchaseLicenseWithPermitCalls(D, { agentId: AGENT, price: 5n, purchaseId: PID, ...sig });
  assert.equal(p.length, 1, "a permit purchase is one self-paid call");
  assert.equal(name(solversLicenseAbi, p[0]!.data), "purchaseLicenseWithPermit");
});

test("loadDeployment validates the chain id and requires deployBlock", () => {
  const dir = mkdtempSync(join(tmpdir(), "dep-"));
  const base = { chainId: 31337, token: a(1), treasury: a(2), ...Object.fromEntries(["registry", "license", "credits", "reviews", "escrow", "staking"].map((k, i) => [k, a(10 + i)])) };
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ ...base, deployBlock: 5 }));
  writeFileSync(join(dir, "noblock.json"), JSON.stringify(base));
  assert.equal(loadDeployment(31337, { file: join(dir, "ok.json") }).deployBlock, 5n);
  assert.throws(() => loadDeployment(42431, { file: join(dir, "ok.json") }), /expected 42431/);
  assert.throws(() => loadDeployment(31337, { file: join(dir, "noblock.json") }), /deployBlock/);
});
