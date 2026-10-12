import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "./env.js";
import { authRouter } from "./auth/routes.js";
import { optionalAuth } from "./auth/jwt.js";
import { storeRouter } from "./store/routes.js";
import { paymentsRouter } from "./payments/routes.js";
import { pixRouter, pixWebhookRouter } from "./pix/routes.js";
import { relayRouter } from "./relay/routes.js";
import { errorHandler } from "./lib/http.js";
import { pool } from "./db/index.js";
import { submissionUploadHandlers } from "./submissions/upload.js";

/** Extra routes registered by other modules (MCP, OAuth, guarantees, ...) before the error handler. */
export type Mount = (app: Express) => void;

/**
 * The Express app. `mounts` add the module routers (src/modules.ts); route tests call `createApp([])` and sign a session
 * with `signSession(wallet)` (no Privy, no chain).
 */
export function createApp(mounts: Mount[] = []): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("select 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const origins = new Set([env.PUBLIC_WEB_URL.replace(/\/$/, "")]);
  if (env.NODE_ENV !== "production") {
    // Dev web app (D13: 3001) and the usual local tooling ports.
    origins.add("http://localhost:3001");
    origins.add("http://localhost:3000");
    origins.add("http://localhost:5173");
  }
  const webCors = cors({
    origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
    credentials: true,
  });

  // Always per IP; per wallet on top (switching wallets does not bypass the IP limit).
  const byIp = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_PER_MINUTE * 3,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment and try again.", code: "rate_limited" },
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  });
  const byWallet = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_PER_MINUTE * 2,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment and try again.", code: "rate_limited" },
    skip: (req) => !req.wallet,
    keyGenerator: (req) => req.wallet ?? "anon",
  });
  // Costly routes (CPU embeddings, RPC waits, transaction building, faucet).
  const costly = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment and try again.", code: "rate_limited" },
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  });

  // Package ZIP upload (raw body up to SUBMISSION_MAX_ZIP_BYTES, streamed to disk): BEFORE express.json, with login and
  // profile checked before the body is read (submissions/upload.ts; PACKAGE_SPEC.md 14.4).
  app.post("/api/creator/submissions", webCors, byIp, ...submissionUploadHandlers);

  // Mercado Pago signs only the query and headers; the router reads the raw text itself (no JSON parser here).
  app.use("/webhooks", pixWebhookRouter);
  app.use("/api", webCors, express.json({ limit: "256kb" }), cookieParser(), byIp, optionalAuth, byWallet);
  app.use(["/api/search", "/api/tx", "/api/faucet"], costly);
  // Creating Pix and Solana Pay charges, purchase intents and agent orders has the faucet's limit; polling them does not.
  app.use(["/api/pix", "/api/solana-pay", "/api/purchases", "/api/agent-pay"], (req, res, next) => (req.method === "POST" ? costly(req, res, next) : next()));
  app.use("/api/auth", authRouter);
  // Fee-paying relay (D3): JSON-RPC behind the session (the router itself refuses requests without a session).
  app.use("/api", relayRouter);
  app.use("/api", storeRouter);
  app.use("/api", paymentsRouter);
  app.use("/api", pixRouter);

  for (const mount of mounts) mount(app);

  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found", code: "not_found" });
  });
  app.use(errorHandler);
  return app;
}
