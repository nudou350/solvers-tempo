import "./helpers/fake-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { CHARGE_STATUSES } from "@solvers/shared";

import {
  CHAIN_FULFILS,
  canTransition,
  decodePurchaseRef,
  encodePurchaseRef,
  fulfilVerdict,
  sourcesOf,
} from "../src/payments/lifecycle.js";
import { csvField, ledgerCsv, parseRange } from "../src/payments/export.js";
import { lowBalances } from "../src/payments/float.js";
import { memoBoundTo, priceBounds, priceInBounds, chargeIdOfCredential } from "../src/agent-pay/rules.js";
import { NotImplementedError, PixMarketplaceSplitProvider, FiatOnrampProvider } from "../src/payments/providers/stubs.js";
import type { LedgerRow } from "../src/payments/ledger.js";
import { keccak256, stringToBytes } from "viem";

test("lifecycle: the happy path and the exits", () => {
  for (const [a, b] of [
    ["created", "pending_payment"],
    ["pending_payment", "confirmed"],
    ["confirmed", "fulfilling"],
    ["fulfilling", "fulfilled"],
    ["confirmed", "refunding"],
    ["fulfilling", "refunding"],
    ["refunding", "refunded"],
    ["pending_payment", "expired"],
    ["expired", "confirmed"],
    ["fulfilling", "confirmed"],
  ] as const) {
    assert.ok(canTransition(a, b), `${a} -> ${b}`);
  }
  for (const [a, b] of [
    ["fulfilled", "refunding"],
    ["refunded", "fulfilled"],
    ["pending_payment", "fulfilling"],
    ["created", "fulfilled"],
    ["refunding", "fulfilled"],
  ] as const) {
    assert.ok(!canTransition(a, b), `${a} -/-> ${b}`);
  }
  assert.deepEqual(sourcesOf("fulfilling"), ["confirmed"]);
  // terminal states never move, except that the chain's sale overrides open/abandoned charges (never a refunded one)
  for (const s of CHARGE_STATUSES) if (s !== "fulfilled" && s !== "refunded" && s !== "refunding") assert.ok(CHAIN_FULFILS.includes(s), s);
  assert.ok(!CHAIN_FULFILS.includes("refunded"));
  assert.ok(!CHAIN_FULFILS.includes("fulfilled"));
});

const agent = { status: 1, price: 10_000_000n, pricePerUse: 1_000_000n, totalSales: 3, maxSupply: 0 };

test("fulfil verdict: license", () => {
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 10_000_000n, agent, entriesPaused: false }), { action: "send", price: 10_000_000n });
  // price went down: honoured at the new price
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 12_000_000n, agent, entriesPaused: false }), { action: "send", price: 10_000_000n });
  // price went up beyond the charge: refund
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 9_000_000n, agent, entriesPaused: false }), { action: "refund", reason: "price_changed" });
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 10_000_000n, agent: { ...agent, maxSupply: 3 }, entriesPaused: false }), {
    action: "refund",
    reason: "sold_out",
  });
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 10_000_000n, agent: { ...agent, status: 2 }, entriesPaused: false }), {
    action: "refund",
    reason: "agent_unavailable",
  });
  // paused is transient: wait, never refund
  assert.deepEqual(fulfilVerdict({ kind: "license", charged: 10_000_000n, agent, entriesPaused: true }), { action: "wait", reason: "paused" });
});

test("fulfil verdict: credits and escrow", () => {
  assert.deepEqual(fulfilVerdict({ kind: "credits", charged: 5_000_000n, creditsAmount: 5, agent, entriesPaused: false }), { action: "send", price: 5_000_000n });
  assert.deepEqual(fulfilVerdict({ kind: "credits", charged: 5_000_000n, creditsAmount: 6, agent, entriesPaused: false }), {
    action: "refund",
    reason: "price_changed",
  });
  assert.deepEqual(fulfilVerdict({ kind: "credits", charged: 5_000_000n, creditsAmount: 5, agent: { ...agent, pricePerUse: 0n }, entriesPaused: false }), {
    action: "refund",
    reason: "pay_per_use_disabled",
  });
  assert.deepEqual(fulfilVerdict({ kind: "escrow", charged: 20_000_000n, agent: { ...agent, maxSupply: 3 }, entriesPaused: false }), {
    action: "send",
    price: 20_000_000n,
  });
});

