import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi } from "viem";
import { transferWithRoyaltyCalls } from "@solvers/chain";
import { solversLicenseAbi } from "@solvers/contracts-client";
import { TxResponse } from "@solvers/shared";

// Store routes without a chain nor a database: `createApp([])` + a signed session (no Privy). Covers authentication,
// input validation that runs before any read, the chain-less /api/config, and the TxResponse shape of the builders.

const WALLET = "0x1111111111111111111111111111111111111111";

describe("store routes (no chain)", () => {
  let base = "";
  let close: () => Promise<void> = async () => undefined;
  let token = "";

  before(async () => {
    const { createApp } = await import("../src/app.js");
    const { escrowRouter } = await import("../src/store/escrow.js");
    const { creatorTxRouter } = await import("../src/store/creator-tx.js");
    const jwt = await import("../src/auth/jwt.js");
    token = await jwt.signSession(WALLET);
    const app = createApp([
      (a) => {
        a.use("/api", escrowRouter);
        a.use("/api", creatorTxRouter);
      },
    ]);
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

  it("transaction builders require a session", async () => {
    for (const [m, p] of [
      ["POST", "/api/tx/transfer"],
      ["POST", "/api/tx/claim"],
      ["POST", "/api/tx/confirm"],
      ["POST", "/api/tx/review"],
      ["POST", "/api/tx/escrow/1/release"],
      ["POST", "/api/tx/creator/x/supply-cap"],
      ["GET", "/api/me/balance"],
      ["GET", "/api/me/payouts"],
      ["GET", "/api/me/licenses/1/transfer-quote"],
    ] as const) {
      assert.equal((await call(m, p, m === "GET" ? undefined : {}, false)).status, 401, `${m} ${p}`);
    }
  });

  it("validation runs before any chain or database read", async () => {
    assert.equal((await call("POST", "/api/tx/confirm", { txHash: "0x1234" })).body.code, "validation");
    assert.equal((await call("POST", "/api/tx/transfer", { licenseId: "1", to: "not-an-address", maxRoyaltyUnits: "1" })).body.code, "validation");
    assert.equal((await call("POST", "/api/tx/transfer", { licenseId: "1", to: WALLET, maxRoyaltyUnits: "1" })).body.code, "same_wallet");
    assert.equal((await call("POST", "/api/tx/escrow/abc/release", { index: 0 })).body.code, "validation");
    assert.equal((await call("POST", "/api/tx/escrow/1/release", { index: 9 })).body.code, "validation");
    assert.equal((await call("GET", "/api/license/not-a-number")).body.code, "validation");
  });

  it("GET /api/config answers 503 chain_unavailable when the chain is not configured", async () => {
    const r = await call("GET", "/api/config");
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "chain_unavailable");
  });

  it("TxResponse of a transfer: [approve(license, maxRoyalty), transferWithRoyalty], fee sponsored, lowercase targets", async () => {
    const { txResponse } = await import("../src/store/tx-build.js");
    const d = {
      token: "0x20C0000000000000000000000000000000000000",
      registry: "0x00000000000000000000000000000000000000a1",
      license: "0x00000000000000000000000000000000000000A2",
      credits: "0x00000000000000000000000000000000000000a3",
      reviews: "0x00000000000000000000000000000000000000a4",
      escrow: "0x00000000000000000000000000000000000000a5",
      staking: "0x00000000000000000000000000000000000000a6",
    } as const;
    const r = TxResponse.parse(txResponse(transferWithRoyaltyCalls(d, { to: WALLET, tokenId: 7n, maxRoyalty: 1_000_000n })));
    assert.equal(r.feePayer, true);
    assert.equal(r.chainId, 31337);
    assert.equal(r.calls[0]!.to, d.token.toLowerCase());
    assert.equal(r.calls[1]!.to, d.license.toLowerCase());
    const [spender, amount] = decodeFunctionData({ abi: erc20Abi, data: r.calls[0]!.data }).args as [string, bigint];
    assert.equal(spender.toLowerCase(), d.license.toLowerCase());
    assert.equal(amount, 1_000_000n);
    const t = decodeFunctionData({ abi: solversLicenseAbi, data: r.calls[1]!.data });
    assert.equal(t.functionName, "transferWithRoyalty");
    assert.deepEqual(t.args, [WALLET, 7n, 1_000_000n]);
    assert.equal(r.purchaseId, undefined);
  });
});

describe("currentEvalBps (D6)", () => {
  it("no measured version on record = not measured (0); a measurement of another version = 0", async () => {
    const { currentEvalBps } = await import("../src/store/mappers.js");
    const v = "ab".repeat(32);
    assert.equal(currentEvalBps({ evalScoreBps: 8000, evalVersionHash: null, versionHash: v }), 0);
    assert.equal(currentEvalBps({ evalScoreBps: 8000, evalVersionHash: v, versionHash: `0x${v}` }), 8000);
    assert.equal(currentEvalBps({ evalScoreBps: 8000, evalVersionHash: "cd".repeat(32), versionHash: v }), 0);
  });
});
