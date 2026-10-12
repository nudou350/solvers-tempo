import express, { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { PurchaseIntentInput, type PixCharge } from "@solvers/shared";

import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { HttpError, badRequest, h, notFound, parse } from "../lib/http.js";
import { initPayments, pixProvider } from "../payments/index.js";
import { preparePurchase } from "../payments/intent.js";
import { loadCharge, type LedgerRow } from "../payments/ledger.js";
import { pixConfig } from "./provider.js";
import { PIX_MAX_PENDING } from "./rules.js";

// Pix routes (decisions.md D10). One charge buys one thing (license, credits or guarantee) for the session wallet; once
// paid, the platform completes the purchase on-chain from its float.
//
//   POST /api/pix/charges                 PurchaseIntentInput -> PixCharge
//   GET  /api/pix/charges/:id             PixCharge (re-reads Mercado Pago while unpaid)
//   POST /api/pix/charges/:id/simulate    simulated provider only (PIX_SIMULATE, never on mainnet)
//   POST /webhooks/mercadopago            Mercado Pago notification (signature, then GET /v1/orders)

initPayments();

export const pixRouter = Router();

async function ownCharge(wallet: string, id: string): Promise<LedgerRow> {
  const row = await loadCharge(id);
  if (!row || row.provider !== "pix-intermediated" || row.buyerWallet !== wallet.toLowerCase()) throw notFound("Pix charge not found");
  return row;
}

pixRouter.post(
  "/pix/charges",
  requireAuth,
  h(async (req): Promise<PixCharge> => {
    if (!pixConfig().enabled) throw badRequest("Pix is not available on this server.", "pix_unavailable");
    const buyer = requireWallet(req).toLowerCase();
    const input = parse(PurchaseIntentInput, req.body);

    const open = await db
      .select({ id: schema.paymentLedger.id, providerPayload: schema.paymentLedger.providerPayload })
      .from(schema.paymentLedger)
      .where(
        and(
          eq(schema.paymentLedger.provider, "pix-intermediated"),
          eq(schema.paymentLedger.buyerWallet, buyer),
          inArray(schema.paymentLedger.status, ["created", "pending_payment"]),
        ),
      );
    const now = Date.now();
    const live = open.filter((r) => {
      const exp = (r.providerPayload as { expiresAt?: string } | null)?.expiresAt;
      return !exp || Date.parse(exp) > now;
    });
    if (live.length >= PIX_MAX_PENDING) {
      throw new HttpError(429, `You already have ${PIX_MAX_PENDING} open Pix charges. Pay them or wait for them to expire.`, "pix_pending_limit");
    }

    const prepared = await preparePurchase(input, buyer);
    const p = pixProvider();
    const charge = await p.createCharge(prepared.intent, { now: new Date(), sessionWallet: buyer as `0x${string}`, ip: req.ip ?? null, details: prepared.details });
    return p.toPixCharge((await loadCharge(charge.id))!);
  }),
);

pixRouter.get(
  "/pix/charges/:id",
  requireAuth,
  h(async (req): Promise<PixCharge> => {
    const row = await ownCharge(requireWallet(req), String(req.params.id));
    const p = pixProvider();
    if (row.status === "pending_payment" || row.status === "created") {
      const charge = await p.confirm(row.id).catch(() => null);
      if (charge?.status === "confirmed") await p.fulfill(row.id).catch((e) => console.error("[pix] fulfilment failed", row.id, e));
      return p.toPixCharge((await loadCharge(row.id))!);
    }
    return p.toPixCharge(row);
  }),
);

pixRouter.post(
  "/pix/charges/:id/simulate",
  requireAuth,
  h(async (req): Promise<PixCharge> => {
    const row = await ownCharge(requireWallet(req), String(req.params.id));
    const p = pixProvider();
    return p.toPixCharge(await p.simulatePayment(row.id));
  }),
);

// ---------- Webhook (no session auth; authenticated by the signature) ----------

export const pixWebhookRouter = Router();

pixWebhookRouter.post(
  "/mercadopago",
  // Only the query (`data.id`, `type`) is used: the signature covers the id there, never the body.
  express.text({ type: "*/*", limit: "64kb" }),
  h(async (req) => {
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") query[k] = v;
    const body = typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : "";
    // An error here answers 500 and Mercado Pago retries later.
    const res = await pixProvider().handleWebhook({ headers: req.headers, query, body });
    if (!res) return { ok: true, ignored: true };
    const row = await loadCharge(res.chargeId);
    return { ok: true, status: row?.status };
  }),
);

