import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../env.js";
import { unauthorized } from "../lib/http.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
export const WEB_AUDIENCE = "solvers-web";
export const SESSION_COOKIE = "solvers_session";
const SESSION_TTL = "24h";

export const mcpAudience = () => `${env.PUBLIC_API_URL.replace(/\/$/, "")}/mcp`;

/** Web session JWT (cookie or Bearer). The subject is the wallet address, lowercase (D7). */
export async function signSession(wallet: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet.toLowerCase())
    .setJti(`web_${randomBytes(12).toString("hex")}`)
    .setAudience(WEB_AUDIENCE)
    .setIssuer(env.PUBLIC_API_URL)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret);
}

/** MCP access token (OAuth): audience = the /mcp resource, `jti` = the oauth_tokens row, `cid` = the client. */
export async function signAccessToken(wallet: string, tokenId: string, clientId: string, ttlSecs: number): Promise<string> {
  return new SignJWT({ cid: clientId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet.toLowerCase())
    .setJti(tokenId)
    .setAudience(mcpAudience())
    .setIssuer(env.PUBLIC_API_URL)
    .setIssuedAt()
    .setExpirationTime(`${ttlSecs}s`)
    .sign(secret);
}

export type TokenClaims = { sub: string; jti?: string; cid?: string; exp?: number };

export async function verifyToken(token: string, audience: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, secret, { audience, issuer: env.PUBLIC_API_URL });
  if (!payload.sub) throw new Error("token without sub");
  return { ...(payload as TokenClaims), sub: payload.sub.toLowerCase() };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authenticated wallet, lowercase (web session or connector token). */
      wallet?: string;
      /** Session/token id (jti): binds the memory key to the session. */
      tokenId?: string;
    }
  }
}

function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    try {
      const claims = await verifyToken(token, WEB_AUDIENCE);
      req.wallet = claims.sub;
      req.tokenId = claims.jti;
    } catch {
      /* invalid session: continue anonymously */
    }
  }
  next();
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(unauthorized());
  try {
    const claims = await verifyToken(token, WEB_AUDIENCE);
    req.wallet = claims.sub;
    req.tokenId = claims.jti;
    next();
  } catch {
    next(unauthorized("Session expired, please sign in again"));
  }
}

export function requireWallet(req: Request): string {
  if (!req.wallet) throw unauthorized();
  return req.wallet;
}
