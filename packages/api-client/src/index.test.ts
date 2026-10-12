import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { recoverMessageAddress } from "viem";
import { ApiError, createApi, purchaseIdFor, type Call, type Hex, type WalletLike } from "./index.js";

// Well-known test key (anvil account #0); never holds real funds.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const HASH = `0x${"cd".repeat(32)}` as Hex;
const AGENT = "3f9a1c2e7b8d4e6fa1b2c3d4e5f60718";

type Seen = { url: string; method: string; body: unknown };

function fakeFetch(routes: Record<string, (body: unknown) => unknown>, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ url, method, body });
    const key = `${method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function wallet(sent: Call[][]): WalletLike {
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    sendCalls: async (calls) => {
      sent.push(calls);
      return HASH;
    },
  };
}

test("login: SIWE message built from the server nonce, signed with EIP-191", async () => {
  const seen: Seen[] = [];
  const api = createApi({
    baseUrl: "https://solvers.example",
    fetch: fakeFetch(
      {
        "GET /api/auth/nonce": () => ({ nonce: "abcdEFGH12345678", chainId: 42431, statement: "Sign in to Solvers.", expiresAt: "2030-01-01T00:00:00.000Z" }),
        "POST /api/auth/verify": () => ({ wallet: account.address }),
      },
      seen,
    ),
  });
  const res = await api.login(wallet([]));
  assert.equal(res.wallet, account.address.toLowerCase());
  assert.equal(new URL(seen[0]!.url).searchParams.get("address"), account.address);
  const { message, signature } = seen[1]!.body as { message: string; signature: Hex };
  const parsed = parseSiweMessage(message);
  assert.equal(parsed.address, account.address);
  assert.equal(parsed.chainId, 42431);
  assert.equal(parsed.domain, "solvers.example");
  assert.equal(parsed.uri, "https://solvers.example");
  assert.equal(parsed.nonce, "abcdEFGH12345678");
  assert.equal(parsed.statement, "Sign in to Solvers.");
  assert.equal(parsed.version, "1");
  assert.equal(parsed.expirationTime?.toISOString(), "2030-01-01T00:00:00.000Z");
  assert.equal(await recoverMessageAddress({ message, signature }), account.address);
});

test("login: issued-at comes from the server nonce, not the local clock", async () => {
  const seen: Seen[] = [];
  const api = createApi({
    baseUrl: "https://solvers.example",
    fetch: fakeFetch(
      {
        "GET /api/auth/nonce": () => ({
          nonce: "abcdEFGH12345678",
          chainId: 42431,
          statement: "Sign in to Solvers.",
          expiresAt: "2030-01-01T00:05:00.000Z",
          issuedAt: "2030-01-01T00:00:00.000Z",
        }),
        "POST /api/auth/verify": () => ({ wallet: account.address }),
      },
      seen,
    ),
  });
  await api.login(wallet([]));
  const { message } = seen[1]!.body as { message: string };
  assert.equal(parseSiweMessage(message).issuedAt?.toISOString(), "2030-01-01T00:00:00.000Z");
});

test("login without a browser origin or baseUrl needs an explicit domain and uri", async () => {
  const api = createApi({ fetch: fakeFetch({}, []) });
  await assert.rejects(api.login(wallet([])), /domain and uri/);
});

test("purchase: intent -> wallet sends the batch -> confirm(txHash)", async () => {
  const seen: Seen[] = [];
  const sent: Call[][] = [];
  const token = "0x20c0000000000000000000000000000000000000";
  const license = "0x0000000000000000000000000000000000000002";
  const api = createApi({
    fetch: fakeFetch(
      {
        "POST /api/purchases/intent": () => ({
          calls: [
            { to: token, data: "0x095ea7b3" },
            { to: license, data: "0x01" },
          ],
          feePayer: true,
          chainId: 42431,
          purchaseId: purchaseIdFor("ch_1"),
          chargeId: "ch_1",
          kind: "license",
          agentId: AGENT,
          amountUnits: "5000000",
        }),
        "POST /api/tx/confirm": (b) => ({ txHash: (b as { txHash: string }).txHash, status: "confirmed" }),
      },
      seen,
    ),
    baseUrl: "http://localhost:3018",
  });
  const intent = await api.buildPurchase(AGENT, 5_000_000n);
  assert.deepEqual(seen[0]!.body, { kind: "license", agentId: AGENT, expectedPriceUnits: "5000000" });
  assert.equal(intent.purchaseId, purchaseIdFor("ch_1"));
  const done = await api.sendAndConfirm(wallet(sent), intent);
  assert.equal(done.status, "confirmed");
  assert.equal(done.txHash, HASH);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    { to: token, data: "0x095ea7b3" },
    { to: license, data: "0x01" },
  ]);
  assert.deepEqual(seen[1], { url: "http://localhost:3018/api/tx/confirm", method: "POST", body: { txHash: HASH } });
});

test("transfer, publication confirm and memory unlock send hex values", async () => {
  const seen: Seen[] = [];
  const tx = { calls: [{ to: "0x0000000000000000000000000000000000000002", data: "0x" }], feePayer: true, chainId: 42431 };
  const api = createApi({
    baseUrl: "http://localhost:3018",
    fetch: fakeFetch(
      {
        "POST /api/tx/transfer": () => tx,
        "POST /api/tx/publication/confirm": () => ({ submissionId: "s1", status: "publishing", outcome: "not_ready", step: "await-admin-approval", error: null }),
        "POST /api/me/memory-key": () => ({ ok: true }),
      },
      seen,
    ),
  });
  await api.buildTransfer("12", "0x0000000000000000000000000000000000000009", 1_000_000n);
  assert.deepEqual(seen[0]!.body, { licenseId: "12", to: "0x0000000000000000000000000000000000000009", maxRoyaltyUnits: "1000000" });
  await api.confirmPublication("s1", HASH, "register-agent");
  assert.deepEqual(seen[1]!.body, { submissionId: "s1", txHash: HASH, kind: "register-agent" });
  await api.unlockMemories(wallet([]));
  const sig = (seen[2]!.body as { signature: string }).signature;
  assert.match(sig, /^0x[0-9a-f]{130}$/);
});

test("dropped features have no client methods", () => {
  const api = createApi({ fetch: fakeFetch({}, []) }) as Record<string, unknown>;
  for (const name of ["buildListLicense", "buildBuyListing", "buildCancelListing", "submit", "signAndSubmit"]) {
    assert.equal(api[name], undefined, name);
  }
  for (const name of Object.keys(api)) assert.doesNotMatch(name, /listing/i);
});

test("errors keep status and code", async () => {
  const api = createApi({ fetch: fakeFetch({}, []), baseUrl: "http://localhost:3018" });
  await assert.rejects(api.getConfig(), (e: unknown) => (e as { status: number; code: string }).status === 404 && (e as { code: string }).code === "not_found");
});

test("creator settings and stale dispute: each method posts its route and body and returns the batch", async () => {
  const seen: Seen[] = [];
  const tx = { calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }], feePayer: true, chainId: 42431 };
  const id = "my solver";
  const p = `/api/tx/creator/${encodeURIComponent(id)}`;
  const paths = ["pricing", "royalty", "supply-cap", "metadata", "stake/top-up", "stake/exit", "stake/cancel-exit", "stake/withdraw", "slash/contest"];
  const routes = Object.fromEntries([...paths.map((x) => `POST ${p}/${x}`), "POST /api/tx/escrow/12/stale-dispute"].map((k) => [k, () => tx]));
  const api = createApi({ baseUrl: "https://solvers.example", fetch: fakeFetch(routes, seen) });

  const results = [
    await api.buildCreatorPricing(id, 2_500_000n),
    await api.buildCreatorRoyalty(id, 450),
    await api.buildCreatorSupplyCap(id, 100),
    await api.buildCreatorMetadata(id),
    await api.buildCreatorMetadata(id, "https://solvers.example/meta.json"),
    await api.buildStakeTopUp(id, "5000000"),
    await api.buildStakeExit(id),
    await api.buildStakeCancelExit(id),
    await api.buildStakeWithdraw(id),
    await api.buildSlashContest(id, "The report is about another Solver."),
    await api.buildResolveStaleDispute("12", 1),
  ];
  for (const r of results) assert.deepEqual(r, tx);
  assert.deepEqual(
    seen.map((s) => [s.method, new URL(s.url).pathname, s.body]),
    [
      ["POST", `${p}/pricing`, { pricePerUseUnits: "2500000" }],
      ["POST", `${p}/royalty`, { royaltyBps: 450 }],
      ["POST", `${p}/supply-cap`, { max: 100 }],
      ["POST", `${p}/metadata`, {}],
      ["POST", `${p}/metadata`, { metadataUri: "https://solvers.example/meta.json" }],
      ["POST", `${p}/stake/top-up`, { amountUnits: "5000000" }],
      ["POST", `${p}/stake/exit`, undefined],
      ["POST", `${p}/stake/cancel-exit`, undefined],
      ["POST", `${p}/stake/withdraw`, undefined],
      ["POST", `${p}/slash/contest`, { reason: "The report is about another Solver." }],
      ["POST", "/api/tx/escrow/12/stale-dispute", { index: 1 }],
    ],
  );
});

test("creator settings: a refusal becomes an ApiError with the server code", async () => {
  const api = createApi({
    fetch: (async () => new Response(JSON.stringify({ error: "The royalty can't change after the first sale.", code: "royalty_locked" }), { status: 409 })) as typeof fetch,
  });
  await assert.rejects(api.buildCreatorRoyalty("a", 100), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "royalty_locked");
});

test("solana pay: create posts the purchase input, get reads the own charge, refusals keep the code", async () => {
  const seen: Seen[] = [];
  const charge = {
    id: "sol_abc",
    status: "pending_payment",
    kind: "license",
    agentId: AGENT,
    purchaseId: purchaseIdFor("sol_abc"),
    amountUnits: "19000000",
    amount: "19",
    tokenSymbol: "USDC",
    cluster: "devnet",
    url: "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=19&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&reference=Ref1111111111111111111111111111111111111111&memo=sol_abc",
    qrCodeBase64: "iVBORw0KGgo=",
    recipient: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    reference: "Ref1111111111111111111111111111111111111111",
    expiresAt: "2026-10-11T12:30:00.000Z",
    solanaSignature: null,
    solanaExplorerUrl: null,
    refundSignature: null,
    txHash: null,
    explorerUrl: null,
    createdAt: "2026-10-11T12:00:00.000Z",
  };
  const api = createApi({
    baseUrl: "https://solvers.example",
    fetch: fakeFetch({ "POST /api/solana-pay/charges": () => charge, "GET /api/solana-pay/charges/sol_abc": () => ({ ...charge, status: "fulfilled", txHash: HASH }) }, seen),
  });
  const input = { kind: "license" as const, agentId: AGENT, expectedPriceUnits: "19000000" };
  assert.equal((await api.createSolanaPayCharge(input)).url, charge.url);
  const got = await api.getSolanaPayCharge("sol_abc");
  assert.equal(got.status, "fulfilled");
  assert.equal(got.txHash, HASH);
  assert.deepEqual(
    seen.map((s) => [s.method, new URL(s.url).pathname, s.body]),
    [
      ["POST", "/api/solana-pay/charges", input],
      ["GET", "/api/solana-pay/charges/sol_abc", undefined],
    ],
  );
  const off = createApi({
    fetch: (async () => new Response(JSON.stringify({ error: "Solana Pay is off.", code: "solana_pay_unavailable" }), { status: 400 })) as typeof fetch,
  });
  await assert.rejects(off.createSolanaPayCharge(input), (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === "solana_pay_unavailable");
});
