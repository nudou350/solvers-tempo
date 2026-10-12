import {
  buyCreditsForCalls,
  createEscrowForCalls,
  decodeSolversError,
  purchaseLicenseForCalls,
  type Call,
} from "@solvers/chain";
import { PURCHASE_KIND, agentIdToBytes32 } from "@solvers/shared";
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, type Hex } from "viem";

import { chainContext } from "../chain/index.js";
import { sendServerCalls, sentTxsFor } from "../chain/lanes.js";
import { alertAdmin } from "./alerts.js";
import { entriesPaused, readAgent, readPurchaseRef, refMatches, saleFromLogs, type SaleDetails } from "./chain.js";
import { intentOfRow } from "./intent.js";
import { loadCharge, patchCharge, payloadOf, transition, type LedgerRow, type ProviderPayload } from "./ledger.js";
import { CHAIN_FULFILS, FLOAT_ERRORS, UNFULFILLABLE_ERRORS, decodePurchaseRef, encodePurchaseRef, fulfilVerdict, shouldGiveUp } from "./lifecycle.js";

// Fulfilment from the PLATFORM float (plan §5, D10, D4): `purchaseLicenseFor / buyCreditsFor / createEscrowFor(buyer, …,
// purchaseId)` in one sponsored batch `[approve(exact amount), *For]` on nonce lane 1. Guarantees:
// - one transaction per charge: only the caller that wins `confirmed -> fulfilling` sends; before sending it checks
//   `purchaseRef(PLATFORM, purchaseId)` and the `sent_txs` journal, so a resumed charge never sends a second purchase;
// - the hash is journaled in `sent_txs` (kind `<provider>-fulfil`, ref = chargeId) before broadcast and copied to the
//   ledger once the receipt is in;
// - the contract rejects a reused purchase id (`DuplicatePurchase`), so even a bug here could not buy twice.

/** Charges whose fulfilment is running in this process (the reconcile job skips them). */
const inFlight = new Set<string>();

/** A `fulfilling` row older than this with no pending transaction is resumed by the reconcile job. */
export const STALE_FULFILLING_MS = 120_000;

export const fulfilKind = (provider: string) => `${provider}-fulfil`;

/** Refund callback of the provider that owns the charge. */
export type RefundFn = (row: LedgerRow, reason: string) => Promise<LedgerRow>;

export function callsFor(row: LedgerRow, price: bigint): Call[] {
  const d = chainContext().deployment;
  const intent = intentOfRow(row);
  const purchaseId = row.purchaseId as Hex;
  const agentId = agentIdToBytes32(row.agentId);
  const buyer = row.buyerWallet as Hex;
  if (intent.kind === "license") return purchaseLicenseForCalls(d, { buyer, agentId, price, purchaseId });
  if (intent.kind === "credits") return buyCreditsForCalls(d, { buyer, agentId, amount: intent.amount, maxTotal: intent.maxTotal, purchaseId });
  return createEscrowForCalls(d, {
    buyer,
    agentId,
    milestones: intent.milestones,
    reviewWindowSecs: intent.reviewWindowSecs,
    deliveryDays: intent.deliveryDays,
    purchaseId,
  });
}

/** Admin alert sink; the indexer passes one that runs after its transaction commits. */
export type AlertFn = (key: string, text: string) => Promise<unknown>;

/** Payload of a sale: the escrow id of a guarantee (fillEscrowTexts joins the escrow to its ledger row on it). */
function salePayload(ref: bigint): ProviderPayload | undefined {
  const { kind, value } = decodePurchaseRef(ref);
  return kind === PURCHASE_KIND.Escrow ? { escrowId: value.toString() } : undefined;
}

/** Records the on-chain sale on the ledger (any open status becomes `fulfilled`; a refunded charge raises an alert). */
export async function applySale(row: LedgerRow, sale: SaleDetails, o: { alert?: AlertFn } = {}): Promise<LedgerRow> {
  const alert = o.alert ?? alertAdmin;
  const now = new Date();
  const payload = salePayload(sale.ref);
  const cols = {
    ...(payload ? { payload } : {}),
    txHash: sale.txHash.toLowerCase(),
    logIndex: sale.logIndex,
    ref: encodePurchaseRef(Number(sale.ref >> 248n), sale.ref & ((1n << 248n) - 1n)),
    ...(sale.gross !== null ? { gross: sale.gross } : {}),
    ...(sale.fee !== null ? { fee: sale.fee } : {}),
    ...(sale.creatorAmount !== null ? { creatorAmount: sale.creatorAmount } : {}),
    ...(sale.creatorDeferred !== null ? { creatorDeferred: sale.creatorDeferred } : {}),
  };
  const moved = await transition(row.id, CHAIN_FULFILS, "fulfilled", {
    ...cols,
    error: null,
    fulfilledAt: now,
    confirmedAt: row.confirmedAt ?? now,
  });
  if (moved) return moved;
  const current = (await loadCharge(row.id))!;
  if (current.status === "fulfilled") {
    // Replay, or the reconcile path got there first: the sale's own hash wins over a missing one or over the provisional
    // pre-broadcast hash of an attempt that expired.
    if (current.txHash !== cols.txHash || (payload && payloadOf(current).escrowId !== payload.escrowId)) return (await patchCharge(row.id, cols))!;
    return current;
  }
  await alert(
    `sale-after-${current.status}:${row.id}`,
    `charge ${row.id} is ${current.status} but the chain shows its sale (tx ${sale.txHash}). Check it manually.`,
  );
  return (await patchCharge(row.id, { error: `sale seen on-chain while ${current.status}: ${sale.txHash}` }))!;
}

