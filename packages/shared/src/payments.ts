import { z } from "zod";
import { Address, Bytes32, TxHash, UnitsString, type Address as AddressT, type Call, type Hex as HexT } from "./evm.js";

// Payment providers (plan §5). Pure types and the zod schemas of what crosses the API; the implementations, the ledger
// (`payment_ledger`) and the reconcile job live in apps/server/src/payments. Every charge buys exactly one thing
// (license, credits or guarantee) for one buyer, and carries `purchaseId = purchaseIdFor(chargeId)` (evm.ts), which the
// contracts accept once.

export const CHARGE_STATUSES = [
  "created",
  "pending_payment",
  "confirmed",
  "fulfilling",
  "fulfilled",
  "refunding",
  "refunded",
  "expired",
  "failed",
] as const;
export const ChargeStatus = z.enum(CHARGE_STATUSES);
export type ChargeStatus = z.infer<typeof ChargeStatus>;

export const PAYMENT_PROVIDER_IDS = [
  /** Buyer pays from their own wallet (sponsored batch `[approve, purchase]`); used by the web checkout, agents, dev kit. */
  "direct-wallet",
  /** Pix via Mercado Pago; the platform fulfils on-chain from its stablecoin float (decisions.md D10). */
  "pix-intermediated",
  /** Agents over HTTP 402 (MPP `charge` intent); settles into the PLATFORM float (X24), then the same fulfilment as Pix (D4). */
  "agent-pay",
  /** USDC on Solana via a Solana Pay transfer request; then the same fulfilment from the PLATFORM float as Pix. */
  "solana-pay",
  /** Stub: marketplace split paid in BRL (open question, needs a future contract variant). */
  "pix-marketplace-split",
  /** Stub: on-ramp credits tokens to the buyer, who then pays with `direct-wallet`. */
  "fiat-onramp-to-wallet",
  /** In-memory provider for tests. */
  "fake",
] as const;
export const PaymentProviderId = z.enum(PAYMENT_PROVIDER_IDS);
export type PaymentProviderId = z.infer<typeof PaymentProviderId>;

export const CHARGE_KINDS = ["license", "credits", "escrow"] as const;
export const ChargeKind = z.enum(CHARGE_KINDS);
export type ChargeKind = z.infer<typeof ChargeKind>;

/** Who sends the purchase transaction: the buyer, the platform (`*For` from the float) or nobody yet (external). */
export const SETTLEMENT_MODES = ["buyer-onchain", "platform-onchain", "external"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export type ProviderCapabilities = {
  kinds: ChargeKind[];
  settlement: SettlementMode;
  refundable: boolean;
};

/** One milestone of a guarantee, as passed to `createEscrow[For]`. */
export type EscrowMilestoneIntent = { amount: bigint; criteriaHash: HexT };

/** What the buyer wants to buy. `agentId` is the 32-hex package id (D1); amounts are base units. */
export type ChargeIntent =
  | { kind: "license"; agentId: string; buyer: AddressT; expectedPrice: bigint }
  | { kind: "credits"; agentId: string; buyer: AddressT; amount: number; maxTotal: bigint }
  | {
      kind: "escrow";
      agentId: string;
      buyer: AddressT;
      milestones: EscrowMilestoneIntent[];
      reviewWindowSecs: number;
      /** 0 = contract default (14 days). */
      deliveryDays: number;
    };

/** Request context the provider may need (session wallet, client IP for limits, clock). */
export type ChargeContext = {
  now: Date;
  sessionWallet?: AddressT | null;
  ip?: string | null;
};

/** Server-side view of a charge (one `payment_ledger` row). */
export type Charge = {
  /** Our charge id (ledger primary key); `purchaseId = purchaseIdFor(id)`. */
  id: string;
  provider: PaymentProviderId;
  /** Provider's own id (Mercado Pago order, MPP challenge...), null for direct-wallet. */
  providerChargeId: string | null;
  purchaseId: HexT;
  kind: ChargeKind;
  agentId: string;
  buyer: AddressT;
  status: ChargeStatus;
  /** Token amount charged, in base units. */
  amount: bigint;
  token: AddressT;
  /** BRL side of an intermediated charge (null for token-only providers). */
  amountBrlCents: number | null;
  /** Exact FX rate used, as a decimal string (never a float). */
  fxRate: string | null;
  /** direct-wallet: the batch the buyer signs (`[approve, purchase]`). */
  calls: Call[] | null;
  txHash: HexT | null;
  error: string | null;
  /** Provider-facing payment data for the client (e.g. Pix QR code), opaque here. */
  payment: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  confirmedAt: Date | null;
  fulfilledAt: Date | null;
};

/** Raw webhook request handed to `handleWebhook` (the provider verifies the signature itself). */
export type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: string;
};

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  capabilities(): ProviderCapabilities;
  /** Issues the charge id and purchase id and writes the ledger row first; direct-wallet returns the call batch. */
  createCharge(intent: ChargeIntent, ctx: ChargeContext): Promise<Charge>;
  /** Provider GET or chain match; idempotent. */
  confirm(chargeId: string): Promise<Charge>;
  /** Verifies the signature, then `confirm()`. null when the request is not for us. */
  handleWebhook?(raw: WebhookRequest): Promise<{ chargeId: string } | null>;
  /** confirmed -> fulfilling -> fulfilled; platform-onchain persists the tx hash before broadcasting. */
  fulfill(chargeId: string): Promise<Charge>;
  /** Expires stale charges and resumes interrupted ones via `purchaseRef(payer, purchaseId)` (ids are scoped by payer, X22) or the receipt. */
  reconcile(now: Date): Promise<{ advanced: number }>;
  refund?(chargeId: string, reason: string): Promise<Charge>;
}

/** API view of a charge (GET /api/purchases/:chargeId): bigint as decimal strings, dates as ISO strings. */
export const ChargeView = z.object({
  id: z.string(),
  provider: PaymentProviderId,
  status: ChargeStatus,
  kind: ChargeKind,
  agentId: z.string(),
  buyer: Address,
  purchaseId: Bytes32,
  amountUnits: UnitsString,
  token: Address,
  amountBrlCents: z.number().int().nullable(),
  txHash: TxHash.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type ChargeView = z.infer<typeof ChargeView>;

export function toChargeView(c: Charge): ChargeView {
  return {
    id: c.id,
    provider: c.provider,
    status: c.status,
    kind: c.kind,
    agentId: c.agentId,
    buyer: c.buyer,
    purchaseId: c.purchaseId,
    amountUnits: c.amount.toString(),
    token: c.token,
    amountBrlCents: c.amountBrlCents,
    txHash: c.txHash,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    expiresAt: c.expiresAt?.toISOString() ?? null,
  };
}
