import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARGE_STATUSES,
  ChargeView,
  ConfirmResponse,
  License,
  PAYMENT_PROVIDER_IDS,
  PixCharge,
  PublicConfig,
  PublicationConfirmInput,
  PurchaseIntent,
  PurchaseIntentInput,
  RESERVED_SLUGS,
  RoyaltyQuote,
  SiweNonce,
  TxResponse,
  purchaseIdFor,
  toChargeView,
  type Charge,
} from "./index.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const TOKEN_CHECKSUMMED = "0x20C000000000000000000000b9537d11c60E8b50";
const HASH = `0x${"ab".repeat(32)}`;

const config = {
  chainId: 42431,
  rpcUrl: "https://rpc.moderato.tempo.xyz",
  explorerUrl: "https://explore.testnet.tempo.xyz",
  contracts: { registry: A(1), license: A(2), credits: A(3), reviews: A(4), escrow: A(5), staking: A(6) },
  paymentToken: { address: TOKEN_CHECKSUMMED, symbol: "pathUSD", decimals: 6 },
  feeBps: 1000,
  royalty: { creatorBps: 500, platformBps: 500 },
  minPriceUnits: "5000000",
  faucetEnabled: true,
  brlPerUsd: 5.4,
  connectorUrl: "https://example.test/mcp",
  freeTrialUses: 3,
  reviewWindowSecs: 259_200,
  guaranteeLimitsUsdc: { none: 0, limited: 20, full: 500 },
  guaranteeMinSales: 3,
  guaranteeMinRating: 4,
  pix: { enabled: true, simulate: true, provider: "simulated", minBrl: 5, maxBrl: 5000 },
  solanaPay: { enabled: false, cluster: "devnet", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", recipient: null, tokenSymbol: "USDC" },
  agentPay: { enabled: false, protocol: "mpp", minPriceUnits: null, maxPriceUnits: null },
  serverTime: 1_791_000_000,
};

test("PublicConfig parses and normalises addresses", () => {
  const c = PublicConfig.parse(config);
  assert.equal(c.paymentToken.address, TOKEN_CHECKSUMMED.toLowerCase());
  assert.equal(c.contracts.license, A(2));
  assert.equal(c.minPriceUnits, "5000000");
  assert.equal(BigInt(c.minPriceUnits), 5_000_000n);
  assert.ok(PublicConfig.safeParse({ ...config, feeBps: null, royalty: { creatorBps: 500, platformBps: null } }).success);
});

test("PublicConfig rejects bad money and chain fields", () => {
  const bad = [
    { ...config, minPriceUnits: 5_000_000 },
    { ...config, minPriceUnits: "5.0" },
    { ...config, feeBps: 2001 },
    { ...config, royalty: { creatorBps: 2501, platformBps: 500 } },
    { ...config, contracts: { ...config.contracts, escrow: "0x123" } },
    { ...config, chainId: 0 },
    { ...config, agentPay: { ...config.agentPay, protocol: "other" } },
    { ...config, serverTime: undefined },
    { ...config, serverTime: 1.5 },
  ];
  for (const b of bad) assert.equal(PublicConfig.safeParse(b).success, false, JSON.stringify(b).slice(0, 80));
});

test("TxResponse: calls for a sponsored 0x76 batch", () => {
  const tx = TxResponse.parse({
    calls: [
      { to: TOKEN_CHECKSUMMED, data: "0x095ea7b3" },
      { to: A(2), data: "0xdeadbeef" },
    ],
    feePayer: true,
    chainId: 42431,
    purchaseId: HASH.toUpperCase().replace("0X", "0x"),
  });
  assert.equal(tx.calls[0]!.to, TOKEN_CHECKSUMMED.toLowerCase());
  assert.equal(tx.purchaseId, HASH);
  assert.ok(TxResponse.safeParse({ calls: [{ to: A(1), data: "0x" }], feePayer: true, chainId: 4217 }).success);
  const invalid = [
    { calls: [], feePayer: true, chainId: 42431 },
    { calls: [{ to: A(1), data: "0x" }], feePayer: false, chainId: 42431 },
    { calls: [{ to: A(1), data: "0x", value: "1" }], feePayer: true, chainId: 42431 },
    { calls: [{ to: A(1), data: "0x0" }], feePayer: true, chainId: 42431 },
    { transaction: "AAAA", feePayer: true, chainId: 42431 },
  ];
  for (const b of invalid) assert.equal(TxResponse.safeParse(b).success, false, JSON.stringify(b));
});

test("PurchaseIntent and its input", () => {
  const intent = PurchaseIntent.parse({
    calls: [{ to: TOKEN_CHECKSUMMED, data: "0x095ea7b3" }, { to: A(2), data: "0x01" }],
    feePayer: true,
    chainId: 42431,
    purchaseId: purchaseIdFor("ch_1"),
    chargeId: "ch_1",
    kind: "license",
    agentId: "3f9a1c2e7b8d4e6fa1b2c3d4e5f60718",
    amountUnits: "5000000",
  });
  assert.equal(intent.purchaseId, purchaseIdFor("ch_1"));
  assert.equal(PurchaseIntent.safeParse({ ...intent, purchaseId: undefined }).success, false);
  assert.ok(PurchaseIntentInput.safeParse({ kind: "license", agentId: "x", expectedPriceUnits: "5000000" }).success);
  assert.ok(PurchaseIntentInput.safeParse({ kind: "credits", agentId: "x", amount: 10 }).success);
  assert.ok(PurchaseIntentInput.safeParse({ kind: "escrow", agentId: "x", task: { title: "Landing", description: "One page", deliveryDays: 7 } }).success);
  assert.equal(PurchaseIntentInput.safeParse({ kind: "credits", agentId: "x", amount: 0 }).success, false);
  assert.equal(PurchaseIntentInput.safeParse({ kind: "escrow", agentId: "x", task: { title: "T", description: "D", deliveryDays: 61 } }).success, false);
  assert.equal(PurchaseIntentInput.safeParse({ kind: "permanent", agentId: "x" }).success, false);
});

test("ConfirmResponse, publication confirm and royalty quote use 0x tx hashes", () => {
  assert.ok(ConfirmResponse.safeParse({ txHash: HASH, status: "confirmed" }).success);
  assert.equal(ConfirmResponse.safeParse({ txHash: "5".repeat(88), status: "confirmed" }).success, false);
  assert.ok(PublicationConfirmInput.safeParse({ submissionId: "s1", txHash: HASH, kind: "register-agent" }).success);
  assert.equal(PublicationConfirmInput.safeParse({ submissionId: "s1", txHash: HASH.slice(0, 65) }).success, false);
  assert.equal(PublicationConfirmInput.safeParse({ submissionId: "s1", signature: HASH }).success, false);
  const q = RoyaltyQuote.parse({
    licenseId: "12",
    agentId: "3f9a1c2e7b8d4e6fa1b2c3d4e5f60718",
    token: TOKEN_CHECKSUMMED,
    decimals: 6,
    originalPriceUnits: "10000000",
    creatorBps: 500,
    platformBps: 500,
    creatorAmountUnits: "500000",
    platformAmountUnits: "500000",
    totalUnits: "1000000",
  });
  assert.equal(q.token, TOKEN_CHECKSUMMED.toLowerCase());
});

test("License has no secondary-market fields; wallets are addresses", () => {
  const l = License.parse({ id: "1", agentId: "a", ownerWallet: TOKEN_CHECKSUMMED, acquiredAt: "2026-10-10T00:00:00Z", type: "permanent" });
  assert.deepEqual(Object.keys(l).sort(), ["acquiredAt", "agentId", "id", "ownerWallet", "type"]);
  assert.equal(License.safeParse({ ...l, ownerWallet: "not-a-wallet" }).success, false);
});

test("SiweNonce", () => {
  assert.ok(SiweNonce.safeParse({ nonce: "abcdEFGH1234", chainId: 42431, statement: "Sign in to Solvers.", expiresAt: "2026-10-10T00:05:00Z" }).success);
  assert.equal(SiweNonce.safeParse({ nonce: "short", chainId: 42431, statement: "", expiresAt: "" }).success, false);
  // The server's issue time is kept (the client builds the message with it instead of its own clock).
  const n = SiweNonce.parse({ nonce: "abcdEFGH1234", chainId: 42431, statement: "s", expiresAt: "2026-10-10T00:05:00.000Z", issuedAt: "2026-10-10T00:00:00.000Z" });
  assert.equal(n.issuedAt, "2026-10-10T00:00:00.000Z");
  assert.equal(SiweNonce.safeParse({ nonce: "abcdEFGH1234", chainId: 42431, statement: "s", expiresAt: "x", issuedAt: "yesterday" }).success, false);
});

test("payments: statuses, providers and the API view of a charge", () => {
  assert.deepEqual(CHARGE_STATUSES, ["created", "pending_payment", "confirmed", "fulfilling", "fulfilled", "refunding", "refunded", "expired", "failed"]);
  assert.deepEqual(PAYMENT_PROVIDER_IDS, ["direct-wallet", "pix-intermediated", "agent-pay", "solana-pay", "pix-marketplace-split", "fiat-onramp-to-wallet", "fake"]);
  const now = new Date("2026-10-10T12:00:00Z");
  const charge: Charge = {
    id: "ch_1",
    provider: "pix-intermediated",
    providerChargeId: "ORD123",
    purchaseId: purchaseIdFor("ch_1"),
    kind: "license",
    agentId: "3f9a1c2e7b8d4e6fa1b2c3d4e5f60718",
    buyer: A(9) as `0x${string}`,
    status: "fulfilled",
    amount: 2n ** 70n,
    token: TOKEN_CHECKSUMMED.toLowerCase() as `0x${string}`,
    amountBrlCents: 2700,
    fxRate: "5.40000000",
    calls: null,
    txHash: HASH as `0x${string}`,
    error: null,
    payment: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    confirmedAt: now,
    fulfilledAt: now,
  };
  const view = toChargeView(charge);
  assert.equal(view.amountUnits, (2n ** 70n).toString());
  assert.equal(view.createdAt, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(ChargeView.parse(JSON.parse(JSON.stringify(view))), view);
});

test("PixCharge carries the charge status and the fulfilment tx hash", () => {
  const p = {
    id: "ch_1",
    provider: "simulated",
    status: "pending_payment",
    kind: "escrow",
    agentId: "a",
    purchaseId: purchaseIdFor("ch_1"),
    amountBrl: 27,
    amountUnits: "5000000",
    qrCode: "SIMULATED",
    qrCodeBase64: null,
    ticketUrl: null,
    expiresAt: "2026-10-10T12:30:00Z",
    txHash: null,
    explorerUrl: null,
    simulated: true,
    createdAt: "2026-10-10T12:00:00Z",
  };
  assert.ok(PixCharge.safeParse(p).success);
  assert.equal(PixCharge.safeParse({ ...p, status: "credited" }).success, false);
  assert.equal(PixCharge.safeParse({ ...p, provider: "other" }).success, false);
});

test("reserved slugs protect the platform and brands", () => {
  for (const s of ["solvers", "admin", "api", "mcp", "oauth", "claude", "usdc"]) assert.ok(RESERVED_SLUGS.includes(s), s);
});
