import express, { Router, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { and, eq, gt } from "drizzle-orm";

import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { SESSION_COOKIE, WEB_AUDIENCE, mcpAudience, verifyToken } from "../auth/jwt.js";
import { quotaIpKey } from "./rules.js";
import { createRelayService, type RelayService } from "./service.js";

// POST /api/relay (decisions.md D3): the JSON-RPC endpoint of the platform relay, used by the wallet's viem transport
// (`withRelay(http(rpc), http("/api/relay"))` + `feePayer: true`), not by the api-client. Requires a session: the web
// session (cookie or Bearer) or an MCP/agent OAuth access token (Bearer). Mount with `app.use("/api", relayRouter)`.
// RELAY_ENABLED=false answers 503 (rollback = turn the flag off).

const MAX_BATCH = 10;

let service: RelayService | null = null;

/** Lazily built on the first request (the chain context is initialized at boot, after the routers are imported). */
function relayService(): RelayService {
  service ??= createRelayService();
  return service;
}

/** Test hook: replace or reset the relay service. */
export function setRelayServiceForTests(s: RelayService | null): void {
  service = s;
}

function bearerOrCookie(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

/** The signed-in wallet (lowercase): web session, or an unrevoked MCP/agent access token. Null when not signed in. */
export async function relaySessionWallet(req: Request): Promise<string | null> {
  const token = bearerOrCookie(req);
  if (!token) return null;
  const web = await verifyToken(token, WEB_AUDIENCE).catch(() => null);
  if (web) return web.sub;
  const mcp = await verifyToken(token, mcpAudience()).catch(() => null);
  if (!mcp?.jti) return null;
  const [row] = await db
    .select({ wallet: schema.oauthTokens.wallet })
    .from(schema.oauthTokens)
    .where(and(eq(schema.oauthTokens.id, mcp.jti), eq(schema.oauthTokens.revoked, false), gt(schema.oauthTokens.expiresAt, new Date())));
  return row && row.wallet.toLowerCase() === mcp.sub ? mcp.sub : null;
}

const rpcError = (res: Response, status: number, code: number, message: string, id: unknown = null) =>
  res.status(status).json({ jsonrpc: "2.0", id, error: { code, message } });

/** JSON with bigints as 0x-hex quantities (JSON-RPC encoding). */
function sendJson(res: Response, value: unknown) {
  res.type("application/json").send(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
}

export const relayRouter = Router();

relayRouter.post("/relay", express.json({ limit: "128kb" }), cookieParser(), async (req, res, next) => {
  try {
    if (!env.RELAY_ENABLED) return rpcError(res, 503, -32000, "The relay is disabled");
    const wallet = req.wallet ?? (await relaySessionWallet(req));
    if (!wallet) return rpcError(res, 401, -32001, "Sign in to use the relay");
    const body: unknown = req.body;
    // Quotas count per IPv4 address or IPv6 /64 (quotaIpKey).
    const ip = quotaIpKey(req.ip);
    const ctxFor = (r: unknown) => ({
      sender: wallet.toLowerCase() as `0x${string}`,
      ...(ip ? { ip } : {}),
      method: typeof (r as { method?: unknown })?.method === "string" ? (r as { method: string }).method : undefined,
    });
    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > MAX_BATCH) return rpcError(res, 400, -32600, "Invalid batch");
      // No nested batches: each item must be one request object.
      if (body.some((r) => !r || typeof r !== "object" || Array.isArray(r))) return rpcError(res, 400, -32600, "Invalid batch");
      // One context per call: the quota reservation of a fill travels in its own context.
      const out = await Promise.all(body.map((r) => relayService().handle(r, ctxFor(r))));
      return sendJson(res, out);
    }
    if (!body || typeof body !== "object") return rpcError(res, 400, -32600, "Invalid request");
    return sendJson(res, await relayService().handle(body, ctxFor(body)));
  } catch (e) {
    next(e);
  }
});
