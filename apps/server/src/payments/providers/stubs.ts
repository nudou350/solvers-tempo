import type { Charge, ChargeContext, ChargeIntent, PaymentProvider, ProviderCapabilities } from "@solvers/shared";

// Providers documented but not implemented (plan §5). Every operation throws `NotImplementedError`; they are listed in
// the registry so the API can answer "not available" consistently. Open points: docs/payments-open-questions.md.

export class NotImplementedError extends Error {
  readonly code = "not_implemented";
  constructor(provider: string, op: string) {
    super(`${provider}: ${op} is not implemented`);
    this.name = "NotImplementedError";
  }
}

abstract class StubProvider implements PaymentProvider {
  abstract readonly id: "pix-marketplace-split" | "fiat-onramp-to-wallet";
  abstract capabilities(): ProviderCapabilities;
  async createCharge(_intent: ChargeIntent, _ctx: ChargeContext): Promise<Charge> {
    throw new NotImplementedError(this.id, "createCharge");
  }
  async confirm(_chargeId: string): Promise<Charge> {
    throw new NotImplementedError(this.id, "confirm");
  }
  async fulfill(_chargeId: string): Promise<Charge> {
    throw new NotImplementedError(this.id, "fulfill");
  }
  async reconcile(_now: Date): Promise<{ advanced: number }> {
    throw new NotImplementedError(this.id, "reconcile");
  }
  async refund(_chargeId: string, _reason: string): Promise<Charge> {
    throw new NotImplementedError(this.id, "refund");
  }
}

/**
 * pix-marketplace-split: the buyer pays in BRL through a marketplace split, so the creator's share would be paid out in
 * BRL by the payment provider instead of on-chain. Not implemented: the contracts always pay the creator in the payment
 * token at purchase time, so this needs a future contract variant that records a sale already paid off-chain
 * (`…ForPrepaid`), plus the provider's marketplace onboarding of every creator.
 */
export class PixMarketplaceSplitProvider extends StubProvider {
  readonly id = "pix-marketplace-split" as const;
  capabilities(): ProviderCapabilities {
    return { kinds: ["license"], settlement: "external", refundable: true };
  }
}

/**
 * fiat-onramp-to-wallet: an on-ramp partner credits payment tokens to the buyer's own wallet, and the buyer then pays
 * with `direct-wallet`. Not implemented: no partner is chosen; the platform would only link to the on-ramp and never
 * handle the fiat side.
 */
export class FiatOnrampProvider extends StubProvider {
  readonly id = "fiat-onramp-to-wallet" as const;
  capabilities(): ProviderCapabilities {
    return { kinds: ["license", "credits", "escrow"], settlement: "buyer-onchain", refundable: false };
  }
}
