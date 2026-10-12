import { Router } from "express";
import { and, count, eq, gt, inArray } from "drizzle-orm";
import { PurchaseIntentInput, toChargeView, type ChargeView, type PaymentProvider, type PaymentProviderId, type PurchaseIntent } from "@solvers/shared";

import { requireAuth, requireWallet } from "../auth/jwt.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError, h, notFound, parse } from "../lib/http.js";
import { directWallet, initPayments } from "./index.js";
import { preparePurchase } from "./intent.js";
import { loadCharge, toCharge } from "./ledger.js";
import { getProvider, hasProvider } from "./registry.js";

// Purchase intents (plan §4.8, §5). The buyer is always the session wallet; the ledger row is written before the wallet
// receives the call batch, so every on-chain purchase has a charge id and a purchase id.
//
//   POST /api/purchases/intent      PurchaseIntentInput -> PurchaseIntent (`[approve, purchase]` for the wallet)
//   GET  /api/purchases/:chargeId   ChargeView (any provider; only the buyer sees it)

initPayments();

/** Open direct-wallet intents per wallet (abandoned intents expire after 30 min). */
export const MAX_OPEN_INTENTS = 20;

export const paymentsRouter = Router();

paymentsRouter.post(
  "/purchases/intent",
  requireAuth,
  h(async (req): Promise<PurchaseIntent> => {
    const buyer = requireWallet(req).toLowerCase();
    const input = parse(PurchaseIntentInput, req.body);
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(schema.paymentLedger)
      .where(
        and(
          eq(schema.paymentLedger.provider, "direct-wallet"),
          eq(schema.paymentLedger.buyerWallet, buyer),
          inArray(schema.paymentLedger.status, ["created", "pending_payment"]),
          gt(schema.paymentLedger.createdAt, new Date(Date.now() - 30 * 60_000)),
        ),
      );
    if (n >= MAX_OPEN_INTENTS) throw new HttpError(429, "Too many open purchases. Finish one or wait a few minutes.", "too_many_intents");
    const prepared = await preparePurchase(input, buyer);
    const charge = await directWallet().createCharge(prepared.intent, {
      now: new Date(),
      sessionWallet: buyer as `0x${string}`,
      ip: req.ip ?? null,
      details: prepared.details,
    });
    return {
      calls: charge.calls!,
      feePayer: true,
      chainId: env.CHAIN_ID,
      purchaseId: charge.purchaseId,
      chargeId: charge.id,
      kind: charge.kind,
      agentId: charge.agentId,
      amountUnits: charge.amount.toString(),
    };
  }),
);

paymentsRouter.get(
  "/purchases/:chargeId",
  requireAuth,
  h(async (req): Promise<ChargeView> => {
    const wallet = requireWallet(req).toLowerCase();
    const row = await loadCharge(String(req.params.chargeId));
    if (!row || row.buyerWallet !== wallet) throw notFound("Charge not found");
    // Open charges are re-checked on read (chain match or provider GET); settled ones are returned as stored.
    if ((row.status === "created" || row.status === "pending_payment") && hasProvider(row.provider as PaymentProviderId)) {
      const provider: PaymentProvider = getProvider(row.provider as PaymentProviderId);
      const charge = await provider.confirm(row.id).catch(() => toCharge(row));
      return toChargeView(charge);
    }
    return toChargeView(toCharge(row));
  }),
);
