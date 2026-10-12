import express, { Router, type Express } from "express";
import cors from "cors";
import { and, eq, gt, like, lt } from "drizzle-orm";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { h, HttpError, parse } from "../lib/http.js";
import { randomId, randomToken, sha256Hex } from "../lib/crypto.js";
import { mcpAudience, signAccessToken, verifyToken } from "../auth/jwt.js";
import { allowedDomains, createNonce, parseWalletAddress, siweNonceOf, verifySiwe } from "../auth/siwe.js";
import { MEMORY_KEY_MESSAGE, memoryKeyFromSignature, storeMemoryKey, wrapKey, type DbExecutor } from "../memory/crypto.js";
import { authorizePage, pageLang } from "./page.js";
import { AGENT_CLIENT_ID, AGENT_SIWE_STATEMENT, consentStatement, refreshRejection } from "./rules.js";

// Authorization of the MCP connector: /mcp is a resource server and this app is also the authorization server
// (OAuth 2.1 + PKCE S256 + dynamic client registration). The wallet proves itself with SIWE (EIP-4361, decisions.md D7);
// the optional memory signature is an EIP-191 signature of MEMORY_KEY_MESSAGE by an EOA (D8).

const ACCESS_TTL_SECS = 24 * 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const AUTH_REQ_TTL_MS = 10 * 60 * 1000;

const base = () => env.PUBLIC_API_URL.replace(/\/$/, "");

class OAuthError extends HttpError {
  constructor(error: string, description: string, status = 400) {
    super(status, description, error, { error, error_description: description });
  }
}

export function protectedResourceMetadata() {
  return {
    resource: mcpAudience(),
    authorization_servers: [base()],
    scopes_supported: ["solvers"],
    bearer_methods_supported: ["header"],
    resource_name: "Solvers",
    resource_documentation: `${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/install`,
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    revocation_endpoint: `${base()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Non-standard extension: direct login of agents that hold a key (two calls, no browser), SIWE signed by that key.
    agent_nonce_endpoint: `${base()}/oauth/agent/nonce`,
    agent_token_endpoint: `${base()}/oauth/agent/token`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["solvers"],
  };
}

const RegisterBody = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().max(200).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
});

function allowedRedirect(uri: string): boolean {
  const u = new URL(uri);
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

async function getClient(clientId: string) {
  const [c] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId));
  return c ? { ...c, meta: c.metadata as { redirect_uris: string[]; client_name?: string } } : null;
}

const AuthorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(1000).optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

type AuthRequest = z.infer<typeof AuthorizeQuery> & { clientName: string; nonce?: string };

async function saveAuthRequest(req: AuthRequest): Promise<string> {
  const id = `ar_${randomId(12)}`;
  // Clears only expired authorization requests (kv holds other things too, such as the indexer cursor).
  await db.delete(schema.kv).where(and(like(schema.kv.key, "oauth:req:%"), lt(schema.kv.updatedAt, new Date(Date.now() - AUTH_REQ_TTL_MS))));
  await db.insert(schema.kv).values({ key: `oauth:req:${id}`, value: req });
  return id;
}

/** Known clients: the page shows the destination as verified; the others get a warning. */
const KNOWN_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com", "openai.com", "localhost", "127.0.0.1"];

function redirectInfo(uri: string) {
  const host = new URL(uri).hostname;
  const verified = KNOWN_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return { host, verified };
}

async function loadAuthRequest(id: string): Promise<AuthRequest> {
  const [row] = await db
    .select()
    .from(schema.kv)
    .where(and(eq(schema.kv.key, `oauth:req:${id}`), gt(schema.kv.updatedAt, new Date(Date.now() - AUTH_REQ_TTL_MS))));
  if (!row) throw new OAuthError("invalid_request", "The authorization request has expired. Go back to Claude/ChatGPT and connect again.");
  return row.value as AuthRequest;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `exec` lets tokens be issued inside a transaction (refresh rotation: all or nothing). */
async function issueTokens(clientId: string, wallet: string, wrappedMemoryKey: Buffer | null, exec: DbExecutor = db) {
  const tokenId = `tok_${randomId(12)}`;
  const refresh = randomToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const owner = wallet.toLowerCase();
  await exec.insert(schema.oauthTokens).values({ id: tokenId, clientId, wallet: owner, refreshHash: sha256Hex(refresh), expiresAt });
  // The memory key lives as long as the authorization; revoking or expiring it deletes the key.
  if (wrappedMemoryKey) await storeMemoryKey(tokenId, owner, wrappedMemoryKey, expiresAt, exec);
  const access = await signAccessToken(owner, tokenId, clientId, ACCESS_TTL_SECS);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECS,
    refresh_token: refresh,
    scope: "solvers",
  };
}

/** Memory key wrapped with the KEK, from an optional EIP-191 signature of MEMORY_KEY_MESSAGE (EOAs only, D8). */
async function wrappedMemoryKey(wallet: string, memorySignature: string | undefined): Promise<Buffer | null> {
  if (!memorySignature) return null;
  const key = await memoryKeyFromSignature(wallet, memorySignature);
  if (!key) {
    throw new OAuthError(
      "access_denied",
      "Invalid memory key signature (it must be a plain wallet signature; smart-contract wallets cannot unlock memories)",
      401,
    );
  }
  return wrapKey(key);
}

export const oauthRouter = Router();
const open = cors({ origin: true });

/** Agent nonce: 10 per minute PER WALLET (the nonce table is written without authentication). */
const agentNonceLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const w = req.query.address ?? req.query.wallet;
    return typeof w === "string" ? w.slice(0, 64).toLowerCase() : "anon";
  },
  validate: { keyGeneratorIpFallback: false },
  message: { error: "too_many_requests", error_description: "Too many attempts for this wallet. Please wait a minute." },
});

oauthRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
    message: { error: "too_many_requests", error_description: "Too many attempts. Please wait a minute." },
  }),
);

oauthRouter.post(
  "/register",
  open,
  express.json(),
  h(async (req, res) => {
    const body = RegisterBody.safeParse(req.body);
    if (!body.success) throw new OAuthError("invalid_client_metadata", body.error.issues[0]?.message ?? "invalid metadata");
    for (const uri of body.data.redirect_uris) {
      if (!allowedRedirect(uri)) throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: ${uri}`);
    }
    const clientId = `cli_${randomId(12)}`;
    const metadata = {
      redirect_uris: body.data.redirect_uris,
      client_name: body.data.client_name ?? "MCP client",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "solvers",
    };
    await db.insert(schema.oauthClients).values({ clientId, metadata });
    res.status(201);
    return { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...metadata };
  }),
);