/** The chain already holds this charge's sale (found via `purchaseRef`): mark it fulfilled, or failed if the ref is foreign. */
export async function finishFromRef(row: LedgerRow, ref: bigint): Promise<LedgerRow> {
  if (!(await refMatches(row, ref))) {
    await alertAdmin(`ref-mismatch:${row.id}`, `charge ${row.id}: purchaseRef ${ref.toString(16)} does not match its buyer/agent.`);
    return (await transition(row.id, CHAIN_FULFILS, "failed", { error: "purchase_ref_mismatch" })) ?? (await loadCharge(row.id))!;
  }
  // The tx hash comes from the journal (platform sends) or later from the indexer (SaleAuthorized handler).
  // Any journaled send may be the one that landed (a lost receipt leaves its row `pending`).
  const journal = await sentTxsFor(fulfilKind(row.provider), row.id);
  for (const sent of journal.filter((j) => j.status === "confirmed" || j.status === "pending")) {
    const receipt = await chainContext()
      .publicClient.getTransactionReceipt({ hash: sent.txHash as Hex })
      .catch(() => null);
    const sale = receipt?.status === "success" ? saleFromLogs(receipt.logs, row.purchaseId, row.payerWallet) : null;
    if (sale) return applySale(row, sale);
  }
  const now = new Date();
  const payload = salePayload(ref);
  return (
    (await transition(row.id, CHAIN_FULFILS, "fulfilled", {
      ...(payload ? { payload } : {}),
      ref: `0x${ref.toString(16).padStart(64, "0")}`,
      error: null,
      fulfilledAt: now,
      confirmedAt: row.confirmedAt ?? now,
    })) ?? (await loadCharge(row.id))!
  );
}

/** Pending fulfilment transactions of a charge that may still land (not yet past `validBefore`). */
async function pendingSends(row: LedgerRow, now = Date.now()): Promise<number> {
  const journal = await sentTxsFor(fulfilKind(row.provider), row.id);
  let pending = 0;
  for (const j of journal) {
    if (j.status !== "pending") continue;
    const receipt = await chainContext()
      .publicClient.getTransactionReceipt({ hash: j.txHash as Hex })
      .catch(() => null);
    if (receipt) continue; // mined: purchaseRef tells the outcome
    if (!j.validBefore || j.validBefore.getTime() + 5_000 > now) pending++;
  }
  return pending;
}

type FulfilOptions = { refund: RefundFn; now?: () => Date };

/**
 * Sends the purchase for a `confirmed` charge from the float. Idempotent and safe to call concurrently: returns the
 * current row when another caller holds the charge or it is already settled.
 */
export async function fulfilFromFloat(chargeId: string, o: FulfilOptions): Promise<LedgerRow> {
  const claimed = await transition(chargeId, ["confirmed"], "fulfilling");
  if (!claimed) return (await loadCharge(chargeId))!;
  inFlight.add(chargeId);
  try {
    return await sendFulfilment(claimed, o);
  } finally {
    inFlight.delete(chargeId);
  }
}

async function sendFulfilment(row: LedgerRow, o: FulfilOptions): Promise<LedgerRow> {
  const c = chainContext();
  const platform = c.accounts.platform.address;
  const existing = await readPurchaseRef(platform, row.purchaseId);
  if (existing !== 0n) return finishFromRef(row, existing);

  const agent = await readAgent(row.agentId);
  const intent = intentOfRow(row);
  const verdict = agent
    ? fulfilVerdict({
        kind: intent.kind,
        charged: row.tokenAmount,
        ...(intent.kind === "credits" ? { creditsAmount: intent.amount } : {}),
        agent,
        entriesPaused: await entriesPaused(),
      })
    : ({ action: "refund", reason: "agent_unavailable" } as const);
  if (verdict.action === "refund") return o.refund(row, verdict.reason);
  if (verdict.action === "wait") {
    return (await transition(row.id, ["fulfilling"], "confirmed", { error: verdict.reason }))!;
  }
  const priceDelta = row.tokenAmount - verdict.price;
  try {
    const res = await sendServerCalls({
      signer: "platform",
      lane: "platform",
      calls: callsFor(row, verdict.price),
      kind: fulfilKind(row.provider),
      ref: row.id,
      // Plan §5: the fulfilment hash is on the ledger before broadcast (the sale event later sets the final one).
      onSigned: async (hash) => {
        await patchCharge(row.id, { txHash: hash });
      },
    });
    const sale = saleFromLogs(res.receipt.logs, row.purchaseId, platform);
    if (!sale) {
      // A successful purchase always emits SaleAuthorized; fall back to the chain state.
      const ref = await readPurchaseRef(platform, row.purchaseId);
      if (ref !== 0n) return finishFromRef(row, ref);
      throw new Error(`fulfilment ${res.hash} has no SaleAuthorized for ${row.purchaseId}`);
    }
    if (priceDelta > 0n && intent.kind !== "escrow") await patchCharge(row.id, { payload: { priceDelta: priceDelta.toString() } });
    const done = await applySale(row, sale);
    await indexNow(res.hash);
    return done;
  } catch (e) {
    return handleSendError(row, e, o);
  }
}

