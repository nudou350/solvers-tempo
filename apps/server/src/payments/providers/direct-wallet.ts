import { buyCreditsCalls, createEscrowCalls, purchaseLicenseCalls, type Call } from "@solvers/chain";
import {
  agentIdToBytes32,
  purchaseIdFor,
  type Charge,
  type ChargeIntent,
  type PaymentProvider,
  type ProviderCapabilities,
} from "@solvers/shared";
import type { Hex } from "viem";

import { chainContext } from "../../chain/index.js";
import { env } from "../../env.js";
import { notFound } from "../../lib/http.js";
import { readPurchaseRef } from "../chain.js";
import { finishFromRef } from "../fulfil.js";
import { amountOfIntent, detailsOfIntent, intentOfRow } from "../intent.js";
import { expiresAtOf, insertCharge, loadCharge, newChargeId, openCharges, toCharge, transition, type LedgerRow } from "../ledger.js";
import type { CreateContext } from "../platform-provider.js";

// direct-wallet (buyer-onchain, plan §5): the buyer's wallet sends `[approve, purchase]` itself (sponsored by the relay),
// so payment and fulfilment are the same on-chain transaction. The ledger row is written first; the indexer's
// `SaleAuthorized` (handled in sale-hook.ts) or `purchaseRef(buyer, purchaseId)` marks it fulfilled. The platform never
// holds the money, so there is nothing to refund. Used by the web checkout, agents with a wallet and the dev kit.

/** An intent the wallet never sent is marked expired after this (the chain still wins if it lands later). */
export const DIRECT_WALLET_TTL_MS = 30 * 60_000;

export function walletCalls(intent: ChargeIntent, purchaseId: Hex): Call[] {
  const d = chainContext().deployment;
  const agentId = agentIdToBytes32(intent.agentId);
  if (intent.kind === "license") return purchaseLicenseCalls(d, { agentId, price: intent.expectedPrice, purchaseId });
  if (intent.kind === "credits") return buyCreditsCalls(d, { agentId, amount: intent.amount, maxTotal: intent.maxTotal, purchaseId });
  return createEscrowCalls(d, {
    agentId,
    milestones: intent.milestones,
    reviewWindowSecs: intent.reviewWindowSecs,
    deliveryDays: intent.deliveryDays,
    purchaseId,
  });
}

export class DirectWalletProvider implements PaymentProvider {
  readonly id = "direct-wallet" as const;

  capabilities(): ProviderCapabilities {
    return { kinds: ["license", "credits", "escrow"], settlement: "buyer-onchain", refundable: false };
  }

  view(row: LedgerRow, withCalls = false): Charge {
    const open = row.status === "created" || row.status === "pending_payment" || row.status === "expired";
    return toCharge(row, { calls: withCalls && open ? walletCalls(intentOfRow(row), row.purchaseId as Hex) : null });
  }

  async createCharge(intent: ChargeIntent, ctx: CreateContext): Promise<Charge> {
    const id = newChargeId("dw");
    const purchaseId = purchaseIdFor(id).toLowerCase();
    await insertCharge({
      id,
      provider: this.id,
      purchaseId,
      kind: intent.kind,
      buyerWallet: intent.buyer.toLowerCase(),
      payerWallet: intent.buyer.toLowerCase(),
      agentId: intent.agentId,
      intent: ctx.details ?? detailsOfIntent(intent),
      tokenAddress: env.PAYMENT_TOKEN,
      tokenAmount: amountOfIntent(intent),
      status: "created",
      providerPayload: { expiresAt: new Date(ctx.now.getTime() + DIRECT_WALLET_TTL_MS).toISOString() },
    });
    const row = (await transition(id, ["created"], "pending_payment"))!;
    return this.view(row, true);
  }

  async load(chargeId: string): Promise<LedgerRow> {
    const row = await loadCharge(chargeId);
    if (!row || row.provider !== this.id) throw notFound("Charge not found");
    return row;
  }

  /** Chain match: `purchaseRef(buyer, purchaseId)`; idempotent. */
  async confirm(chargeId: string): Promise<Charge> {
    return this.view(await this.check(await this.load(chargeId)));
  }

  private async check(row: LedgerRow): Promise<LedgerRow> {
    if (row.status === "fulfilled" || row.status === "refunded") return row;
    const ref = await readPurchaseRef(row.payerWallet, row.purchaseId);
    return ref !== 0n ? finishFromRef(row, ref) : row;
  }

  /** The buyer's own transaction fulfils the charge; the platform has nothing to send. */
  async fulfill(chargeId: string): Promise<Charge> {
    return this.confirm(chargeId);
  }

  async reconcile(now: Date): Promise<{ advanced: number }> {
    let advanced = 0;
    for (const row of await openCharges(this.id, ["created", "pending_payment"])) {
      try {
        const after = await this.check(row);
        if (after.status !== row.status) {
          advanced++;
          continue;
        }
        const exp = expiresAtOf(row);
        if (exp && exp.getTime() < now.getTime() && (await transition(row.id, ["created", "pending_payment"], "expired"))) advanced++;
      } catch (e) {
        console.error(`[payments] reconcile ${row.id} failed:`, (e as Error).message);
      }
    }
    return { advanced };
  }
}