oauthRouter.get(
  "/authorize",
  h(async (req, res) => {
    const q = AuthorizeQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).type("html").send(authorizePage({ lang: pageLang(req.query.lang, req.headers["accept-language"]), error: "Invalid authorization request. Try connecting again from Claude or ChatGPT." }));
      return;
    }
    const client = await getClient(q.data.client_id);
    if (!client || !client.meta.redirect_uris.includes(q.data.redirect_uri)) {
      res.status(400).type("html").send(authorizePage({ lang: pageLang(req.query.lang, req.headers["accept-language"]), error: "App not recognized. Try connecting again." }));
      return;
    }
    if (q.data.resource && q.data.resource.replace(/\/$/, "") !== mcpAudience()) {
      res.status(400).type("html").send(authorizePage({ lang: pageLang(req.query.lang, req.headers["accept-language"]), error: "The requested resource does not belong to this server." }));
      return;
    }
    const clientName = client.meta.client_name ?? "Your AI assistant";
    const id = await saveAuthRequest({ ...q.data, clientName });
    // Authorization happens on the web app (/connect), where e-mail login (Privy) and the embedded wallet work.
    res.redirect(302, `${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/connect?req=${encodeURIComponent(id)}`);
  }),
);

/** Request data for the web app's consent screen. */
oauthRouter.get(
  "/authorize/info",
  h(async (req) => {
    const { req: id } = parse(z.object({ req: z.string() }), req.query);
    const ar = await loadAuthRequest(id);
    const lang = pageLang(req.query.lang, req.headers["accept-language"]);
    const { host, verified } = redirectInfo(ar.redirect_uri);
    return {
      clientName: ar.clientName,
      redirectHost: host,
      verified,
      memoryMessage: MEMORY_KEY_MESSAGE,
      extensionUrl: `${base()}/oauth/authorize/extension?req=${encodeURIComponent(id)}&lang=${lang}`,
    };
  }),
);