/**
 * D9: the server indexes its own transactions at once, so the buyer's license (owner, mirrors) is visible as soon as the
 * charge reads "fulfilled". Idempotent with the poller; a failure only delays the mirror until the next poll.
 * Imported lazily: the indexer imports the payments hook.
 */
async function indexNow(hash: `0x${string}`): Promise<void> {
  try {
    const { processTxHash } = await import("../indexer/index.js");
    await processTxHash(hash);
  } catch (e) {
    console.warn(`[payments] indexing ${hash} right after fulfilment failed (the poller will catch up):`, (e as Error).message);
  }
}

async function handleSendError(row: LedgerRow, e: unknown, o: FulfilOptions): Promise<LedgerRow> {
  const err = decodeSolversError(e);
  const platform = chainContext().accounts.platform.address;
  if (err.name === "DuplicatePurchase") {
    const ref = await readPurchaseRef(platform, row.purchaseId);
    if (ref !== 0n) return finishFromRef(row, ref);
  }
  if (UNFULFILLABLE_ERRORS.has(err.name)) return o.refund(row, err.name);
  // Mined late or still in flight: keep `fulfilling`; the reconcile job settles it from the journal / purchaseRef.
  if ((await pendingSends(row)) > 0) {
    return (await patchCharge(row.id, { error: `awaiting receipt: ${(e as Error).message}`.slice(0, 500) }))!;
  }
  const ref = await readPurchaseRef(platform, row.purchaseId).catch(() => 0n);
  if (ref !== 0n) return finishFromRef(row, ref);
  const isFloat = FLOAT_ERRORS.has(err.name);
  if (isFloat) {
    await alertAdmin("float-empty", `the PLATFORM float cannot pay charge ${row.id} (${err.name}). Top it up.`);
  }
  const message = err.name !== "Unknown" ? err.name : ((e as Error).message ?? "send failed");
  console.error(`[payments] fulfilment of ${row.id} failed:`, message);
  // An on-chain refusal that is neither a known unfulfillable error nor an empty float (an unknown deterministic revert)
  // counts as an attempt; transport errors do not. Too many attempts, or paid too long ago: alert and refund.
  const attempts = (Number(payloadOf(row).fulfilAttempts) || 0) + (!isFloat && err.name !== "Paused" && isChainRevert(e) ? 1 : 0);
  if (shouldGiveUp({ attempts, paidAt: row.confirmedAt, now: new Date() })) {
    await alertAdmin(
      `fulfil-gave-up:${row.id}`,
      `charge ${row.id} could not be fulfilled (${message.slice(0, 200)}; ${attempts} on-chain refusals since ${row.confirmedAt?.toISOString() ?? "?"}). Refunding the buyer.`,
    );
    return o.refund(row, `unfulfillable:${err.name}`.slice(0, 100));
  }
  return (
    (await transition(row.id, ["fulfilling"], "confirmed", { error: message.slice(0, 500), payload: { fulfilAttempts: attempts } })) ??
    (await loadCharge(row.id))!
  );
}

/** The chain refused the transaction (a revert at simulation or a mined revert), as opposed to a transport failure. */
export function isChainRevert(e: unknown): boolean {
  if (decodeSolversError(e).name !== "Unknown") return true;
  if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ExecutionRevertedError)) return true;
  return /\breverted\b/i.test((e as Error)?.message ?? "");
}

/**
 * Resumes a `fulfilling` charge after a crash or a lost receipt (reconcile job): the chain decides. Sale on-chain ->
 * fulfilled; a send that may still land -> wait; nothing sent or every send expired -> back to `confirmed` and retry.
 * Never sends while a previous transaction could still be mined.
 */
export async function resumeFulfilling(row: LedgerRow, o: FulfilOptions): Promise<LedgerRow> {
  if (inFlight.has(row.id)) return row;
  const now = (o.now ?? (() => new Date()))().getTime();
  const platform = chainContext().accounts.platform.address;
  const ref = await readPurchaseRef(platform, row.purchaseId);
  if (ref !== 0n) return finishFromRef(row, ref);
  if (now - row.updatedAt.getTime() < STALE_FULFILLING_MS) return row;
  if ((await pendingSends(row, now)) > 0) return row;
  const back = await transition(row.id, ["fulfilling"], "confirmed");
  if (!back) return (await loadCharge(row.id))!;
  return fulfilFromFloat(row.id, o);
}

export function isFulfilling(chargeId: string): boolean {
  return inFlight.has(chargeId);
}
