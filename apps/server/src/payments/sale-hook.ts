import { purchaseKindName, type PurchaseKindName } from "@solvers/shared";
import { keccak256, stringToBytes } from "viem";

import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { mirrorableAgentId } from "../indexer/sync.js";
import { alertAdmin } from "./alerts.js";
import { saleFromEvents, type SaleDetails } from "./chain.js";
import { applySale, type AlertFn } from "./fulfil.js";
import { setSaleAuthorizedHandler, type SaleAuthorizedEvent, type SaleHookResult } from "./hooks.js";
import { loadByPurchaseId } from "./ledger.js";

// `SaleAuthorized` handler (installed with setSaleAuthorizedHandler, called by the indexer in (block, logIndex) order).
// Matches (payer, purchaseId) to the ledger row (ids are scoped by payer, X22) and records the sale (tx hash, log index,
// ref, amounts, `fulfilled`). An id the ledger never issued for that payer (a direct contract call without an intent,
// or another wallet reusing one of our ids) gets a `direct-wallet` row of its own, so the ledger lists every sale.
// Replays are no-ops. No RPC and no network call: amounts come from the sibling events, alerts run after the commit.

function kindName(code: number): PurchaseKindName | null {
  try {
    return purchaseKindName(code);
  } catch {
    return null;
  }
}

/** Ledger id of an unsolicited sale: deterministic per (payer, purchaseId), so a replay finds the same row. */
export function unsolicitedChargeId(payer: string, purchaseId: string): string {
  return `dw_onchain_${keccak256(stringToBytes(`${payer.toLowerCase()}:${purchaseId.toLowerCase()}`)).slice(2, 26)}`;
}

export async function handleSaleAuthorized(e: SaleAuthorizedEvent): Promise<SaleHookResult> {
  const after: (() => Promise<unknown>)[] = [];
  const alert: AlertFn = async (key, text) => {
    after.push(() => alertAdmin(key, text));
  };
  const purchaseId = e.purchaseId.toLowerCase();
  const payer = e.payer.toLowerCase();
  // Amounts come from the sibling event of the same transaction (LicensePurchased / CreditsBought / EscrowCreated).
  const details = saleFromEvents(e.siblings, purchaseId, payer);
  const sale: SaleDetails = details ?? {
    purchaseId: e.purchaseId,
    agentId: e.agentId,
    buyer: e.buyer.toLowerCase() as `0x${string}`,
    payer: payer as `0x${string}`,
    kind: e.kind,
    ref: (BigInt(e.kind) << 248n) | BigInt(e.ref),
    txHash: e.txHash,
    logIndex: e.logIndex,
    gross: null,
    fee: null,
    creatorAmount: null,
    creatorDeferred: null,
  };
  const row = await loadByPurchaseId(payer, purchaseId);
  if (row) {
    await applySale(row, sale, { alert });
    return { after };
  }
  // Unsolicited: only sales the ledger can describe. A non-package agent id or an unknown kind is logged and skipped,
  // never thrown (that would block the other mirrors of the same transaction).
  const kind = kindName(e.kind);
  const agentId = mirrorableAgentId(e.agentId);
  if (!kind || !agentId) {
    console.warn(`[payments] SaleAuthorized ${purchaseId} (tx ${e.txHash}): kind ${e.kind}, agent ${e.agentId} not recorded on the ledger`);
    return { after };
  }
  await db
    .insert(schema.paymentLedger)
    .values({
      id: unsolicitedChargeId(payer, purchaseId),
      provider: "direct-wallet",
      purchaseId,
      kind,
      buyerWallet: e.buyer.toLowerCase(),
      payerWallet: payer,
      agentId,
      intent: { unsolicited: true },
      tokenAddress: env.PAYMENT_TOKEN,
      tokenAmount: sale.gross ?? 0n,
      status: "pending_payment",
      providerPayload: { unsolicited: true, ...(details ? {} : { amountUnknown: true }) },
    })
    .onConflictDoNothing();
  // Inserted now or by a concurrent delivery: apply to that row (idempotent).
  const inserted = await loadByPurchaseId(payer, purchaseId);
  if (inserted) await applySale(inserted, sale, { alert });
  return { after };
}

let installed = false;

export function installSaleHook(): void {
  if (installed) return;
  setSaleAuthorizedHandler(handleSaleAuthorized);
  installed = true;
}
