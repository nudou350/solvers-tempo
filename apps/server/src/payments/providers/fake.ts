import type { ChargeIntent, WebhookRequest } from "@solvers/shared";

import type { LedgerRow, ProviderPayload } from "../ledger.js";
import { PlatformProvider, type CreateContext, type PaymentState, type StartedPayment } from "../platform-provider.js";

// In-memory payment provider for tests (plan §5): the money side lives in memory (`pay()`, refunds recorded in
// `refunds`), everything else is the real platform path (ledger, lifecycle, fulfilment from the float, reconcile).
// `failFulfillOnce()` makes the next `fulfill` throw before touching the charge (a transient provider/infra failure);
// `replayWebhook()` delivers the same notification again.

export class FakeProvider extends PlatformProvider {
  readonly id = "fake" as const;
  protected readonly prefix = "fake";
  private readonly paid = new Set<string>();
  private failures = 0;
  /** Refunds the provider performed: chargeId -> reason. */
  readonly refunds = new Map<string, string>();
  /** Webhook notifications received (including replays). */
  webhooks = 0;

  constructor(private readonly ttl = 30 * 60_000) {
    super();
  }

  protected ttlMs(): number {
    return this.ttl;
  }

  protected async startPayment(row: LedgerRow, _intent: ChargeIntent, _ctx: CreateContext): Promise<StartedPayment> {
    return { providerChargeId: `fake-${row.id}`, payload: { fake: true } };
  }

  protected async paymentState(row: LedgerRow): Promise<PaymentState> {
    return this.paid.has(row.id) ? "paid" : "pending";
  }

  /** How many times `returnPayment` ran per charge (a refund must run once). */
  readonly refundCalls = new Map<string, number>();
  /** Delay inside `returnPayment` (lets tests overlap concurrent refunds). */
  refundDelayMs = 0;

  protected async returnPayment(row: LedgerRow, reason: string): Promise<ProviderPayload> {
    this.refundCalls.set(row.id, (this.refundCalls.get(row.id) ?? 0) + 1);
    if (this.refundDelayMs) await new Promise((r) => setTimeout(r, this.refundDelayMs));
    this.refunds.set(row.id, reason);
    return { fakeRefund: true };
  }

  /** The buyer pays (in memory). */
  pay(chargeId: string): void {
    this.paid.add(chargeId);
  }

  failFulfillOnce(): void {
    this.failures++;
  }

  override async fulfill(chargeId: string) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("fake: injected fulfilment failure");
    }
    return super.fulfill(chargeId);
  }

  /** Body `{ "chargeId": "..." }`; the state comes from `paymentState`, never from the body. */
  async handleWebhook(raw: WebhookRequest): Promise<{ chargeId: string } | null> {
    this.webhooks++;
    let chargeId: string | undefined;
    try {
      chargeId = (JSON.parse(raw.body) as { chargeId?: string }).chargeId;
    } catch {
      return null;
    }
    if (!chargeId) return null;
    const charge = await this.confirm(chargeId);
    if (charge.status === "confirmed") await this.fulfill(chargeId);
    return { chargeId };
  }

  replayWebhook(chargeId: string) {
    return this.handleWebhook({ headers: {}, query: {}, body: JSON.stringify({ chargeId }) });
  }
}