/** Alternative for browser-extension wallets (EIP-6963 discovery): the consent page served by this server. */
oauthRouter.get(
  "/authorize/extension",
  h(async (req, res) => {
    const id = typeof req.query.req === "string" ? req.query.req : "";
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    const lang = pageLang(req.query.lang, req.headers["accept-language"]);
    const ar = await loadAuthRequest(id).catch(() => null);
    if (!ar) {
      res.status(400).type("html").send(authorizePage({ lang, error: "The authorization request has expired. Go back to Claude/ChatGPT and connect again." }));
      return;
    }
    const { host, verified } = redirectInfo(ar.redirect_uri);
    res.type("html").send(
      authorizePage({ lang, requestId: id, clientName: ar.clientName, redirectHost: host, verified, apiBase: base(), webUrl: env.PUBLIC_WEB_URL, memoryMessage: MEMORY_KEY_MESSAGE }),
    );
  }),
);

oauthRouter.get(
  "/authorize/nonce",
  h(async (req) => {
    const q = parse(
      z.object({
        req: z.string(),
        wallet: z.string().max(64).optional(),
        address: z.string().max(64).optional(),
        /** Host and origin of the signing page (the consent page served here passes them; the web app uses the defaults). */
        domain: z.string().max(255).optional(),
        uri: z.string().max(2000).optional(),
      }),
      req.query,
    );
    const wallet = parseWalletAddress(q.address ?? q.wallet);
    const ar = await loadAuthRequest(q.req);
    const { host } = redirectInfo(ar.redirect_uri);
    // The signed message says who gets access; the nonce is bound to this request.
    const n = await createNonce(wallet, "oauth", consentStatement(ar.clientName, host), { domain: q.domain, uri: q.uri });
    await db.update(schema.kv).set({ value: { ...ar, nonce: n.nonce } }).where(eq(schema.kv.key, `oauth:req:${q.req}`));
    return n;
  }),
);

oauthRouter.post(
  "/authorize/complete",
  express.json(),
  h(async (req) => {
    const body = parse(
      z.object({
        req: z.string(),
        /** Optional: when present it must be the message's address. */
        wallet: z.string().max(64).optional(),
        message: z.string().max(2000),
        signature: z.string().max(4096),
        memorySignature: z.string().max(4096).optional(),
      }),
      req.body,
    );
    const ar = await loadAuthRequest(body.req);
    if (!ar.nonce || siweNonceOf(body.message) !== ar.nonce) {
      throw new OAuthError("invalid_request", "This signature does not belong to this authorization request");
    }
    const wallet = await verifySiwe({ message: body.message, signature: body.signature, address: body.wallet }, "oauth");
    const wrapped = await wrappedMemoryKey(wallet, body.memorySignature);

    const code = randomToken(24);
    await db.delete(schema.oauthCodes).where(lt(schema.oauthCodes.expiresAt, new Date()));
    await db.insert(schema.oauthCodes).values({
      code,
      clientId: ar.client_id,
      wallet,
      codeChallenge: ar.code_challenge,
      redirectUri: ar.redirect_uri,
      scope: ar.scope ?? "solvers",
      resource: ar.resource ?? mcpAudience(),
      memoryKey: wrapped,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    await db.delete(schema.kv).where(eq(schema.kv.key, `oauth:req:${body.req}`));
    const url = new URL(ar.redirect_uri);
    url.searchParams.set("code", code);
    if (ar.state) url.searchParams.set("state", ar.state);
    return { redirectTo: url.toString() };
  }),
);

// Direct agent login: two calls, no browser and no client registration. The agent signs the SIWE message returned by
// /oauth/agent/nonce with its secp256k1 key (viem: `privateKeyToAccount(pk).signMessage({ message })`) and, optionally,
// MEMORY_KEY_MESSAGE to unlock its memories. Nonce purpose "agent": not valid in the browser flow ("oauth") nor in the
// web login ("login"), and vice versa.
oauthRouter.get(
  "/agent/nonce",
  open,
  agentNonceLimit,
  h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const q = parse(z.object({ wallet: z.string().max(64).optional(), address: z.string().max(64).optional() }), req.query);
    // The agent talks to the API, so the message names the API host (when it is an allowed SIWE domain).
    const apiHost = new URL(base()).host.toLowerCase();
    const origin = allowedDomains().includes(apiHost) ? { domain: apiHost, uri: base() } : {};
    return createNonce(parseWalletAddress(q.address ?? q.wallet), "agent", AGENT_SIWE_STATEMENT, origin);
  }),
);

