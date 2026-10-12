import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { h, parse } from "../lib/http.js";
import { SESSION_COOKIE, signSession, requireAuth, requireWallet } from "./jwt.js";
import { createNonce, verifySiwe } from "./siwe.js";
import { linkPrivyIdentity, privyConfigured } from "./privy.js";
import { ensureProfile } from "../store/profile.js";

// Web sign-in (SIWE, decisions.md D7). Route contract: the table at the top of packages/api-client/src/index.ts.
//   GET  /api/auth/nonce?address=0x...   → SiweNonce (+ domain, uri, issuedAt and a ready `message`)
//   POST /api/auth/verify { message, signature, returnToken? } → { wallet, expiresIn, token? } + httpOnly session cookie
//   POST /api/auth/logout, GET /api/auth/me
//   POST /api/auth/privy/link { identityToken } (or the `privy-id-token` header) → { linked } (only when Privy is configured)

export const authRouter = Router();

const SESSION_TTL_SECS = 24 * 3600;

authRouter.get(
  "/nonce",
  h(async (req) => {
    // `wallet` is accepted as an alias of `address`.
    const q = parse(z.object({ address: z.string().max(64).optional(), wallet: z.string().max(64).optional() }), req.query);
    return createNonce(q.address ?? q.wallet ?? "");
  }),
);

authRouter.post(
  "/verify",
  h(async (req, res) => {
    const body = parse(
      z.object({
        message: z.string().max(2000),
        signature: z.string().max(4096),
        /** Optional: when present it must be the message's address. */
        address: z.string().max(64).optional(),
        wallet: z.string().max(64).optional(),
        /** Only for clients outside the browser (SSR, agents, scripts); the web app uses the httpOnly cookie. */
        returnToken: z.boolean().optional(),
      }),
      req.body,
    );
    const wallet = await verifySiwe({ message: body.message, signature: body.signature, address: body.address ?? body.wallet }, "login");
    await ensureProfile(wallet);
    const token = await signSession(wallet);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_SECS * 1000,
      path: "/",
    });
    return { wallet, expiresIn: SESSION_TTL_SECS, ...(body.returnToken ? { token } : {}) };
  }),
);

authRouter.post(
  "/logout",
  h(async (req, res) => {
    // The memory key of this session goes away with it.
    if (req.tokenId) await db.delete(schema.memoryKeys).where(eq(schema.memoryKeys.tokenId, req.tokenId));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  h(async (req) => ({ wallet: requireWallet(req) })),
);

authRouter.post(
  "/privy/link",
  requireAuth,
  h(async (req, res) => {
    if (!privyConfigured()) {
      res.status(404);
      return { error: "Privy linking is not enabled", code: "not_found" };
    }
    const body = parse(z.object({ identityToken: z.string().max(8192).optional() }), req.body ?? {});
    const header = req.headers["privy-id-token"];
    const token = body.identityToken ?? (typeof header === "string" ? header : undefined);
    if (!token) {
      res.status(400);
      return { error: "identityToken is required", code: "validation" };
    }
    return linkPrivyIdentity(requireWallet(req), token);
  }),
);
