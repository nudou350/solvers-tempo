import type { SolversLog } from "@solvers/chain";
import type { Hex } from "viem";

/**
 * Called by the indexer (src/indexer) for every `SaleAuthorized` event, in (blockNumber, logIndex) order, inside its
 * idempotent processing (a replay must be a no-op). The payments module (src/payments) matches the event to its
 * `payment_ledger` row by (payer, purchaseId) and advances the charge; an unsolicited id creates a `direct-wallet` row
 * (plan §4.8). Owned by the payments module; the indexer only calls it.
 *
 * The handler makes no RPC call and no network call while the indexer's transaction is open: the sale amounts come
 * from `siblings` (every decoded Solvers event of the same transaction, which the indexer already holds), and admin
 * alerts are returned in `after` for the indexer to run once its transaction has committed.
 */
export type SaleAuthorizedEvent = {
  purchaseId: Hex;
  agentId: Hex;
  buyer: Hex;
  payer: Hex;
  kind: number; // 1 License | 2 Credits | 3 Escrow (anything else is logged and skipped)
  ref: Hex;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  /** All Solvers events of the same transaction (LicensePurchased / CreditsBought / EscrowCreated carry the amounts). */
  siblings: readonly SolversLog[];
};

export type SaleHookResult = { after?: (() => Promise<unknown>)[] };

export type OnSaleAuthorized = (e: SaleAuthorizedEvent) => Promise<SaleHookResult | void>;

let handler: OnSaleAuthorized = async () => undefined;

/** The payments module installs its handler at boot (src/payments/index.ts). */
export function setSaleAuthorizedHandler(h: OnSaleAuthorized): void {
  handler = h;
}

export function onSaleAuthorized(e: SaleAuthorizedEvent): Promise<SaleHookResult | void> {
  return handler(e);
}
