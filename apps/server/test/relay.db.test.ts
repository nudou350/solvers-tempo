// POST /api/relay (decisions.md D3) against `anvil --tempo` and the test database: an authenticated wallet's sponsored
// purchase succeeds and is logged; a transaction whose sender is not the session wallet is refused; exhausted daily
// quotas (per wallet, per IP) refuse; agents with an OAuth access token can use it; a reverting batch is refused by the
// simulation. Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
// Every relay_log row of this file carries an IP in 198.18.0.0/15 (benchmark range) and is deleted at the end.
import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createWalletClient, encodeFunctionData, erc20Abi, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { withRelay } from "viem/tempo";

import { KEYS, PATH_USD, ROLES, anvilAvailable, startAnvil, type AnvilEnv } from "@solvers/chain/testing";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;
const AGENT = "0x5e1a7e57a9e1a7e55e1a7e57a9e1a7e500000000000000000000000000000000" as Hex;
const PRICE = 10_000_000n;
const IP = "198.18.0.1";
const FUNDER = 3; // a funded anvil dev account with no role
const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("platform relay (/api/relay)", { skip }, () => {
  let env: AnvilEnv;
  let server: Server;
  let base = "";
  let db: typeof import("../src/db/index.js");
  let d: typeof import("drizzle-orm");
  let chain: typeof import("@solvers/chain");
  let signSession: typeof import("../src/auth/jwt.js").signSession;
  let serverEnv: typeof import("../src/env.js").env;
  const tokenWallets: string[] = [];

  const acct = (i: number) => privateKeyToAccount(KEYS[i]!);
  const pub = () => chain.publicClientFor(env.chain, env.rpcUrl);
  const bal = (a: Address) => pub().readContract({ address: PATH_USD, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  /** A wallet client whose relay transport carries the session token and a fixed client IP. */
  function relayed(account: PrivateKeyAccount, token: string | null, ip = IP) {
    const headers: Record<string, string> = { "x-forwarded-for": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    return createWalletClient({
      account,
      chain: env.chain,
      transport: withRelay(http(env.rpcUrl), http(`${base}/api/relay`, { fetchOptions: { headers } }), { policy: "sign-and-broadcast" }),
    });
  }

  async function freshBuyer(): Promise<PrivateKeyAccount> {
    const a = privateKeyToAccount(generatePrivateKey());
    const funder = chain.serverWalletClient(acct(FUNDER), env.chain, env.rpcUrl);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a.address, 100_000_000n] });
    await chain.waitForSuccess(pub() as never, await chain.sendCalls(funder as never, [{ to: PATH_USD, data }]));
    return a;
  }

  const purchase = (wallet: ReturnType<typeof relayed>, tag: string) =>
    chain.sendCalls(wallet as never, chain.purchaseLicenseCalls(env.deployment, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes(`relaytest:${tag}:${Math.random()}`)) }), {
      feePayer: true,
    });

  const logRows = async (sender: string) =>
    db.db.select().from(db.schema.relayLog).where(d.eq(db.schema.relayLog.sender, sender.toLowerCase()));

  before(async () => {
    env = await startAnvil();
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "31337",
      RPC_URL: env.rpcUrl,
      PLATFORM_PRIVATE_KEY: KEYS[ROLES.platform],
      RELAY_PRIVATE_KEY: KEYS[ROLES.relay],
      VERIFIER_PRIVATE_KEY: KEYS[ROLES.verifier],
      TREASURY_ADDRESS: env.deployment.treasury,
      RELAY_ENABLED: "true",
      JWT_SECRET: "j".repeat(40),
      SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
    });
    chain = await import("@solvers/chain");
    const chainMod = await import("../src/chain/index.js");
    const key = (i: number) => chain.loadAccount(KEYS[i], "K");
    chainMod.setChainContext({
      chain: env.chain,
      deployment: env.deployment,
      publicClient: chain.publicClientFor(env.chain, env.rpcUrl),
      accounts: { platform: key(ROLES.platform), relay: key(ROLES.relay), verifier: key(ROLES.verifier), admin: null },
      wallets: {
        platform: chain.serverWalletClient(key(ROLES.platform), env.chain, env.rpcUrl),
        verifier: chain.serverWalletClient(key(ROLES.verifier), env.chain, env.rpcUrl),
        admin: null,
      },
    });
    db = await import("../src/db/index.js");
    d = await import("drizzle-orm");
    ({ signSession } = await import("../src/auth/jwt.js"));
    ({ env: serverEnv } = await import("../src/env.js"));
    // Additive column of this area (schema.ts `// area: auth`); the integrator's regenerated baseline makes this a no-op.
    await db.pool.query("alter table relay_log add column if not exists sign_payload varchar(66)");
    await db.db.delete(db.schema.relayLog).where(d.like(db.schema.relayLog.ip, "198.18.%"));

    // The creator publishes (sponsored in-process by the relay key) and the admin approves.
    const relayKey = acct(ROLES.relay);
    const creator = chain.serverWalletClient(acct(ROLES.creator), env.chain, env.rpcUrl);
    const reg = chain.publishAgentCalls(env.deployment, {
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
    });
    await chain.waitForSuccess(pub() as never, await chain.sendCalls(creator as never, reg, { feePayer: relayKey }));
    const admin = chain.serverWalletClient(acct(ROLES.admin), env.chain, env.rpcUrl);
    await chain.waitForSuccess(pub() as never, await chain.sendCalls(admin as never, chain.approveAgentCalls(env.deployment, AGENT), { feePayer: relayKey }));

    const express = (await import("express")).default;
    const cookieParser = (await import("cookie-parser")).default;
    const { optionalAuth } = await import("../src/auth/jwt.js");
    const { relayRouter } = await import("../src/relay/routes.js");
    const { errorHandler } = await import("../src/lib/http.js");
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api", express.json({ limit: "256kb" }), cookieParser(), optionalAuth);
    app.use("/api", relayRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    server?.close();
    if (db) {
      await db.db.delete(db.schema.relayLog).where(d.like(db.schema.relayLog.ip, "198.18.%"));
      if (tokenWallets.length) await db.db.delete(db.schema.oauthTokens).where(d.inArray(db.schema.oauthTokens.wallet, tokenWallets));
      await db.pool.end();
    }
    await env?.stop();
  });

  it("an authenticated wallet's purchase is sponsored: it pays exactly the price, the relay pays the fee, relay_log has the row", async () => {
    const buyer = await freshBuyer();
    const relayAddr = acct(ROLES.relay).address;
    const [b0, r0] = [await bal(buyer.address), await bal(relayAddr)];
    const hash = await purchase(relayed(buyer, await signSession(buyer.address)), "ok");
    const receipt = await chain.waitForSuccess(pub() as never, hash);
    assert.equal(b0 - (await bal(buyer.address)), PRICE, "buyer pays the price and no fee");
    assert.ok((await bal(relayAddr)) < r0, "relay paid the fee");
    assert.equal(String((receipt as unknown as { feePayer?: string }).feePayer).toLowerCase(), relayAddr.toLowerCase());
    const rows = await logRows(buyer.address);
    const sponsored = rows.filter((r) => r.status === "sponsored");
    assert.equal(sponsored.length, 1, show(rows));
    const row = sponsored[0]!;
    assert.equal(row.ip, IP);
    assert.equal(row.method, "eth_fillTransaction");
    assert.match(row.signPayload ?? "", /^0x[0-9a-f]{64}$/);
    assert.ok((row.gasLimit ?? 0n) > 0n);
    assert.deepEqual(
      row.calls?.map((c) => c.to),
      [PATH_USD, env.deployment.license.toLowerCase()],
    );
  });

  it("a transaction whose sender is not the session wallet is refused and logged", async () => {
    const owner = await freshBuyer();
    const intruder = await freshBuyer();
    const before = await bal(intruder.address);
    await assert.rejects(purchase(relayed(intruder, await signSession(owner.address)), "forged"));
    assert.equal(await bal(intruder.address), before, "nothing was bought");
    const rows = await logRows(intruder.address);
    assert.ok(rows.some((r) => r.status === "refused" && r.reason === "sender does not match the session wallet"), show(rows));
    assert.ok(!rows.some((r) => r.status === "sponsored"));
  });

  it("without a session the relay answers 401", async () => {
    const buyer = await freshBuyer();
    await assert.rejects(purchase(relayed(buyer, null), "anon"));
    const res = await fetch(`${base}/api/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    assert.equal(res.status, 401);
  });

  it("an exhausted daily gas quota of the wallet refuses the next transaction", async () => {
    const buyer = await freshBuyer();
    await db.db.insert(db.schema.relayLog).values({
      sender: buyer.address.toLowerCase(),
      ip: "198.18.9.9",
      method: "eth_fillTransaction",
      gasLimit: serverEnv.RELAY_DAILY_GAS_PER_WALLET,
      status: "sponsored",
    });
    const before = await bal(buyer.address);
    await assert.rejects(purchase(relayed(buyer, await signSession(buyer.address)), "quota"));
    assert.equal(await bal(buyer.address), before);
    const rows = await logRows(buyer.address);
    assert.ok(rows.some((r) => r.status === "refused" && /quota of this wallet/.test(r.reason ?? "")), show(rows));
  });

  it("an exhausted daily gas quota of the IP refuses another wallet from that IP", async () => {
    const ip = "198.18.7.7";
    await db.db.insert(db.schema.relayLog).values({ sender: null, ip, method: "eth_fillTransaction", gasLimit: serverEnv.RELAY_DAILY_GAS_PER_IP, status: "sponsored" });
    const buyer = await freshBuyer();
    await assert.rejects(purchase(relayed(buyer, await signSession(buyer.address), ip), "ip-quota"));
    const rows = await logRows(buyer.address);
    assert.ok(rows.some((r) => r.status === "refused" && /network address/.test(r.reason ?? "")), show(rows));
  });

  it("an agent's OAuth access token opens the relay too", async () => {
    const buyer = await freshBuyer();
    tokenWallets.push(buyer.address.toLowerCase());
    const { _issueTokensForTests } = await import("../src/oauth/routes.js");
    const tok = await _issueTokensForTests("agent", buyer.address, null);
    const before = await bal(buyer.address);
    await chain.waitForSuccess(pub() as never, await purchase(relayed(buyer, tok.access_token), "agent"));
    assert.equal(before - (await bal(buyer.address)), PRICE);
  });

  it("the simulation refuses a reverting batch (a sponsored revert would still burn fees)", async () => {
    const { relayCheck, limitsFromEnv } = await import("../src/relay/service.js");
    const buyer = await freshBuyer();
    const reserved: unknown[] = [];
    const check = relayCheck({
      publicClient: pub() as never,
      limits: limitsFromEnv(),
      log: {
        reserve: async (r) => {
          reserved.push(r);
          return { id: 1 };
        },
        sponsored: async () => undefined,
        refused: async () => undefined,
      },
    });
    const unknownAgent = ("0x" + "ab".repeat(16) + "00".repeat(16)) as Hex;
    const calls = chain.purchaseLicenseCalls(env.deployment, { agentId: unknownAgent, price: PRICE, purchaseId: keccak256(toBytes("sim")) });
    const refusal = await check({ from: buyer.address, calls, gas: 1_000_000n }, { sender: buyer.address });
    assert.match(refusal ?? "", /^simulation reverted: /);
    assert.equal(reserved.length, 0, "no quota reserved for a refused transaction");
    const okCalls = chain.purchaseLicenseCalls(env.deployment, { agentId: AGENT, price: PRICE, purchaseId: keccak256(toBytes("sim-ok")) });
    assert.equal(await check({ from: buyer.address, calls: okCalls, gas: 1_000_000n }, { sender: buyer.address }), null);
    assert.equal(reserved.length, 1);
  });

  it("the relay only answers its JSON-RPC methods", async () => {
    const res = await fetch(`${base}/api/relay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await signSession(acct(ROLES.buyer).address)}`, "x-forwarded-for": IP },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [PATH_USD, "latest"] },
        { jsonrpc: "2.0", id: 2, method: "eth_chainId" },
      ]),
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { id: number; error?: { code: number }; result?: string }[];
    assert.equal(out[0]!.error?.code, -32601);
    assert.equal(out[1]!.result, "0x7a69");
  });

  it("nested batches and raw transactions that do not ask for sponsorship are refused", async () => {
    const auth = { "content-type": "application/json", authorization: `Bearer ${await signSession(acct(ROLES.buyer).address)}`, "x-forwarded-for": IP };
    const nested = await fetch(`${base}/api/relay`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify([[{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }]]),
    });
    assert.equal(nested.status, 400, "a batch item that is itself an array");
    const buyer = acct(ROLES.buyer);
    const raw = await buyer.signTransaction({ type: "eip1559", chainId: env.chain.id, to: PATH_USD, value: 0n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const res = await fetch(`${base}/api/relay`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_sendRawTransaction", params: [raw] }),
    });
    const out = (await res.json()) as { error?: { code: number; message: string } };
    assert.equal(out.error?.code, -32602, "the relay is not a broadcast proxy");
  });

  it("the global daily budget refuses every wallet once reached, then frees up", async () => {
    const ip = "198.18.5.5";
    const [row] = await db.db
      .insert(db.schema.relayLog)
      .values({ sender: null, ip: "198.18.250.250", method: "eth_fillTransaction", gasLimit: serverEnv.RELAY_DAILY_GAS_GLOBAL, status: "sponsored" })
      .returning({ id: db.schema.relayLog.id });
    try {
      const buyer = await freshBuyer();
      await assert.rejects(purchase(relayed(buyer, await signSession(buyer.address), ip), "global"));
      const rows = await logRows(buyer.address);
      assert.ok(rows.some((r) => r.status === "refused" && /sponsorship budget/.test(r.reason ?? "")), show(rows));
    } finally {
      await db.db.delete(db.schema.relayLog).where(d.eq(db.schema.relayLog.id, row!.id));
    }
  });
});

