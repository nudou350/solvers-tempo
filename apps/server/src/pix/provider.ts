import { eq } from "drizzle-orm";
import type { ChargeIntent, PixCharge, PixConfig, WebhookRequest } from "@solvers/shared";

import { explorerUrl } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { CHAIN, env } from "../env.js";
import { HttpError, badRequest } from "../lib/http.js";
import { expiresAtOf, loadByProviderChargeId, patchCharge, payloadOf, type LedgerRow, type ProviderPayload } from "../payments/ledger.js";
import { PlatformProvider, type CreateContext, type PaymentState, type StartedPayment } from "../payments/platform-provider.js";
import { brlQuote } from "../store/fx.js";
import { cancelOrder, createPixOrder, getOrder, orderPayment, refundOrder, verifyWebhookSignature } from "./mercadopago.js";
import {
  PIX_EXPIRY_GRACE_MS,
  PIX_MAX_CENTS,
  PIX_MIN_CENTS,
  PIX_TTL_MS,
  brlCentsFor,
  formatRateE8,
  mpOrderOutcome,
  pixLimitError,
  rateToE8,
  simulateBlockReason,
  simulatedPixCode,
} from "./rules.js";

// pix-intermediated (decisions.md D10): the buyer pays ONE purchase in BRL through Mercado Pago; once the order is paid
// (status re-read from GET /v1/orders, never from the webhook body), the platform buys it on-chain for the buyer from
// its stablecoin float (`*For(buyer, …, purchaseId)`, payments/fulfil.ts). Off mainnet, without Mercado Pago credentials,
// the provider is simulated (PIX_SIMULATE): a placeholder code that no bank can pay, approved by the simulate route.
//
// Pix stays off on mainnet until the owner's open questions are answered (docs/payments-open-questions.md).

export type PixMode = "mercadopago" | "simulated";

export function pixMode(): PixMode | null {
  return env.MP_ACCESS_TOKEN ? "mercadopago" : env.PIX_SIMULATE ? "simulated" : null;
}

const isMainnet = () => env.CHAIN_ID === CHAIN.mainnet;

export function pixConfig(): PixConfig {
  const provider = isMainnet() ? null : pixMode();
  return {
    enabled: provider !== null,
    // Simulation only applies to charges of the simulated provider; with Mercado Pago on, a Pix is only paid for real.
    simulate: provider === "simulated" && env.PIX_SIMULATE,
    provider,
    minBrl: PIX_MIN_CENTS / 100,
    maxBrl: PIX_MAX_CENTS / 100,
  };
}

const modeOf = (row: LedgerRow): PixMode => (payloadOf(row).mode === "mercadopago" ? "mercadopago" : "simulated");

export class PixIntermediatedProvider extends PlatformProvider {
  readonly id = "pix-intermediated" as const;
  protected readonly prefix = "pix";

  protected ttlMs(): number {
    return PIX_TTL_MS;
  }

  protected override async quote(intent: ChargeIntent) {
    const fx = await brlQuote();
    const rateE8 = rateToE8(fx.rate);
    const units =
      intent.kind === "license" ? intent.expectedPrice : intent.kind === "credits" ? intent.maxTotal : intent.milestones.reduce((s, m) => s + m.amount, 0n);
    const cents = brlCentsFor(units, rateE8, env.PAYMENT_TOKEN_DECIMALS);
    const limit = pixLimitError(cents);
    if (limit) throw badRequest(limit.message, limit.code);
    return { amountBrlCents: cents, fxRate: formatRateE8(rateE8), fxSource: fx.source };
  }

