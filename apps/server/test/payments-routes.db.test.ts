// HTTP surface of the payments module: purchase intents (direct-wallet), Pix charges (simulated) and its webhook, and
// the agent-pay MPP flow end to end with the real `mppx` client (pull mode: the agent signs, the server co-signs the fee
// with the RELAY key and broadcasts). Needs TEST_DATABASE_URL (disposable, migrated) and `anvil` (Foundry).
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KEYS, anvilAvailable } from "@solvers/chain/testing";
import { PRICE, setupPaymentsChain, type PaymentsChain } from "./helpers/payments-chain.js";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;

let t: PaymentsChain;
let base = "";
let server: import("node:http").Server;
let signSession: (wallet: string) => Promise<string>;
let agentId: string;

const AGENT_KEY = KEYS[9]!; // the paying agent's wallet

async function call(method: string, path: string, o: { wallet?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.wallet) headers.authorization = `Bearer ${await signSession(o.wallet)}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

describe("payments HTTP routes and agent-pay", { skip }, () => {
  before(async () => {
    // The API URL must be known before env.ts loads (it is the MPP realm); the port is fixed after listen.
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
      probe.on("error", reject);
    });
    t = await setupPaymentsChain({
      AGENT_PAY_ENABLED: "true",
      MPP_SECRET_KEY: "mpp-secret-for-tests-0123456789abcdef",
      PUBLIC_API_URL: `http://127.0.0.1:${port}`,
      AGENT_PAY_MIN_PRICE: "5",
      AGENT_PAY_MAX_PRICE: "100",
    });
    ({ signSession } = await import("../src/auth/jwt.js"));
    const { paymentsRouter } = await import("../src/payments/routes.js");
    const { pixRouter, pixWebhookRouter } = await import("../src/pix/routes.js");
    const { agentPayRouter } = await import("../src/agent-pay/routes.js");
    const { errorHandler } = await import("../src/lib/http.js");
    const app = express();
    app.use("/webhooks", pixWebhookRouter);
    app.use(express.json());
    app.use("/api", paymentsRouter, pixRouter, agentPayRouter);
    app.use(errorHandler);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(port, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve(s)));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agentId = await t.newAgent();
  });

  after(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await t?.stop();
  });

  it("POST /api/purchases/intent needs a session", async () => {
    const r = await call("POST", "/api/purchases/intent", { body: { kind: "license", agentId } });
    assert.equal(r.status, 401);
  });

  it("purchase intent -> the wallet's batch -> GET /api/purchases/:id fulfilled", async () => {
    const buyer = t.buyers[0]!;
    const r = await call("POST", "/api/purchases/intent", { wallet: buyer, body: { kind: "license", agentId, expectedPriceUnits: PRICE.toString() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.feePayer, true);
    assert.equal(r.json.chainId, 31337);
    assert.equal(r.json.amountUnits, PRICE.toString());
    const calls = r.json.calls as { to: Hex; data: Hex }[];
    assert.equal(calls.length, 2);
    const chargeId = r.json.chargeId as string;
    const pending = await call("GET", `/api/purchases/${chargeId}`, { wallet: buyer });
    assert.equal(pending.json.status, "pending_payment");
    await t.sendAs(t.buyerKeys[0]!, calls, { sponsored: true });
    const done = await call("GET", `/api/purchases/${chargeId}`, { wallet: buyer });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, "fulfilled");
    assert.equal(done.json.provider, "direct-wallet");
    // somebody else's charge is not visible
    assert.equal((await call("GET", `/api/purchases/${chargeId}`, { wallet: t.buyers[1]! })).status, 404);
  });

  it("purchase intent: a stale expected price answers 409 price_changed before any row", async () => {
    const r = await call("POST", "/api/purchases/intent", { wallet: t.buyers[1]!, body: { kind: "license", agentId, expectedPriceUnits: "1" } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "price_changed");
    assert.equal(r.json.priceUnits, PRICE.toString());
  });

  it("Pix: charge in BRL, simulated payment, fulfilled on-chain by the platform", async () => {
    const buyer = t.buyers[1]!;
    const r = await call("POST", "/api/pix/charges", { wallet: buyer, body: { kind: "license", agentId } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.provider, "simulated");
    assert.equal(r.json.status, "pending_payment");
    assert.equal(r.json.amountBrl, 54);
    assert.equal(r.json.amountUnits, PRICE.toString());
    assert.match(String(r.json.qrCode), /^PIX-TEST-SOLVERS\|DO-NOT-PAY/);
    const id = r.json.id as string;
    const float0 = await t.balance(t.platform);
    const s = await call("POST", `/api/pix/charges/${id}/simulate`, { wallet: buyer });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.status, "fulfilled");
    assert.match(String(s.json.txHash), /^0x[0-9a-f]{64}$/);
    assert.equal(float0 - (await t.balance(t.platform)), PRICE);
    // simulating again does not buy twice
    const again = await call("POST", `/api/pix/charges/${id}/simulate`, { wallet: buyer });
    assert.equal(again.json.status, "fulfilled");
    assert.equal(float0 - (await t.balance(t.platform)), PRICE);
    // another wallet cannot see or simulate it
    assert.equal((await call("GET", `/api/pix/charges/${id}`, { wallet: t.buyers[0]! })).status, 404);
  });

  it("Pix: at most 3 open charges per wallet", async () => {
    const buyer = t.buyers[2]!;
    for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/pix/charges", { wallet: buyer, body: { kind: "license", agentId } })).status, 200);
    const r = await call("POST", "/api/pix/charges", { wallet: buyer, body: { kind: "license", agentId } });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, "pix_pending_limit");
  });

  it("Mercado Pago webhook: unsigned is refused, signed but unknown is ignored", async () => {
    const r = await call("POST", "/webhooks/mercadopago?data.id=ORD1&type=order", { body: { type: "order", data: { id: "ORD1" } } });
    assert.equal(r.status, 401);
    const { createHmac } = await import("node:crypto");
    const ts = String(Date.now());
    const v1 = createHmac("sha256", "whsec-payments-test").update(`id:ord1;request-id:r1;ts:${ts};`).digest("hex");
    const signed = await call("POST", "/webhooks/mercadopago?data.id=ORD1&type=order", {
      body: { type: "order", data: { id: "ORD1" } },
      headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": "r1" },
    });
    assert.equal(signed.status, 200);
    assert.equal(signed.json.ignored, true);
  });

  describe("agent-pay (MPP)", () => {
    it("quote", async () => {
      const r = await call("GET", `/api/agent-pay/solvers/${agentId}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.available, true, JSON.stringify(r.json));
      assert.equal(r.json.priceUnits, PRICE.toString());
      assert.equal(r.json.protocol, "mpp");
    });

    it("no credential: an order and a 402 Payment challenge", async () => {
      const r = await call("POST", `/api/agent-pay/solvers/${agentId}/license`);
      assert.equal(r.status, 402);
      assert.match(r.headers.get("www-authenticate") ?? "", /^Payment /);
    });

    it("pays with the mppx client: settled into the float, license minted to the paying agent, fee sponsored", async () => {
      const { Mppx, tempo } = await import("mppx/client");
      const agent = privateKeyToAccount(AGENT_KEY);
      const client = Mppx.create({
        polyfill: false,
        methods: [tempo.charge({ account: agent, getClient: () => t.ctx.publicClient as never, mode: "pull" })],
      } as never) as unknown as { fetch: typeof fetch };
      const agentBefore = await t.balance(agent.address.toLowerCase() as Hex);
      const floatBefore = await t.balance(t.platform);
      const relayBefore = await t.balance(t.address(8));
      const res = await client.fetch(`${base}/api/agent-pay/solvers/${agentId}/license`, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.status, "fulfilled");
      assert.equal(body.owner, agent.address.toLowerCase());
      assert.ok(body.licenseId, "token id of the license");
      assert.match(String(body.settlementTx), /^0x[0-9a-f]{64}$/);
      assert.equal(agentBefore - (await t.balance(agent.address.toLowerCase() as Hex)), PRICE, "the agent paid exactly the price, no fee");
      assert.equal(await t.balance(t.platform), floatBefore, "settlement in, purchase out: the float is unchanged");
      assert.ok((await t.balance(t.address(8))) < relayBefore, "RELAY paid the fees");
      const { readPurchaseRef } = await import("../src/payments/chain.js");
      assert.notEqual(await readPurchaseRef(t.platform, String(body.purchaseId)), 0n);

      // The order is readable later, and the recovery scan finds the same settlement from the challenge memo.
      const order = await call("GET", `/api/agent-pay/orders/${body.orderId as string}`);
      assert.equal(order.json.status, "fulfilled");
      const { AgentPayProvider } = await import("../src/agent-pay/provider.js");
      const { loadCharge } = await import("../src/payments/ledger.js");
      const row = (await loadCharge(String(body.orderId)))!;
      assert.equal(await new AgentPayProvider().recoverSettlement(row), String(body.settlementTx));
    });

    it("one order, two credentials sent at once: one payment is processed, the agent pays once", async () => {
      const { Mppx, tempo } = await import("mppx/client");
      const agent = privateKeyToAccount(KEYS[4]!);
      const client = Mppx.create({
        polyfill: false,
        methods: [tempo.charge({ account: agent, getClient: () => t.ctx.publicClient as never, mode: "pull" })],
      } as never) as unknown as { createCredential: (r: Response) => Promise<string> };
      const url = `${base}/api/agent-pay/solvers/${agentId}/license`;
      const challenge = await fetch(url, { method: "POST" });
      assert.equal(challenge.status, 402);
      const c1 = await client.createCredential(challenge.clone());
      const c2 = await client.createCredential(challenge.clone());
      const before = await t.balance(agent.address.toLowerCase() as Hex);
      const [r1, r2] = await Promise.all([
        fetch(url, { method: "POST", headers: { authorization: c1 } }),
        fetch(url, { method: "POST", headers: { authorization: c2 } }),
      ]);
      const bodies = [(await r1.json()) as Record<string, unknown>, (await r2.json()) as Record<string, unknown>];
      const statuses = [r1.status, r2.status].sort();
      assert.ok(statuses.includes(200) || statuses.includes(202), JSON.stringify(bodies));
      const other = bodies[[r1.status, r2.status].findIndex((s) => s !== 200 && s !== 202)];
      if (other) assert.equal(other.code, "payment_in_progress", JSON.stringify(bodies));
      assert.equal(before - (await t.balance(agent.address.toLowerCase() as Hex)), PRICE, "the agent paid exactly once");
      const { Credential } = await import("mppx");
      const orderId = (Credential.deserialize(Credential.extractPaymentScheme(c1) ?? c1).challenge.request as { externalId: string }).externalId;
      const order = await call("GET", `/api/agent-pay/orders/${orderId}`);
      assert.equal(order.json.status, "fulfilled");
      assert.equal(order.json.owner, agent.address.toLowerCase());
    });

    it("a credential whose challenge was not issued by this server touches nothing", async () => {
      const { Mppx, tempo } = await import("mppx/client");
      const { Credential } = await import("mppx");
      const agent = privateKeyToAccount(KEYS[3]!);
      const client = Mppx.create({
        polyfill: false,
        methods: [tempo.charge({ account: agent, getClient: () => t.ctx.publicClient as never, mode: "pull" })],
      } as never) as unknown as { createCredential: (r: Response) => Promise<string> };
      const url = `${base}/api/agent-pay/solvers/${agentId}/license`;
      const challenge = await fetch(url, { method: "POST" });
      const valid = await client.createCredential(challenge);
      const parsed = Credential.deserialize(Credential.extractPaymentScheme(valid) ?? valid);
      const orderId = (parsed.challenge.request as { externalId: string }).externalId;
      const forged = Credential.serialize({ ...parsed, challenge: { ...parsed.challenge, expires: new Date(Date.now() + 86_400_000).toISOString() } } as never);
      const r = await fetch(url, { method: "POST", headers: { authorization: forged } });
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(body.code, "invalid_payment");
      const { loadCharge } = await import("../src/payments/ledger.js");
      const row = (await loadCharge(orderId))!;
      assert.equal(row.status, "pending_payment");
      assert.equal(row.buyerWallet, "0x0000000000000000000000000000000000000000", "no payer bound");
      const { payloadOf } = await import("../src/payments/ledger.js");
      assert.equal(payloadOf(row).settling, undefined, "no claim taken");
    });

    it("an agent without the funds gets nothing and the order stays unpaid", async () => {
      const { Mppx, tempo } = await import("mppx/client");
      const { generatePrivateKey } = await import("viem/accounts");
      const broke = privateKeyToAccount(generatePrivateKey());
      const client = Mppx.create({
        polyfill: false,
        methods: [tempo.charge({ account: broke, getClient: () => t.ctx.publicClient as never, mode: "pull" })],
      } as never) as unknown as { fetch: typeof fetch };
      const res = await client.fetch(`${base}/api/agent-pay/solvers/${agentId}/license`, { method: "POST" }).catch((e: Error) => e);
      if (res instanceof Error) return; // the client refused to pay (insufficient balance): nothing happened
      assert.notEqual(res.status, 200);
    });
  });
});
