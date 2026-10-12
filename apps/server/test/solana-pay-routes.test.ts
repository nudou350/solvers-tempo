import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SolanaPayConfig } from "@solvers/shared";
import { writeTestKeypair } from "./helpers/solana-keypair.js";

// Solana Pay without a database, a chain or Solana: the routes behind the session and the off switch, the public config
// block, and the env rules (network pairing with Tempo, keypair required). `createApp([])` + a signed session.

const WALLET = "0x1111111111111111111111111111111111111111";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("solana pay routes (disabled, no database)", () => {
  let base = "";
  let close: () => Promise<void> = async () => undefined;
  let token = "";

  before(async () => {
    const { createApp } = await import("../src/app.js");
    const { solanaPayRouter } = await import("../src/solana-pay/routes.js");
    const jwt = await import("../src/auth/jwt.js");
    token = await jwt.signSession(WALLET);
    const app = createApp([(a) => a.use("/api", solanaPayRouter)]);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });

  after(() => close());

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it("both routes require a session", async () => {
    assert.equal((await call("POST", "/api/solana-pay/charges", { kind: "license", agentId: "a" }, false)).status, 401);
    assert.equal((await call("GET", "/api/solana-pay/charges/sol_x", undefined, false)).status, 401);
  });

  it("creating a charge while Solana Pay is off answers 400 solana_pay_unavailable", async () => {
    const r = await call("POST", "/api/solana-pay/charges", { kind: "license", agentId: "a" });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "solana_pay_unavailable");
  });

  it("the public config exposes the solanaPay block (off: no recipient)", async () => {
    const { solanaPayConfig } = await import("../src/solana-pay/provider.js");
    const c = solanaPayConfig();
    assert.deepEqual(c, { enabled: false, cluster: "devnet", mint: DEVNET_USDC, recipient: null, tokenSymbol: "USDC" });
    assert.ok(SolanaPayConfig.safeParse(c).success);
  });

  it("the payments module registers the provider (reconcile keeps working when it is off)", async () => {
    const { solanaPayProvider } = await import("../src/payments/index.js");
    assert.equal(solanaPayProvider().id, "solana-pay");
  });
});