oauthRouter.post(
  "/agent/token",
  open,
  express.json(),
  h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = parse(
      z.object({
        wallet: z.string().max(64).optional(),
        address: z.string().max(64).optional(),
        message: z.string().max(2000),
        signature: z.string().max(4096),
        memorySignature: z.string().max(4096).optional(),
      }),
      req.body,
    );
    const wallet = await verifySiwe({ message: body.message, signature: body.signature, address: body.address ?? body.wallet }, "agent");
    return issueTokens(AGENT_CLIENT_ID, wallet, await wrappedMemoryKey(wallet, body.memorySignature));
  }),
);

oauthRouter.post(
  "/token",
  open,
  express.urlencoded({ extended: false }),
  express.json(),
  h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const b = req.body as Record<string, string>;
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier || !b.client_id) throw new OAuthError("invalid_request", "code, code_verifier and client_id are required");
      const [row] = await db.delete(schema.oauthCodes).where(eq(schema.oauthCodes.code, b.code)).returning();
      if (!row || row.expiresAt < new Date()) throw new OAuthError("invalid_grant", "Invalid or expired code");
      if (row.clientId !== b.client_id) throw new OAuthError("invalid_grant", "Code belongs to another client");
      if (b.redirect_uri && b.redirect_uri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
      if (s256(b.code_verifier) !== row.codeChallenge) throw new OAuthError("invalid_grant", "Invalid PKCE");
      if (b.resource && b.resource.replace(/\/$/, "") !== mcpAudience()) throw new OAuthError("invalid_target", "Invalid resource");
      return issueTokens(row.clientId, row.wallet, row.memoryKey ?? null);
    }
    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
      const refreshHash = sha256Hex(b.refresh_token);
      // All-or-nothing rotation: revoke the old refresh token, move the memory key and issue the successor in one
      // transaction. A failure midway rolls everything back and the client keeps a valid old refresh token. The row is
      // locked (for update): a second request with the same refresh token waits and then sees it revoked.
      return db.transaction(async (tx) => {
        const [tok] = await tx.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.refreshHash, refreshHash)).for("update");
        // Validate before revoking: an invalid request never consumes the legitimate client's token.
        const rejection = refreshRejection(tok, b.client_id, new Date());
        if (rejection || !tok) throw new OAuthError("invalid_grant", rejection ?? "Invalid or expired refresh token");
        await tx.update(schema.oauthTokens).set({ revoked: true }).where(eq(schema.oauthTokens.id, tok.id));
        const [mk] = await tx.delete(schema.memoryKeys).where(eq(schema.memoryKeys.tokenId, tok.id)).returning();
        return issueTokens(tok.clientId, tok.wallet, mk?.wrappedKey ?? null, tx);
      });
    }
    throw new OAuthError("unsupported_grant_type", "Unsupported grant_type");
  }),
);

oauthRouter.post(
  "/revoke",
  open,
  express.urlencoded({ extended: false }),
  express.json(),
  h(async (req) => {
    const token = (req.body as Record<string, string>).token;
    if (token) {
      let tokenId: string | undefined;
      const [byRefresh] = await db
        .update(schema.oauthTokens)
        .set({ revoked: true })
        .where(eq(schema.oauthTokens.refreshHash, sha256Hex(token)))
        .returning();
      tokenId = byRefresh?.id;
      if (!tokenId) {
        // It may be the access token (JWT): revoke by jti.
        const claims = await verifyToken(token, mcpAudience()).catch(() => null);
        if (claims?.jti) {
          await db.update(schema.oauthTokens).set({ revoked: true }).where(eq(schema.oauthTokens.id, claims.jti));
          tokenId = claims.jti;
        }
      }
      if (tokenId) await db.delete(schema.memoryKeys).where(eq(schema.memoryKeys.tokenId, tokenId));
    }
    return {};
  }),
);

export function mountOAuth(app: Express) {
  const wellKnown = Router();
  wellKnown.use(open);
  wellKnown.get(["/oauth-protected-resource", "/oauth-protected-resource/mcp"], (_req, res) => {
    res.json(protectedResourceMetadata());
  });
  wellKnown.get(["/oauth-authorization-server", "/oauth-authorization-server/mcp", "/openid-configuration"], (_req, res) => {
    res.json(authorizationServerMetadata());
  });
  app.use("/.well-known", wellKnown);
  app.use("/oauth", oauthRouter);
}

export { issueTokens as _issueTokensForTests };