test("purchaseRef encoding: kind << 248 | ref", () => {
  const ref = encodePurchaseRef(1, 42n);
  assert.equal(ref.length, 66);
  assert.deepEqual(decodePurchaseRef(ref), { kind: 1, value: 42n });
  const buyer = BigInt("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
  assert.deepEqual(decodePurchaseRef(encodePurchaseRef(2, buyer)), { kind: 2, value: buyer });
});

test("csv: fields are escaped and formulas neutralised", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(10n), "10");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("-5"), "-5");
  assert.equal(csvField(new Date("2026-10-11T00:00:00Z")), "2026-10-11T00:00:00.000Z");
});

test("csv: one header line and one line per row", () => {
  const row = {
    id: "pix_1",
    provider: "pix-intermediated",
    providerChargeId: "ORD1",
    purchaseId: `0x${"ab".repeat(32)}`,
    kind: "license",
    buyerWallet: "0x" + "1".repeat(40),
    payerWallet: "0x" + "2".repeat(40),
    agentId: "a".repeat(32),
    intent: {},
    amountBrlCents: 5400n,
    fxRate: "5.40000000",
    fxSource: "env",
    tokenAddress: "0x20c0000000000000000000000000000000000000",
    tokenAmount: 10_000_000n,
    gross: 10_000_000n,
    fee: 1_000_000n,
    creatorAmount: 9_000_000n,
    creatorDeferred: false,
    txHash: null,
    logIndex: null,
    ref: null,
    status: "fulfilled",
    error: "x, y",
    providerPayload: null,
    createdAt: new Date("2026-10-11T00:00:00Z"),
    confirmedAt: null,
    fulfilledAt: null,
    updatedAt: new Date("2026-10-11T00:00:00Z"),
  } as LedgerRow;
  const csv = ledgerCsv([row], 6);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith("charge_id,provider,"));
  assert.ok(lines[1]!.includes(',"x, y",'));
  assert.ok(lines[1]!.includes(",6,10000000,10000000,1000000,9000000,false,5400,5.40000000,env,"));
});

