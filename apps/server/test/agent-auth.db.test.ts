import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// SIWE sign-in against a real Postgres (decisions.md D7, D8): the web routes (/api/auth/*), the agent's direct login
// (/oauth/agent/*) signed by a secp256k1 key, the browser consent flow (/oauth/authorize/* + PKCE token exchange) and
// refresh rotation. Only the auth/OAuth routers are mounted (the /mcp behaviour of agent tokens is tested by the MCP area).
// Needs TEST_DATABASE_URL (a DISPOSABLE migrated database: container solvers-tempo-pg on 5546). Every row this file
// creates belongs to fresh random wallets or to OAuth clients named "agtest-*", and is deleted at the end.

const url = process.env.TEST_DATABASE_URL;
const MEMORY_MESSAGE = "Solvers memory key v1";

describe("SIWE and OAuth with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let d: typeof import("drizzle-orm");
  let createNonce: typeof import("../src/auth/siwe.js").createNonce;
  let verifySiwe: typeof import("../src/auth/siwe.js").verifySiwe;
  let server: Server;
  let base = "";
  const wallets: string[] = [];
  const clients: string[] = [];

  const newAccount = () => {
    const a = privateKeyToAccount(generatePrivateKey());
    wallets.push(a.address.toLowerCase());
    return a;
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const getJson = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

  /** The agent's two calls: nonce + token. */
  async function agentLogin(a: PrivateKeyAccount, over: { memory?: boolean | string; message?: string; signer?: PrivateKeyAccount } = {}) {
    const n = await getJson<{ message: string }>(`/oauth/agent/nonce?address=${a.address}`);
    const message = over.message ?? n.message;
    const memorySignature = typeof over.memory === "string" ? over.memory : over.memory ? await a.signMessage({ message: MEMORY_MESSAGE }) : undefined;
    return post("/oauth/agent/token", { address: a.address, message, signature: await (over.signer ?? a).signMessage({ message }), memorySignature });
  }

  async function cleanup() {
    const { inArray } = d;
    if (wallets.length) {
      await db.delete(schema.memoryKeys).where(inArray(schema.memoryKeys.wallet, wallets));
      await db.delete(schema.oauthTokens).where(inArray(schema.oauthTokens.wallet, wallets));
      await db.delete(schema.oauthCodes).where(inArray(schema.oauthCodes.wallet, wallets));
      await db.delete(schema.authNonces).where(inArray(schema.authNonces.wallet, wallets));
      await db.delete(schema.userProfiles).where(inArray(schema.userProfiles.wallet, wallets));
    }
    if (clients.length) await db.delete(schema.oauthClients).where(inArray(schema.oauthClients.clientId, clients));
  }

  before(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "42431",
      PUBLIC_WEB_URL: "http://localhost:3001",
      PUBLIC_API_URL: "http://127.0.0.1:3018",
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
    });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    d = await import("drizzle-orm");
    ({ createNonce, verifySiwe } = await import("../src/auth/siwe.js"));
    const express = (await import("express")).default;
    const cookieParser = (await import("cookie-parser")).default;
    const { optionalAuth } = await import("../src/auth/jwt.js");
    const { authRouter } = await import("../src/auth/routes.js");
    const { mountOAuth } = await import("../src/oauth/routes.js");
    const { errorHandler } = await import("../src/lib/http.js");
    const app = express();
    app.use("/api", express.json(), cookieParser(), optionalAuth);
    app.use("/api/auth", authRouter);
    mountOAuth(app);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    server?.close();
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  // ----- web sign-in (/api/auth) -----

  it("web: nonce → SIWE message built by the client (api-client fields) → session cookie and /me", async () => {
    const a = newAccount();
    const n = await getJson<{ nonce: string; chainId: number; statement: string; expiresAt: string; message: string }>(`/api/auth/nonce?address=${a.address}`);
    assert.equal(n.chainId, 42431);
    assert.match(n.nonce, /^[a-zA-Z0-9]{8,}$/);
    const { createSiweMessage } = await import("viem/siwe");
    const message = createSiweMessage({
      address: a.address,
      chainId: n.chainId,
      domain: "localhost:3001",
      uri: "http://localhost:3001",
      nonce: n.nonce,
      statement: n.statement,
      version: "1",
      issuedAt: new Date(),
      expirationTime: new Date(n.expiresAt),
    });
    const res = await post("/api/auth/verify", { message, signature: await a.signMessage({ message }), returnToken: true });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { wallet: string; token: string };
    assert.equal(out.wallet, a.address.toLowerCase());
    assert.match(res.headers.get("set-cookie") ?? "", /solvers_session=/);
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${out.token}` } });
    assert.deepEqual(await me.json(), { wallet: a.address.toLowerCase() });
  });

  it("web: the server-built message works too; the nonce is single use", async () => {
    const a = newAccount();
    const n = await getJson<{ message: string }>(`/api/auth/nonce?address=${a.address.toLowerCase()}`);
    const body = { message: n.message, signature: await a.signMessage({ message: n.message }) };
    assert.equal((await post("/api/auth/verify", body)).status, 200);
    const again = await post("/api/auth/verify", body);
    assert.equal(again.status, 401);
    assert.match(((await again.json()) as { error: string }).error, /nonce/);
  });

  it("web: refuses another domain, another chain id, an expired message, a bad signature and a nonce of another address", async () => {
    const a = newAccount();
    const { createSiweMessage } = await import("viem/siwe");
    const fresh = async (over: Record<string, unknown> = {}, who: PrivateKeyAccount = a) => {
      const n = await getJson<{ nonce: string; expiresAt: string }>(`/api/auth/nonce?address=${who.address}`);
      return createSiweMessage({
        address: a.address,
        chainId: 42431,
        domain: "localhost:3001",
        uri: "http://localhost:3001",
        nonce: n.nonce,
        version: "1",
        issuedAt: new Date(),
        expirationTime: new Date(n.expiresAt),
        ...over,
      } as Parameters<typeof createSiweMessage>[0]);
    };
    const tryLogin = async (message: string, signer: PrivateKeyAccount = a) => {
      const r = await post("/api/auth/verify", { message, signature: await signer.signMessage({ message }) });
      return { status: r.status, error: ((await r.json()) as { error?: string }).error ?? "" };
    };
    assert.match((await tryLogin(await fresh({ domain: "evil.test" }))).error, /domain/);
    assert.match((await tryLogin(await fresh({ chainId: 4217 }))).error, /network/);
    assert.match((await tryLogin(await fresh({ expirationTime: new Date(Date.now() - 1000) }))).error, /expired/);
    const other = newAccount();
    assert.match((await tryLogin(await fresh(), other)).error, /signature/);
    // A nonce issued for another address cannot be used by `a`.
    assert.match((await tryLogin(await fresh({}, other))).error, /nonce/);
    // A bad signature did not burn the nonce: the right signature still works with the same message.
    const m = await fresh();
    assert.equal((await tryLogin(m, other)).status, 401);
    assert.equal((await tryLogin(m)).status, 200);
  });

  it("web: invalid address in the nonce request is a 400", async () => {
    assert.equal((await fetch(`${base}/api/auth/nonce?address=abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/auth/nonce`)).status, 400);
  });

  it("Privy link answers 404 while Privy is not configured", async () => {
    const a = newAccount();
    const n = await getJson<{ message: string }>(`/api/auth/nonce?address=${a.address}`);
    const login = (await (await post("/api/auth/verify", { message: n.message, signature: await a.signMessage({ message: n.message }), returnToken: true })).json()) as { token: string };
    const res = await post("/api/auth/privy/link", { identityToken: "x" }, { authorization: `Bearer ${login.token}` });
    assert.equal(res.status, 404);
  });

  // ----- agent login (/oauth/agent) -----

  it("agent: two calls give a token of the 'agent' client with the memory key stored", async () => {
    const a = newAccount();
    const res = await agentLogin(a, { memory: true });
    assert.equal(res.status, 200);
    const tok = (await res.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string };
    assert.equal(tok.token_type, "Bearer");
    assert.equal(tok.scope, "solvers");
    const { verifyToken, mcpAudience } = await import("../src/auth/jwt.js");
    const claims = await verifyToken(tok.access_token, mcpAudience());
    assert.equal(claims.sub, a.address.toLowerCase());
    assert.equal(claims.cid, "agent");
    const [row] = await db.select().from(schema.oauthTokens).where(d.eq(schema.oauthTokens.id, claims.jti!));
    assert.equal(row!.wallet, a.address.toLowerCase());
    const mk = await db.select().from(schema.memoryKeys).where(d.eq(schema.memoryKeys.tokenId, row!.id));
    assert.equal(mk.length, 1);
    // The stored key is the D8 key of this wallet.
    const { memoryKeyFromSignature, unwrapKey } = await import("../src/memory/crypto.js");
    const expected = await memoryKeyFromSignature(a.address, await a.signMessage({ message: MEMORY_MESSAGE }));
    assert.ok(unwrapKey(mk[0]!.wrappedKey).equals(expected!));
  });

  it("agent: without memorySignature the token works but no memory key is stored", async () => {
    const a = newAccount();
    assert.equal((await agentLogin(a)).status, 200);
    const [row] = await db.select().from(schema.oauthTokens).where(d.eq(schema.oauthTokens.wallet, a.address.toLowerCase()));
    assert.equal((await db.select().from(schema.memoryKeys).where(d.eq(schema.memoryKeys.tokenId, row!.id))).length, 0);
  });

  it("agent: a memory signature by another key or a contract-style blob is refused (401) and issues no token", async () => {
    const a = newAccount();
    const other = newAccount();
    assert.equal((await agentLogin(a, { memory: await other.signMessage({ message: MEMORY_MESSAGE }) })).status, 401);
    assert.equal((await agentLogin(a, { memory: `0x${"22".repeat(120)}` })).status, 401);
    assert.equal((await db.select().from(schema.oauthTokens).where(d.eq(schema.oauthTokens.wallet, a.address.toLowerCase()))).length, 0);
  });

  it("agent: nonces of another purpose ('login' or 'oauth') are not valid here, and vice versa", async () => {
    for (const purpose of ["login", "oauth"] as const) {
      const a = newAccount();
      const n = await createNonce(a.address, purpose);
      const res = await post("/oauth/agent/token", { message: n.message, signature: await a.signMessage({ message: n.message }) });
      assert.equal(res.status, 401, purpose);
    }
    const a = newAccount();
    const n = await getJson<{ message: string }>(`/oauth/agent/nonce?address=${a.address}`);
    await assert.rejects(verifySiwe({ message: n.message, signature: await a.signMessage({ message: n.message }) }, "login"));
  });

  it("agent: a reused nonce fails; another key's signature fails without burning the nonce", async () => {
    const a = newAccount();
    const n = await getJson<{ message: string }>(`/oauth/agent/nonce?wallet=${a.address}`);
    const other = newAccount();
    assert.equal((await post("/oauth/agent/token", { message: n.message, signature: await other.signMessage({ message: n.message }) })).status, 401);
    const body = { message: n.message, signature: await a.signMessage({ message: n.message }) };
    assert.equal((await post("/oauth/agent/token", body)).status, 200);
    assert.equal((await post("/oauth/agent/token", body)).status, 401);
  });

  it("agent: the message names the API host and says it authorizes no payment; invalid address is a 400", async () => {
    const a = newAccount();
    const n = await getJson<{ message: string; domain: string; chainId: number }>(`/oauth/agent/nonce?address=${a.address}`);
    assert.match(n.message, /does not authorize payments/);
    assert.match(n.message, /^127\.0\.0\.1:3018 wants you to sign in with your Ethereum account:/);
    assert.match(n.message, /Chain ID: 42431/);
    assert.equal((await fetch(`${base}/oauth/agent/nonce?wallet=abc`)).status, 400);
  });

  it("agent: refresh with client_id=agent rotates and revokes the previous token; a wrong client_id does not consume it", async () => {
    const a = newAccount();
    const first = (await (await agentLogin(a, { memory: true })).json()) as { access_token: string; refresh_token: string };
    const refresh = (rt: string, clientId = "agent") =>
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
      });
    const res = await refresh(first.refresh_token);
    assert.equal(res.status, 200);
    const second = (await res.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal((await refresh(first.refresh_token)).status, 400);
    const rows = await db.select().from(schema.oauthTokens).where(d.eq(schema.oauthTokens.wallet, a.address.toLowerCase()));
    assert.deepEqual(rows.map((r) => r.revoked).sort(), [false, true]);
    // The memory key moved to the successor.
    const live = rows.find((r) => !r.revoked)!;
    assert.equal((await db.select().from(schema.memoryKeys).where(d.eq(schema.memoryKeys.tokenId, live.id))).length, 1);
    assert.equal((await refresh(second.refresh_token, "cli_other")).status, 400);
    assert.equal((await refresh(second.refresh_token)).status, 200);
  });

  it("metadata announces the agent endpoints", async () => {
    const meta = await getJson<Record<string, string>>("/.well-known/oauth-authorization-server");
    assert.match(meta.agent_nonce_endpoint!, /\/oauth\/agent\/nonce$/);
    assert.match(meta.agent_token_endpoint!, /\/oauth\/agent\/token$/);
  });

  // ----- browser consent (DCR + PKCE) -----

  it("consent: register → authorize → SIWE nonce for the request → complete → code → PKCE token exchange", async () => {
    const reg = await post("/oauth/register", { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "agtest-client" });
    assert.equal(reg.status, 201);
    const { client_id } = (await reg.json()) as { client_id: string };
    clients.push(client_id);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
    });
    const auth = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
    assert.equal(auth.status, 302);
    const reqId = new URL(auth.headers.get("location")!).searchParams.get("req")!;
    assert.match(reqId, /^ar_/);

    const a = newAccount();
    // The consent page served here passes its own host; the web app uses the default (web host).
    const n = await getJson<{ message: string }>(`/oauth/authorize/nonce?req=${reqId}&address=${a.address}&domain=127.0.0.1:3018&uri=http://127.0.0.1:3018`);
    assert.match(n.message, /^127\.0\.0\.1:3018 wants you/);
    assert.match(n.message, /Authorize agtest-client \(claude\.ai\)/);
    const nWeb = await getJson<{ message: string }>(`/oauth/authorize/nonce?req=${reqId}&wallet=${a.address}`);
    assert.match(nWeb.message, /^localhost:3001 wants you/);
    // Only the latest nonce is bound to the request.
    const stale = await post("/oauth/authorize/complete", { req: reqId, message: n.message, signature: await a.signMessage({ message: n.message }) });
    assert.equal(stale.status, 400);
    const done = await post("/oauth/authorize/complete", {
      req: reqId,
      wallet: a.address,
      message: nWeb.message,
      signature: await a.signMessage({ message: nWeb.message }),
      memorySignature: await a.signMessage({ message: MEMORY_MESSAGE }),
    });
    assert.equal(done.status, 200);
    const redirectTo = new URL(((await done.json()) as { redirectTo: string }).redirectTo);
    assert.equal(redirectTo.searchParams.get("state"), "st");
    const code = redirectTo.searchParams.get("code")!;

    const exchange = (cv: string) =>
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: cv, client_id }),
      });
    assert.equal((await exchange("wrong-verifier-wrong-verifier-wrong-verifier-x")).status, 400); // the code is consumed either way
    assert.equal((await exchange(verifier)).status, 400);
  });

  it("consent: a successful exchange issues a token for the wallet with its memory key", async () => {
    const reg = await post("/oauth/register", { redirect_uris: ["http://localhost:7777/cb"], client_name: "agtest-client-2" });
    const { client_id } = (await reg.json()) as { client_id: string };
    clients.push(client_id);
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:7777/cb",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const reqId = new URL((await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" })).headers.get("location")!).searchParams.get("req")!;
    const a = newAccount();
    const n = await getJson<{ message: string }>(`/oauth/authorize/nonce?req=${reqId}&address=${a.address}`);
    const done = await post("/oauth/authorize/complete", {
      req: reqId,
      message: n.message,
      signature: await a.signMessage({ message: n.message }),
      memorySignature: await a.signMessage({ message: MEMORY_MESSAGE }),
    });
    const code = new URL(((await done.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id }),
    });
    assert.equal(res.status, 200);
    const [row] = await db.select().from(schema.oauthTokens).where(d.eq(schema.oauthTokens.wallet, a.address.toLowerCase()));
    assert.equal(row!.clientId, client_id);
    assert.equal((await db.select().from(schema.memoryKeys).where(d.eq(schema.memoryKeys.tokenId, row!.id))).length, 1);
  });
});
