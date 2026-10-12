import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { PurchaseIntentInput, type SolanaPayCharge } from "@solvers/shared";

import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { HttpError, badRequest, h, notFound, parse } from "../lib/http.js";
import { initPayments, solanaPayProvider } from "../payments/index.js";
import { preparePurchase } from "../payments/intent.js";
import { loadCharge, type LedgerRow } from "../payments/ledger.js";
import { solanaPayConfig } from "./provider.js";
import { SOLANA_PAY_MAX_PENDING } from "./rules.js";

// Solana Pay routes. One charge buys one thing (license, credits or guarantee) for the session wallet; the buyer pays in
// USDC on Solana and, once the payment is found and validated, the platform completes the purchase on Tempo from its float.
// No webhook: the GET below and the payments reconcile job re-read Solana.
//
//   POST /api/solana-pay/charges          PurchaseIntentInput -> SolanaPayCharge
//   GET  /api/solana-pay/charges/:id      SolanaPayCharge (re-reads Solana while unpaid, and for 72 h after expiry)

initPayments();

export const solanaPayRouter = Router();

async function ownCharge(wallet: string, id: string): Promise<LedgerRow> {
  const row = await loadCharge(id);
  if (!row || row.provider !== "solana-pay" || row.buyerWallet !== wallet.toLowerCase()) throw notFound("Solana Pay charge not found");
  return row;
}

solanaPayRouter.post(
  "/solana-pay/charges",
  requireAuth,
  h(async (req): Promise<SolanaPayCharge> => {
    if (!solanaPayConfig().enabled) throw badRequest("Solana Pay is not available on this server.", "solana_pay_unavailable");
    const buyer = requireWallet(req).toLowerCase();
    const input = parse(PurchaseIntentInput, req.body);

    const open = await db
      .select({ id: schema.paymentLedger.id, providerPayload: schema.paymentLedger.providerPayload })
      .from(schema.paymentLedger)
      .where(
        and(
          eq(schema.paymentLedger.provider, "solana-pay"),
          eq(schema.paymentLedger.buyerWallet, buyer),
          inArray(schema.paymentLedger.status, ["created", "pending_payment"]),
        ),
      );
    const now = Date.now();
    const live = open.filter((r) => {
      const exp = (r.providerPayload as { expiresAt?: string } | null)?.expiresAt;
      return !exp || Date.parse(exp) > now;
    });
    if (live.length >= SOLANA_PAY_MAX_PENDING) {
      throw new HttpError(
        429,
        `You already have ${SOLANA_PAY_MAX_PENDING} open Solana Pay charges. Pay them or wait for them to expire.`,
        "solana_pending_limit",
      );
    }

    const prepared = await preparePurchase(input, buyer);
    const p = solanaPayProvider();
    const charge = await p.createCharge(prepared.intent, { now: new Date(), sessionWallet: buyer as `0x${string}`, ip: req.ip ?? null, details: prepared.details });
    return p.toSolanaPayCharge((await loadCharge(charge.id))!);
  }),
);

solanaPayRouter.get(
  "/solana-pay/charges/:id",
  requireAuth,
  h(async (req): Promise<SolanaPayCharge> => {
    const row = await ownCharge(requireWallet(req), String(req.params.id));
    const p = solanaPayProvider();
    // Unpaid, or expired but still inside the late-payment window: re-read Solana.
    if (row.status === "pending_payment" || row.status === "created" || p.lateScanOpen(row)) {
      const charge = await p.confirm(row.id).catch((e) => {
        console.error("[solana-pay] payment check failed", row.id, (e as Error).message);
        return null;
      });
      if (charge?.status === "confirmed") await p.fulfill(row.id).catch((e) => console.error("[solana-pay] fulfilment failed", row.id, e));
      return p.toSolanaPayCharge((await loadCharge(row.id))!);
    }
    return p.toSolanaPayCharge(row);
  }),
);
