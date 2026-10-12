import { purchaseIdFor, type Charge, type ChargeContext, type ChargeIntent, type PaymentProvider, type PaymentProviderId, type ProviderCapabilities } from "@solvers/shared";

import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { notFound } from "../lib/http.js";
import { readPurchaseRef } from "./chain.js";
import { finishFromRef, fulfilFromFloat, resumeFulfilling } from "./fulfil.js";
import { amountOfIntent, detailsOfIntent } from "./intent.js";
import {
  claimStep,
  expiresAtOf,
  insertCharge,
  loadCharge,
  newChargeId,
  openCharges,
  payloadOf,
  toCharge as toChargeOf,
  transition,
  type LedgerPatch,
  type LedgerRow,
  type ProviderPayload,
} from "./ledger.js";
import { OPEN_STATUSES } from "./lifecycle.js";

// Base of the providers that settle off-chain (or into the platform) and fulfil from the PLATFORM float
// (`settlement: "platform-onchain"`): pix-intermediated, agent-pay and the in-memory fake. Subclasses implement only the
// payment side (start, status, refund); the ledger, the lifecycle, the fulfilment and the reconcile loop live here.

/** Extra context accepted by `createCharge`: the ledger `intent` details computed by `preparePurchase`. */
export type CreateContext = ChargeContext & { details?: Record<string, unknown> };

/** What the payment provider says about a charge. */
export type PaymentState = "paid" | "pending" | "expired" | "failed";

export type StartedPayment = { providerChargeId?: string | null; payload?: ProviderPayload };

/** A `refunding` row untouched for this long is resumed by the reconcile job (the request path may still be sending). */
export const STALE_REFUNDING_MS = 120_000;

/** Refunds being sent by this process (the reconcile job skips them). */
const refundsInFlight = new Set<string>();

export abstract class PlatformProvider implements PaymentProvider {
  abstract readonly id: PaymentProviderId;
  /** Charge id prefix (`pix_…`, `ap_…`). */
  protected abstract readonly prefix: string;
  /** How long an unpaid charge stays open. */
  protected abstract ttlMs(): number;
  /** Ledger columns computed before the row is written (e.g. BRL amount and FX rate). */
  protected async quote(_intent: ChargeIntent, _ctx: CreateContext): Promise<Partial<LedgerPatch> & { amountBrlCents?: bigint; fxRate?: string; fxSource?: string }> {
    return {};
  }
  /** Opens the payment at the provider (called right after the ledger row is written). */
  protected abstract startPayment(row: LedgerRow, intent: ChargeIntent, ctx: CreateContext): Promise<StartedPayment>;
  /** Re-reads the payment at the provider (never trusts a webhook body). */
  protected abstract paymentState(row: LedgerRow, now: Date): Promise<PaymentState>;
  /**
   * Whether an unpaid charge may be expired on the local clock alone. Providers that can still be paid after our expiry
   * (a real Pix order) return false and report `expired` from `paymentState` once the provider side is closed.
   */
  protected expiresLocally(_row: LedgerRow): boolean {
    return true;
  }
  /** Gives the money back through the provider; must be idempotent (called again after a crash). */
  protected abstract returnPayment(row: LedgerRow, reason: string): Promise<ProviderPayload>;
  /** Provider-facing data for the client (e.g. Pix QR code). */
  protected paymentView(_row: LedgerRow): Record<string, unknown> | null {
    return null;
  }

  capabilities(): ProviderCapabilities {
    return { kinds: ["license", "credits", "escrow"], settlement: "platform-onchain", refundable: true };
  }

  view(row: LedgerRow): Charge {
    return { ...toChargeOf(row), payment: this.paymentView(row) };
  }

  async createCharge(intent: ChargeIntent, ctx: CreateContext): Promise<Charge> {
    const id = newChargeId(this.prefix);
    const quote = await this.quote(intent, ctx);
    const expiresAt = new Date(ctx.now.getTime() + this.ttlMs());
    let row = await insertCharge({
      id,
      provider: this.id,
      purchaseId: purchaseIdFor(id).toLowerCase(),
      kind: intent.kind,
      buyerWallet: intent.buyer.toLowerCase(),
      payerWallet: chainContext().accounts.platform.address.toLowerCase(),
      agentId: intent.agentId,
      intent: ctx.details ?? detailsOfIntent(intent),
      tokenAddress: env.PAYMENT_TOKEN,
      tokenAmount: amountOfIntent(intent),
      amountBrlCents: quote.amountBrlCents ?? null,
      fxRate: quote.fxRate ?? null,
      fxSource: quote.fxSource ?? null,
      status: "created",
      providerPayload: { expiresAt: expiresAt.toISOString(), ...(ctx.ip ? { ip: ctx.ip } : {}) },
    });
    try {
      const started = await this.startPayment(row, intent, ctx);
      row =
        (await transition(id, ["created"], "pending_payment", {
          providerChargeId: started.providerChargeId ?? null,
          ...(started.payload ? { payload: started.payload } : {}),
        })) ?? (await loadCharge(id))!;
    } catch (e) {
      await transition(id, ["created"], "failed", { error: ((e as Error).message ?? "provider error").slice(0, 500) });
      throw e;
    }
    return this.view(row);
  }