describe("env: Solana Pay", () => {
  const BASE: NodeJS.ProcessEnv = { JWT_SECRET: "j".repeat(32), SERVER_KEK: "k".repeat(44) };
  const MAINNET: NodeJS.ProcessEnv = { ...BASE, CHAIN_ID: "4217", PAYMENT_TOKEN: "0x20c0000000000000000000000000000000000000" };
  let loadEnv: typeof import("../src/env.js").loadEnv;
  const kp = writeTestKeypair();

  before(async () => {
    ({ loadEnv } = await import("../src/env.js"));
  });

  it("defaults follow the Tempo network: devnet off mainnet, mainnet-beta on mainnet", () => {
    const local = loadEnv({ ...BASE });
    assert.equal(local.SOLANA_PAY_ENABLED, false);
    assert.equal(local.SOLANA_CLUSTER, "devnet");
    assert.equal(local.SOLANA_RPC_URL, "https://api.devnet.solana.com");
    assert.equal(local.SOLANA_PAY_MINT, DEVNET_USDC);
    assert.equal(local.SOLANA_PAY_TTL_MIN, 30);
    assert.equal(loadEnv({ ...BASE, CHAIN_ID: "42431" }).SOLANA_CLUSTER, "devnet");
    const main = loadEnv({ ...MAINNET });
    assert.equal(main.SOLANA_CLUSTER, "mainnet-beta");
    assert.equal(main.SOLANA_RPC_URL, "https://api.mainnet-beta.solana.com");
    assert.equal(main.SOLANA_PAY_MINT, MAINNET_USDC);
  });

  it("enabled needs the keypair, and a readable one (the message never quotes the file)", () => {
    assert.throws(() => loadEnv({ ...BASE, SOLANA_PAY_ENABLED: "true" }), /SOLANA_PAY_KEYPAIR/);
    const bad = kp.path.replace(/keypair\.json$/, "bad.json");
    writeFileSync(bad, '[1,2,"secret-material"]');
    assert.throws(
      () => loadEnv({ ...BASE, SOLANA_PAY_ENABLED: "true", SOLANA_PAY_KEYPAIR: bad }),
      (e: unknown) => e instanceof Error && /SOLANA_PAY_KEYPAIR/.test(e.message) && !e.message.includes("secret-material"),
    );
    const ok = loadEnv({ ...BASE, CHAIN_ID: "42431", SOLANA_PAY_ENABLED: "true", SOLANA_PAY_KEYPAIR: kp.path });
    assert.equal(ok.SOLANA_PAY_ENABLED, true);
  });

  it("the Solana cluster must pair with the Tempo network when enabled", () => {
    const on = { SOLANA_PAY_ENABLED: "true", SOLANA_PAY_KEYPAIR: kp.path };
    assert.throws(() => loadEnv({ ...MAINNET, ...on, SOLANA_CLUSTER: "devnet" }), /SOLANA_CLUSTER must be mainnet-beta/);
    assert.throws(() => loadEnv({ ...BASE, CHAIN_ID: "42431", ...on, SOLANA_CLUSTER: "mainnet-beta" }), /SOLANA_CLUSTER must be devnet/);
    assert.equal(loadEnv({ ...MAINNET, ...on }).SOLANA_CLUSTER, "mainnet-beta");
    // off, the cluster is not checked (nothing is paid)
    assert.equal(loadEnv({ ...MAINNET, SOLANA_CLUSTER: "devnet" }).SOLANA_PAY_ENABLED, false);
  });

  it("the mint must be a Solana address; mint and RPC overrides are kept", () => {
    assert.throws(() => loadEnv({ ...BASE, SOLANA_PAY_MINT: "0x20c0000000000000000000000000000000000000" }), /SOLANA_PAY_MINT/);
    const e = loadEnv({ ...BASE, SOLANA_PAY_MINT: MAINNET_USDC, SOLANA_RPC_URL: "https://rpc.example.com" });
    assert.equal(e.SOLANA_PAY_MINT, MAINNET_USDC);
    assert.equal(e.SOLANA_RPC_URL, "https://rpc.example.com");
  });

  it("Tempo mainnet accepts only Circle USDC unless SOLANA_PAY_ALLOW_CUSTOM_MINT=true", () => {
    const on = { SOLANA_PAY_ENABLED: "true", SOLANA_PAY_KEYPAIR: kp.path };
    assert.throws(() => loadEnv({ ...MAINNET, ...on, SOLANA_PAY_MINT: DEVNET_USDC }), /SOLANA_PAY_MINT must be Circle USDC.*SOLANA_PAY_ALLOW_CUSTOM_MINT/);
    assert.equal(loadEnv({ ...MAINNET, ...on, SOLANA_PAY_MINT: DEVNET_USDC, SOLANA_PAY_ALLOW_CUSTOM_MINT: "true" }).SOLANA_PAY_MINT, DEVNET_USDC);
    assert.equal(loadEnv({ ...MAINNET, ...on, SOLANA_PAY_MINT: MAINNET_USDC }).SOLANA_PAY_MINT, MAINNET_USDC);
    // off mainnet a custom (test) mint needs no flag
    assert.equal(loadEnv({ ...BASE, CHAIN_ID: "42431", ...on, SOLANA_PAY_MINT: MAINNET_USDC }).SOLANA_PAY_MINT, MAINNET_USDC);
  });

  it("the keypair address is its public half", async () => {
    const { keypairAddress, readSolanaKeypair } = await import("../src/solana-pay/keypair.js");
    assert.equal(keypairAddress(readSolanaKeypair(kp.path)), kp.address);
  });
});