  protected async startPayment(row: LedgerRow, _intent: ChargeIntent, _ctx: CreateContext): Promise<StartedPayment> {
    const mode = pixMode();
    if (!mode || isMainnet()) throw new HttpError(503, "Pix is not configured on this server.", "pix_unavailable");
    const cents = row.amountBrlCents!;
    if (mode === "simulated") {
      return { providerChargeId: `sim_${row.id}`, payload: { mode, qrCode: simulatedPixCode(row.id, cents), qrBase64: null, ticketUrl: null } };
    }
    const [profile] = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.wallet, row.buyerWallet));
    const order = await createPixOrder({
      externalReference: row.id,
      amountCents: cents,
      email: profile?.email ?? `pix-${row.buyerWallet.slice(2, 10)}@solvers.wondervelop.com`,
      firstName: profile?.displayName?.split(" ")[0] ?? "Customer",
    });
    return { providerChargeId: order.id, payload: { mode, ...orderPayment(order) } };
  }

  protected override expiresLocally(row: LedgerRow): boolean {
    return modeOf(row) === "simulated";
  }

  protected async paymentState(row: LedgerRow, now: Date): Promise<PaymentState> {
    if (modeOf(row) === "simulated") return payloadOf(row).simulatedPaid === true ? "paid" : "pending";
    if (!row.providerChargeId) return "failed";
    const order = await getOrder(row.providerChargeId);
    if (order.external_reference && order.external_reference !== row.id) {
      console.error("[pix] order external_reference mismatch", row.id, order.id);
      return "pending";
    }
    const outcome = mpOrderOutcome(order.status);
    if (outcome === "paid") return "paid";
    if (outcome === "expired") return "expired";
    if (outcome === "failed" || outcome === "refunded") return "failed";
    // Still payable: after our expiry plus a grace period, close it at Mercado Pago first, then expire it here.
    const exp = expiresAtOf(row);
    if (exp && exp.getTime() + PIX_EXPIRY_GRACE_MS < now.getTime()) {
      const after = await cancelOrder(row.providerChargeId, `cancel-${row.id}`).catch(() => getOrder(row.providerChargeId!));
      const o = mpOrderOutcome(after.status);
      return o === "paid" ? "paid" : o === "pending" ? "pending" : "expired";
    }
    return "pending";
  }

  protected async returnPayment(row: LedgerRow, _reason: string): Promise<ProviderPayload> {
    if (modeOf(row) === "simulated") return { refund: "simulated" };
    const order = await refundOrder(row.providerChargeId!, `refund-${row.id}`);
    return { refund: "mercadopago", mpStatus: order.status };
  }

  protected override paymentView(row: LedgerRow): Record<string, unknown> {
    const p = payloadOf(row);
    return { mode: modeOf(row), qrCode: p.qrCode ?? null, qrCodeBase64: p.qrBase64 ?? null, ticketUrl: p.ticketUrl ?? null };
  }

  /** Simulated provider only: marks the Pix paid, then confirms and fulfils like a real notification. */
  async simulatePayment(chargeId: string): Promise<LedgerRow> {
    if (isMainnet() || !env.PIX_SIMULATE) throw badRequest("Payment simulation is disabled on this server.", "pix_simulate_disabled");
    const row = await this.load(chargeId);
    if (simulateBlockReason(modeOf(row))) {
      throw badRequest("This charge is from Mercado Pago and is only approved when the Pix is actually paid.", "pix_not_simulated");
    }
    if (row.status === "failed") throw badRequest("This charge failed; create a new one.", "pix_failed");
    const exp = expiresAtOf(row);
    if (row.status === "expired" || (row.status === "pending_payment" && exp && exp.getTime() < Date.now())) {
      throw badRequest("This charge expired; create a new one.", "pix_expired");
    }
    await patchCharge(row.id, { payload: { simulatedPaid: true } });
    const confirmed = await this.confirm(row.id);
    if (confirmed.status === "confirmed") await this.fulfill(row.id);
    return this.load(row.id);
  }

  /**
   * Mercado Pago notification: the signature is checked, only the order id is used (it is covered by the signature
   * when it comes in the query) and the state is re-read from the API. Replays are harmless (confirm and fulfil are
   * idempotent). Returns null when the notification is not for one of our charges.
   */
  async handleWebhook(raw: WebhookRequest): Promise<{ chargeId: string } | null> {
    const header = (k: string) => {
      const v = raw.headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    // Only the query is covered by the signature (`data.id`); the body is never used, not even as a fallback.
    const queryId = raw.query["data.id"];
    const ok = verifyWebhookSignature({
      signature: header("x-signature"),
      requestId: header("x-request-id"),
      dataId: queryId,
      secret: env.MP_WEBHOOK_SECRET,
    });
    if (!ok) throw new HttpError(401, "invalid webhook signature", "unauthorized");
    const orderId = queryId;
    const type = raw.query.type;
    if (!orderId || (type && type !== "order")) return null;
    const row = (await loadByProviderChargeId(this.id, orderId)) ?? (await loadByProviderChargeId(this.id, orderId.toUpperCase()));
    if (!row) return null;
    const charge = await this.confirm(row.id);
    if (charge.status === "confirmed") await this.fulfill(row.id);
    return { chargeId: row.id };
  }

  toPixCharge(row: LedgerRow): PixCharge {
    const p = payloadOf(row);
    const exp = expiresAtOf(row) ?? row.createdAt;
    const fulfilledTx = row.status === "fulfilled" ? (row.txHash as `0x${string}` | null) : null;
    return {
      id: row.id,
      provider: modeOf(row),
      status: row.status as PixCharge["status"],
      kind: row.kind as PixCharge["kind"],
      agentId: row.agentId,
      purchaseId: row.purchaseId as `0x${string}`,
      amountBrl: Number(row.amountBrlCents ?? 0n) / 100,
      amountUnits: row.tokenAmount.toString(),
      qrCode: (p.qrCode as string | null | undefined) ?? null,
      qrCodeBase64: (p.qrBase64 as string | null | undefined) ?? null,
      ticketUrl: (p.ticketUrl as string | null | undefined) ?? null,
      expiresAt: exp.toISOString(),
      txHash: fulfilledTx,
      explorerUrl: fulfilledTx ? explorerUrl(fulfilledTx) : null,
      simulated: modeOf(row) === "simulated",
      createdAt: row.createdAt.toISOString(),
    };
  }
}