test("csv: date range (UTC days, inclusive end)", () => {
  const r = parseRange(["--from", "2026-10-01", "--to", "2026-10-31"]);
  assert.equal(r.from.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(r.to.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.throws(() => parseRange(["--from", "01/10/2026"]));
  assert.throws(() => parseRange(["--from", "2026-10-05", "--to", "2026-10-01"]));
  const d = parseRange([], new Date("2026-10-11T15:00:00Z"));
  assert.equal(d.from.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(d.to.toISOString(), "2026-10-12T00:00:00.000Z");
});

test("float alert: PLATFORM and RELAY below the threshold, never the treasury", () => {
  const low = lowBalances(
    [
      { name: "PLATFORM", address: "0x1", units: 10n },
      { name: "RELAY", address: "0x2", units: 1000n },
      { name: "TREASURY", address: "0x3", units: 0n },
    ],
    100n,
  );
  assert.deepEqual(
    low.map((b) => b.name),
    ["PLATFORM"],
  );
});

test("agent-pay: price bounds never go below the contracts' minPrice", () => {
  assert.deepEqual(priceBounds({ minUnits: 1_000_000n, maxUnits: 100_000_000n }, 5_000_000n), { min: 5_000_000n, max: 100_000_000n });
  assert.deepEqual(priceBounds({ minUnits: 8_000_000n, maxUnits: 100_000_000n }, 5_000_000n), { min: 8_000_000n, max: 100_000_000n });
  const b = { min: 5_000_000n, max: 100_000_000n };
  assert.ok(priceInBounds(5_000_000n, b));
  assert.ok(priceInBounds(100_000_000n, b));
  assert.ok(!priceInBounds(4_999_999n, b));
  assert.ok(!priceInBounds(100_000_001n, b));
});

test("agent-pay: MPP memo binding (tag, version, keccak(challengeId)[0..6] in bytes 25..31)", () => {
  const tag = keccak256(stringToBytes("mpp")).slice(2, 10);
  const nonce = keccak256(stringToBytes("challenge-123")).slice(2, 16);
  const memo = `0x${tag}01${"ab".repeat(10)}${"00".repeat(10)}${nonce}`;
  assert.equal(memo.length, 66);
  assert.ok(memoBoundTo(memo, "challenge-123"));
  assert.ok(!memoBoundTo(memo, "challenge-124"));
  assert.ok(!memoBoundTo(`0x${"00".repeat(4)}01${memo.slice(12)}`, "challenge-123"), "wrong tag");
  assert.ok(!memoBoundTo(`0x${tag}02${memo.slice(12)}`, "challenge-123"), "wrong version");
  assert.ok(!memoBoundTo("0x1234", "challenge-123"));
});

test("agent-pay: only our order ids are taken from a credential", () => {
  assert.equal(chargeIdOfCredential({ challenge: { request: { externalId: `ap_${"a1".repeat(12)}` } } }), `ap_${"a1".repeat(12)}`);
  assert.equal(chargeIdOfCredential({ challenge: { request: { externalId: "pix_123" } } }), null);
  assert.equal(chargeIdOfCredential({ challenge: { request: {} } }), null);
  assert.equal(chargeIdOfCredential(null), null);
});

test("stubs: pix-marketplace-split and fiat-onramp-to-wallet are documented but NotImplemented", async () => {
  for (const p of [new PixMarketplaceSplitProvider(), new FiatOnrampProvider()]) {
    assert.ok(p.capabilities().kinds.length > 0);
    const intent = { kind: "license" as const, agentId: "a".repeat(32), buyer: `0x${"1".repeat(40)}` as `0x${string}`, expectedPrice: 1n };
    await assert.rejects(p.createCharge(intent, { now: new Date() }), NotImplementedError);
    await assert.rejects(p.confirm("x"), NotImplementedError);
    await assert.rejects(p.fulfill("x"), NotImplementedError);
    await assert.rejects(p.reconcile(new Date()), NotImplementedError);
    await assert.rejects(p.refund("x", "r"), NotImplementedError);
  }
  assert.equal(new PixMarketplaceSplitProvider().capabilities().settlement, "external");
  assert.equal(new FiatOnrampProvider().capabilities().settlement, "buyer-onchain");
});

test("lifecycle: escrow-parameter, stake and zero-address reverts are unfulfillable (refund), not retried forever", async () => {
  const { UNFULFILLABLE_ERRORS } = await import("../src/payments/lifecycle.js");
  for (const name of ["InsufficientStake", "InvalidMilestones", "InvalidReviewWindow", "InvalidDeliveryDays", "ZeroAddress", "InvalidAmount"]) {
    assert.ok(UNFULFILLABLE_ERRORS.has(name), name);
  }
  assert.ok(!UNFULFILLABLE_ERRORS.has("Paused"), "paused is transient");
});

test("lifecycle: a failing fulfilment gives up after MAX_FULFIL_ATTEMPTS refusals or MAX_FULFIL_AGE_MS since payment", async () => {
  const { MAX_FULFIL_AGE_MS, MAX_FULFIL_ATTEMPTS, shouldGiveUp } = await import("../src/payments/lifecycle.js");
  const now = new Date("2026-10-11T12:00:00Z");
  const recent = new Date(now.getTime() - 60_000);
  assert.equal(shouldGiveUp({ attempts: MAX_FULFIL_ATTEMPTS - 1, paidAt: recent, now }), false);
  assert.equal(shouldGiveUp({ attempts: MAX_FULFIL_ATTEMPTS, paidAt: recent, now }), true);
  assert.equal(shouldGiveUp({ attempts: 0, paidAt: new Date(now.getTime() - MAX_FULFIL_AGE_MS), now }), true);
  assert.equal(shouldGiveUp({ attempts: 0, paidAt: null, now }), false);
});

test("agent-pay: memo nonce matches the challenge nonce; the settlement scan window covers TTL + grace + margin", async () => {
  const { challengeNonce, memoNonce, scanWindowStart, ORDER_EXPIRY_GRACE_MS, SETTLEMENT_SCAN_MARGIN_MS } = await import("../src/agent-pay/rules.js");
  const tag = keccak256(stringToBytes("mpp")).slice(2, 10);
  const memo = `0x${tag}01${"ab".repeat(20)}${challengeNonce("ch-1")}`;
  assert.equal(memoNonce(memo), challengeNonce("ch-1"));
  assert.ok(memoBoundTo(memo, "ch-1"));
  assert.equal(memoNonce(`0x${"00".repeat(32)}`), null);
  const now = new Date("2026-10-11T12:00:00Z");
  assert.equal(now.getTime() - scanWindowStart(now, 900_000).getTime(), 900_000 + ORDER_EXPIRY_GRACE_MS + SETTLEMENT_SCAN_MARGIN_MS);
});
