import { Router } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { h, HttpError, parse } from "../lib/http.js";
import { escalate } from "../notify/telegram.js";
import { findAgentRow } from "./catalog.js";
import { buildHelpSummary, HELP_PER_HOUR, HelpRequest } from "./help-rules.js";

// A customer's help request to the creator, from the storefront. Reuses the MCP ticket (escalate): the creator is
// notified on Telegram and the ticket stays in `escalations`. The creator's contact never leaves the server.

export const helpRouter = Router();

helpRouter.post(
  "/agents/:idOrSlug/help",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const { message, contact } = parse(HelpRequest, req.body);
    const agent = await findAgentRow(String(req.params.idOrSlug));

    // Limit per wallet (all specialists together), counted in the database: holds across restarts and instances.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.escalations)
      .where(and(eq(schema.escalations.wallet, wallet), gt(schema.escalations.createdAt, new Date(Date.now() - 3600_000))));
    if (n >= HELP_PER_HOUR) {
      throw new HttpError(429, "You've already sent a few requests a moment ago. Wait an hour or wait for the reply.", "rate_limited");
    }

    const { protocol, notified } = await escalate(wallet, agent.id, null, buildHelpSummary(message, contact || undefined));
    return { protocol, notified };
  }),
);