  async load(chargeId: string): Promise<LedgerRow> {
    const row = await loadCharge(chargeId);
    if (!row || row.provider !== this.id) throw notFound("Charge not found");
    return row;
  }

  /** Marks the charge paid (provider proved it). Late payments revive an expired charge. */
  protected async markPaid(row: LedgerRow, patch: LedgerPatch = {}): Promise<LedgerRow> {
    return (await transition(row.id, ["created", "pending_payment", "expired"], "confirmed", { confirmedAt: new Date(), error: null, ...patch })) ?? (await loadCharge(row.id))!;
  }

  async confirm(chargeId: string): Promise<Charge> {
    let row = await this.load(chargeId);
    if (row.status === "created" || row.status === "pending_payment" || row.status === "expired") {
      const state = await this.paymentState(row, new Date());
      if (state === "paid") row = await this.markPaid(row);
      else if (state === "expired" && row.status !== "expired") row = (await transition(row.id, ["created", "pending_payment"], "expired")) ?? row;
      else if (state === "failed") row = (await transition(row.id, ["created", "pending_payment"], "failed")) ?? row;
    }
    return this.view(row);
  }

  async fulfill(chargeId: string): Promise<Charge> {
    await this.load(chargeId);
    const row = await fulfilFromFloat(chargeId, { refund: (r, reason) => this.refundRow(r, reason) });
    return this.view(row);
  }

  /**
   * confirmed/fulfilling -> refunding -> refunded (idempotent: a crash in between is finished by `reconcile`). The chain
   * is read again first: a purchase that landed late (e.g. a send that was mined after its receipt wait timed out)
   * makes the charge fulfilled instead.
   */
  protected async refundRow(row: LedgerRow, reason: string): Promise<LedgerRow> {
    const ref = await readPurchaseRef(chainContext().accounts.platform.address, row.purchaseId);
    if (ref !== 0n) return finishFromRef(row, ref);
    const moving = (await transition(row.id, ["confirmed", "fulfilling"], "refunding", { error: reason })) ?? (await loadCharge(row.id))!;
    if (moving.status !== "refunding") return moving;
    return this.sendRefund(moving, reason);
  }

  /**
   * Gives the money back for a `refunding` row exactly once: the caller first claims the step (`refundClaimedAt`, see
   * `claimStep`), so the request path and the reconcile job can never both call `returnPayment` at the same time. A
   * crash after the claim leaves the row `refunding`; the claim goes stale after STALE_REFUNDING_MS and the reconcile job
   * takes it over, and `returnPayment` itself is idempotent (provider idempotency key / transaction journal).
   */
  protected async sendRefund(row: LedgerRow, reason: string, now = new Date()): Promise<LedgerRow> {
    const claimed = await claimStep(row.id, ["refunding"], "refundClaimedAt", STALE_REFUNDING_MS);
    if (!claimed) return (await loadCharge(row.id))!;
    refundsInFlight.add(row.id);
    try {
      const payload = await this.returnPayment(claimed, reason);
      return (
        (await transition(row.id, ["refunding"], "refunded", { payload: { ...payload, refundReason: reason, refundedAt: now.toISOString() } })) ??
        (await loadCharge(row.id))!
      );
    } finally {
      refundsInFlight.delete(row.id);
    }
  }

  async refund(chargeId: string, reason: string): Promise<Charge> {
    return this.view(await this.refundRow(await this.load(chargeId), reason));
  }

  /** Expires stale unpaid charges, fulfils confirmed ones, resumes interrupted fulfilments and refunds. */
  async reconcile(now: Date): Promise<{ advanced: number }> {
    let advanced = 0;
    for (const row of await openCharges(this.id, OPEN_STATUSES)) {
      try {
        const after = await this.reconcileOne(row, now);
        if (after.status !== row.status) advanced++;
      } catch (e) {
        console.error(`[payments] reconcile ${row.id} failed:`, (e as Error).message);
      }
    }
    return { advanced };
  }

  protected async reconcileOne(row: LedgerRow, now: Date): Promise<LedgerRow> {
    const opts = { refund: (r: LedgerRow, reason: string) => this.refundRow(r, reason), now: () => now };
    switch (row.status) {
      case "created":
      case "pending_payment": {
        const state = await this.paymentState(row, now);
        if (state === "paid") return fulfilFromFloat((await this.markPaid(row)).id, opts);
        if (state === "failed") return (await transition(row.id, ["created", "pending_payment"], "failed")) ?? row;
        const exp = expiresAtOf(row);
        if (state === "expired" || (this.expiresLocally(row) && exp && exp.getTime() < now.getTime())) {
          return (await transition(row.id, ["created", "pending_payment"], "expired")) ?? row;
        }
        return row;
      }
      case "confirmed":
        return fulfilFromFloat(row.id, opts);
      case "fulfilling":
        return resumeFulfilling(row, opts);
      case "refunding": {
        // The request path may be sending this refund right now: leave it alone until it is stale.
        if (refundsInFlight.has(row.id) || now.getTime() - row.updatedAt.getTime() < STALE_REFUNDING_MS) return row;
        return this.sendRefund(row, row.error ?? "refund", now);
      }
      default:
        return row;
    }
  }
}

