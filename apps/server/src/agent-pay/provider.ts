import type { ChargeIntent, ChargeStatus, ProviderCapabilities } from "@solvers/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { TransactionReceiptNotFoundError, decodeFunctionData, encodeFunctionData, erc20Abi, parseEventLogs, type Hex } from "viem";
import { Abis } from "viem/tempo";

import { chainContext } from "../chain/index.js";
import { sendServerCalls, sentTxsFor } from "../chain/lanes.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { alertAdmin } from "../payments/alerts.js";
import {
  appendToPayload,
  claimStep,
  expiresAtOf,
  loadCharge,
  patchCharge,
  patchWhere,
  payloadOf,
  transition,
  type LedgerRow,
  type ProviderPayload,
} from "../payments/ledger.js";
import { PlatformProvider, STALE_REFUNDING_MS, type CreateContext, type PaymentState, type StartedPayment } from "../payments/platform-provider.js";
import { getLogsSplitting } from "../indexer/retry-policy.js";
import { ORDER_EXPIRY_GRACE_MS, SETTLING_LOCK_MS, UNKNOWN_BUYER, challengeNonce, memoBoundTo, memoNonce, scanWindowStart } from "./rules.js";

// agent-pay (decisions.md D4): AI agents buy a license over HTTP 402 with the Machine Payments Protocol (`mppx`, `tempo`
// method, `charge` intent, pull mode: the agent signs a TIP-20 transfer, the server co-signs the fee with the RELAY key
// and broadcasts). Then the same fulfilment as Pix: `purchaseLicenseFor(agent wallet)` from the PLATFORM float.
//
// Settlement recipient: the PLATFORM float, not the treasury (decisions.md X24). The fulfilment spends exactly the
// settled amount from the float seconds later, so the net float movement of a fulfilled purchase is zero and the
// treasury still gets the platform fee through the contract split.
//
// One payment per order. mppx's replay protection only covers transaction hashes and its challenges are stateless, so
// the order itself is the lock:
// - before anything is broadcast the route claims the order for the paying wallet (`claimOrder`: a conditional UPDATE on
//   `pending_payment`, an unbound or same buyer and no live `settling` marker), so a retry with a new transaction while
//   the first is in flight, or a second wallet, is refused;
// - `markSettled` binds the first settlement to the order in one conditional UPDATE; any other settlement bound to one
//   of the order's challenges (another transaction, another payer, a payment after the order closed) is recorded under
//   `payload.duplicates[hash]`, the admins are alerted and it is sent back to its payer, once (journal kind
//   `agent-pay-duplicate-refund`, ref = the settlement hash);
// - the reconcile job scans the float's incoming memo transfers once per tick for every recent order and feeds each
//   match to `markSettled` (a lost success hook, a client that paid and vanished, a duplicate).
// The license always goes to the wallet that paid (the TIP-20 `from`), never to an address sent by the client.

export const SETTLEMENT_REFUND_KIND = "agent-pay-refund";
export const DUPLICATE_REFUND_KIND = "agent-pay-duplicate-refund";

const ALL_STATUSES: readonly ChargeStatus[] = [
  "created",
  "pending_payment",
  "confirmed",
  "fulfilling",
  "fulfilled",
  "refunding",
  "refunded",
  "expired",
  "failed",
];
const UNPAID: readonly ChargeStatus[] = ["created", "pending_payment", "expired"];

export type Tip20Transfer = { from: string; to: string; amount: bigint; memo: string | null; txHash: Hex };

/** A second settlement of an order, given back to its payer. */
export type DuplicateSettlement = { from: string; amount: string; seenAt: string; refundTx: string | null };

function tip20Transfers(logs: readonly { address: string }[], token: string): Tip20Transfer[] {
  const out: Tip20Transfer[] = [];
  const parsed = parseEventLogs({ abi: Abis.tip20, logs: logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()) as never, strict: false });
  for (const e of parsed as unknown as { eventName: string; args: Record<string, unknown>; transactionHash: Hex }[]) {
    if (e.eventName !== "Transfer" && e.eventName !== "TransferWithMemo") continue;
    const a = e.args;
    out.push({
      from: String(a.from).toLowerCase(),
      to: String(a.to).toLowerCase(),
      amount: BigInt((a.amount ?? a.value) as bigint),
      memo: e.eventName === "TransferWithMemo" ? String(a.memo) : null,
      txHash: e.transactionHash,
    });
  }
  return out;
}

/** A TIP-20 `transfer` / `transferWithMemo` call of `token`, decoded; null for anything else. */
export function decodeTransferCall(call: { to?: string | null; data?: string | null }, token: string): { to: string; amount: bigint; memo: string | null } | null {
  if (!call.to || !call.data || call.to.toLowerCase() !== token.toLowerCase()) return null;
  try {
    const d = decodeFunctionData({ abi: Abis.tip20, data: call.data as Hex }) as { functionName: string; args: readonly unknown[] };
    if (d.functionName === "transfer") return { to: String(d.args[0]).toLowerCase(), amount: BigInt(d.args[1] as bigint), memo: null };
    if (d.functionName === "transferWithMemo") return { to: String(d.args[0]).toLowerCase(), amount: BigInt(d.args[1] as bigint), memo: String(d.args[2]) };
  } catch {
    return null;
  }
  return null;
}

const duplicatesOf = (row: LedgerRow) => (payloadOf(row).duplicates ?? {}) as Record<string, DuplicateSettlement>;
const challengeIdsOf = (row: LedgerRow) => (payloadOf(row).challengeIds as string[] | undefined) ?? [];

export class AgentPayProvider extends PlatformProvider {
  readonly id = "agent-pay" as const;
  protected readonly prefix = "ap";
  /** Duplicate refunds being sent by this process. */
  private readonly duplicateInFlight = new Set<string>();

  override capabilities(): ProviderCapabilities {
    return { kinds: ["license"], settlement: "platform-onchain", refundable: true };
  }

  protected ttlMs(): number {
    return env.AGENT_PAY_ORDER_TTL_SECS * 1000;
  }

  /**
   * Opens an order for a license before the payer is known (`intent.buyer` is ignored). The challenge description is
   * stored with the order: mppx binds it into every challenge, so it must not change if the Solver is renamed meanwhile.
   */
  async openOrder(input: { agentId: string; price: bigint; ip: string | null; description?: string; now?: Date }): Promise<LedgerRow> {
    const intent: ChargeIntent = { kind: "license", agentId: input.agentId, buyer: UNKNOWN_BUYER, expectedPrice: input.price };
    const charge = await this.createCharge(intent, { now: input.now ?? new Date(), ip: input.ip });
    if (input.description) return (await patchCharge(charge.id, { payload: { description: input.description.slice(0, 200) } }))!;
    return (await loadCharge(charge.id))!;
  }

  protected async startPayment(_row: LedgerRow, _intent: ChargeIntent, _ctx: CreateContext): Promise<StartedPayment> {
    const fromBlock = await chainContext().publicClient.getBlockNumber();
    return { payload: { mode: "mpp", fromBlock: fromBlock.toString() } };
  }

  /** Every challenge issued for the order (its memo binds the payment); the first one is the provider charge id. */
  async recordChallenge(chargeId: string, challengeId: string): Promise<void> {
    await appendToPayload(chargeId, "challengeIds", challengeId);
    const row = await loadCharge(chargeId);
    if (row && !row.providerChargeId) await patchCharge(chargeId, { providerChargeId: challengeId });
  }

  /**
   * Claims an unpaid order for `payer` before its payment is broadcast: succeeds only while the order is
   * `pending_payment`, unbound or bound to the same wallet, not settled, and no other credential holds a live
   * `settling` marker. Returns the claimed row, or null (the caller re-reads to tell why).
   */
  async claimOrder(row: LedgerRow, payer: string, challengeId: string, now = new Date()): Promise<LedgerRow | null> {
    const p = payer.toLowerCase();
    const pp = schema.paymentLedger.providerPayload;
    const staleBefore = new Date(now.getTime() - SETTLING_LOCK_MS).toISOString();
    return patchWhere(
      row.id,
      ["pending_payment"],
      sql`(${schema.paymentLedger.buyerWallet} = ${UNKNOWN_BUYER} or ${schema.paymentLedger.buyerWallet} = ${p})
        and (${pp} ->> 'settlementTx') is null
        and ((${pp} -> 'settling') is null or (${pp} -> 'settling' ->> 'at')::timestamptz < ${staleBefore}::timestamptz)`,
      { buyerWallet: p, payload: { settling: { challengeId, payer: p, at: now.toISOString() } } },
    );
  }

  /**
   * Records a settlement transaction (a transfer of exactly the order amount to the float). The first one confirms the
   * order and binds it to its payer; any other one is a duplicate and is refunded. Idempotent per transaction hash;
   * called from mppx's success hook and from the settlement scan.
   */
  async markSettled(chargeId: string, txHash: string): Promise<LedgerRow> {
    const hash = txHash.toLowerCase();
    let row = (await loadCharge(chargeId))!;
    if (payloadOf(row).settlementTx === hash) return row;
    if (duplicatesOf(row)[hash]) return this.refundDuplicate(chargeId, hash);
    const c = chainContext();
    const receipt = await c.publicClient.getTransactionReceipt({ hash: hash as Hex });
    if (receipt.status !== "success") throw new Error(`settlement ${hash} reverted`);
    const platform = c.accounts.platform.address.toLowerCase();
    const paying = tip20Transfers(receipt.logs, env.PAYMENT_TOKEN).filter((x) => x.to === platform && x.amount === row.tokenAmount);
    const ids = challengeIdsOf(row);
    const t = paying.find((x) => x.memo && ids.some((id) => memoBoundTo(x.memo!, id))) ?? paying[0];
    if (!t) throw new Error(`settlement ${hash} does not pay order ${chargeId}`);

    if (UNPAID.includes(row.status as ChargeStatus) && !payloadOf(row).settlementTx) {
      const pp = schema.paymentLedger.providerPayload;
      const bound = await transition(
        chargeId,
        UNPAID,
        "confirmed",
        { buyerWallet: t.from, confirmedAt: new Date(), error: null, payload: { settlementTx: hash } },
        sql`(${pp} ->> 'settlementTx') is null and (${schema.paymentLedger.buyerWallet} = ${UNKNOWN_BUYER} or ${schema.paymentLedger.buyerWallet} = ${t.from})`,
      );
      if (bound) return bound;
      row = (await loadCharge(chargeId))!;
      if (payloadOf(row).settlementTx === hash) return row;
    }
    return this.recordDuplicate(row, t, hash);
  }

  /** A settlement other than the order's own: record it on the order, alert the admins and send it back. */
  private async recordDuplicate(row: LedgerRow, t: Tip20Transfer, hash: string): Promise<LedgerRow> {
    const entry: DuplicateSettlement = { from: t.from, amount: t.amount.toString(), seenAt: new Date().toISOString(), refundTx: null };
    const pp = schema.paymentLedger.providerPayload;
    // One UPDATE adds the key only if absent, so concurrent callers (hook and scan) record it once and keep other keys.
    const [recorded] = await db
      .update(schema.paymentLedger)
      .set({
        providerPayload: sql`jsonb_set(coalesce(${pp}, '{}'::jsonb), '{duplicates}',
          coalesce(${pp} -> 'duplicates', '{}'::jsonb) || jsonb_build_object(${hash}::text, ${JSON.stringify(entry)}::jsonb))`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.paymentLedger.id, row.id), sql`not (coalesce(${pp} -> 'duplicates', '{}'::jsonb) ? ${hash})`))
      .returning({ id: schema.paymentLedger.id });
    if (recorded) {
      await alertAdmin(
        `agent-pay-duplicate:${hash}`,
        `order ${row.id} (${row.status}) received a second payment ${hash} of ${t.amount} units from ${t.from}; it is being refunded.`,
      );
    }
    return this.refundDuplicate(row.id, hash);
  }

  /** Sends a duplicate settlement back to its payer, once (claim per hash + journal keyed by the settlement hash). */
  async refundDuplicate(chargeId: string, hash: string): Promise<LedgerRow> {
    const row = (await loadCharge(chargeId))!;
    const d = duplicatesOf(row)[hash];
    if (!d || d.refundTx) return row;
    const claimed = await claimStep(chargeId, ALL_STATUSES, `duplicateClaimedAt:${hash}`, STALE_REFUNDING_MS);
    if (!claimed) return (await loadCharge(chargeId))!;
    this.duplicateInFlight.add(chargeId);
    try {
      const refundTx = await this.sendTransferOnce(DUPLICATE_REFUND_KIND, hash, d.from, BigInt(d.amount));
      const pp = schema.paymentLedger.providerPayload;
      const [updated] = await db
        .update(schema.paymentLedger)
        .set({
          providerPayload: sql`jsonb_set(${pp}, ${`{duplicates,${hash},refundTx}`}::text[], to_jsonb(${refundTx}::text))`,
          updatedAt: new Date(),
        })
        .where(eq(schema.paymentLedger.id, chargeId))
        .returning();
      return updated!;
    } finally {
      this.duplicateInFlight.delete(chargeId);
    }
  }

  /**
   * Sends `amount` of the payment token from the float to `to`, at most once per (kind, ref). Every journaled attempt is
   * checked on-chain first: a mined success is the refund; a reverted one moved nothing; one that is not mined yet and
   * still inside its validity window (whatever its journal status, `failed` included) may still land, so nothing is sent.
   */
  private async sendTransferOnce(kind: string, ref: string, to: string, amount: bigint): Promise<string> {
    const pc = chainContext().publicClient;
    for (const j of await sentTxsFor(kind, ref)) {
      let receipt: Awaited<ReturnType<typeof pc.getTransactionReceipt>> | null = null;
      try {
        receipt = await pc.getTransactionReceipt({ hash: j.txHash as Hex });
      } catch (e) {
        // Not found = not mined (yet). Anything else is RPC trouble: decide later, never send blind. (Matched by name:
        // the chain package may load its own copy of viem.)
        if (!(e instanceof TransactionReceiptNotFoundError) && (e as Error)?.name !== "TransactionReceiptNotFoundError") throw e;
      }
      if (receipt?.status === "success") return j.txHash;
      if (receipt) continue;
      if (j.status === "confirmed") return j.txHash;
      if (!j.validBefore || j.validBefore.getTime() + 5_000 > Date.now()) throw new Error(`${kind} ${ref} still in flight (${j.txHash})`);
    }
    const res = await sendServerCalls({
      signer: "platform",
      lane: "platform",
      calls: [{ to: env.PAYMENT_TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Hex, amount] }) }],
      kind,
      ref,
    });
    return res.hash;
  }

  /**
   * Incoming memo transfers to the float bound to a challenge of one of `rows`, scanned once from the oldest order's
   * block. Transfers of the bound payer come first, so the order's own settlement is recorded before any duplicate.
   */
  async findSettlements(rows: readonly LedgerRow[]): Promise<{ row: LedgerRow; transfer: Tip20Transfer }[]> {
    const byNonce = new Map<string, LedgerRow>();
    let fromBlock: bigint | null = null;
    for (const r of rows) {
      const p = payloadOf(r);
      if (p.fromBlock === undefined) continue;
      for (const id of challengeIdsOf(r)) byNonce.set(challengeNonce(id), r);
      const b = BigInt(p.fromBlock as string);
      if (challengeIdsOf(r).length && (fromBlock === null || b < fromBlock)) fromBlock = b;
    }
    if (fromBlock === null || byNonce.size === 0) return [];
    const c = chainContext();
    const event = Abis.tip20.find((x) => x.type === "event" && x.name === "TransferWithMemo");
    if (!event) return [];
    const latest = await c.publicClient.getBlockNumber({ cacheTime: 0 });
    const step = BigInt(env.INDEXER_BLOCK_BATCH);
    const found: { row: LedgerRow; transfer: Tip20Transfer }[] = [];
    for (let from = fromBlock; from <= latest; from += step) {
      const to = from + step - 1n > latest ? latest : from + step - 1n;
      const logs = await getLogsSplitting(
        (f, t) =>
          c.publicClient.getLogs({
            address: env.PAYMENT_TOKEN,
            event: event as never,
            args: { to: c.accounts.platform.address } as never,
            fromBlock: f,
            toBlock: t,
          }) as Promise<unknown[]>,
        from,
        to,
      );
      for (const t of tip20Transfers(logs as never, env.PAYMENT_TOKEN)) {
        const nonce = t.memo ? memoNonce(t.memo) : null;
        const row = nonce ? byNonce.get(nonce) : undefined;
        if (!row) continue;
        if (t.amount !== row.tokenAmount) {
          console.warn(`[agent-pay] transfer ${t.txHash} bound to order ${row.id} pays ${t.amount}, not ${row.tokenAmount}: left for the admin`);
          continue;
        }
        found.push({ row, transfer: t });
      }
    }
    const rank = (x: { row: LedgerRow; transfer: Tip20Transfer }) => (x.transfer.from === x.row.buyerWallet ? 0 : 1);
    return found.sort((a, b) => rank(a) - rank(b));
  }

  /** The settlement of one order found on-chain (its bound payer's first), or null. */
  async recoverSettlement(row: LedgerRow): Promise<string | null> {
    const found = await this.findSettlements([row]);
    return found[0]?.transfer.txHash ?? null;
  }

  /** Feeds every settlement of `rows` found on-chain to `markSettled` (the first binds, the others are refunded). */
  async scanSettlements(rows: readonly LedgerRow[]): Promise<number> {
    let n = 0;
    for (const { row, transfer } of await this.findSettlements(rows)) {
      try {
        const before = (await loadCharge(row.id))!;
        if (payloadOf(before).settlementTx === transfer.txHash.toLowerCase() || duplicatesOf(before)[transfer.txHash.toLowerCase()]?.refundTx) continue;
        await this.markSettled(row.id, transfer.txHash);
        n++;
      } catch (e) {
        console.error(`[agent-pay] settlement ${transfer.txHash} of ${row.id}:`, (e as Error).message);
      }
    }
    return n;
  }

  /** Orders recent enough that a payment for them may still arrive (bounded scan of the reconcile job). */
  private async scanCandidates(now: Date): Promise<LedgerRow[]> {
    const rows = await db
      .select()
      .from(schema.paymentLedger)
      .where(and(eq(schema.paymentLedger.provider, this.id), gt(schema.paymentLedger.createdAt, scanWindowStart(now, this.ttlMs()))));
    return rows.filter((r) => challengeIdsOf(r).length > 0);
  }

  /** One settlement scan for all recent orders, then the usual lifecycle, then pending duplicate refunds. */
  override async reconcile(now: Date): Promise<{ advanced: number }> {
    try {
      await this.scanSettlements(await this.scanCandidates(now));
    } catch (e) {
      console.error("[agent-pay] settlement scan failed:", (e as Error).message);
    }
    const res = await super.reconcile(now);
    const pp = schema.paymentLedger.providerPayload;
    const withDuplicates = await db
      .select()
      .from(schema.paymentLedger)
      .where(and(eq(schema.paymentLedger.provider, this.id), sql`(${pp} -> 'duplicates') is not null`));
    for (const row of withDuplicates) {
      if (this.duplicateInFlight.has(row.id) || now.getTime() - row.updatedAt.getTime() < STALE_REFUNDING_MS) continue;
      for (const [hash, d] of Object.entries(duplicatesOf(row))) {
        if (d.refundTx) continue;
        await this.refundDuplicate(row.id, hash).catch((e) => console.error(`[agent-pay] duplicate refund ${hash}:`, (e as Error).message));
      }
    }
    return res;
  }

  /** A client polling an order whose success hook was lost: look for its settlement on-chain first. */
  override async confirm(chargeId: string) {
    const row = await this.load(chargeId);
    if (UNPAID.includes(row.status as ChargeStatus) && !payloadOf(row).settlementTx) await this.scanSettlements([row]);
    return super.confirm(chargeId);
  }

  protected override expiresLocally(): boolean {
    return false;
  }

  /** From the ledger only: settlements are found by the scan (`reconcile`, `confirm`) and recorded by `markSettled`. */
  protected async paymentState(row: LedgerRow, now: Date): Promise<PaymentState> {
    if (payloadOf(row).settlementTx) return "paid";
    const exp = expiresAtOf(row);
    return exp && exp.getTime() + ORDER_EXPIRY_GRACE_MS < now.getTime() ? "expired" : "pending";
  }

  /** Sends the settled amount back to the payer from the float (once: the journal guards a retry after a crash). */
  protected async returnPayment(row: LedgerRow, _reason: string): Promise<ProviderPayload> {
    if (row.buyerWallet === UNKNOWN_BUYER || !payloadOf(row).settlementTx) return { refund: "none" };
    const refundTx = await this.sendTransferOnce(SETTLEMENT_REFUND_KIND, row.id, row.buyerWallet, row.tokenAmount);
    return { refund: "onchain", refundTx };
  }

  protected override paymentView(row: LedgerRow): Record<string, unknown> {
    const p = payloadOf(row);
    return { protocol: "mpp", settlementTx: p.settlementTx ?? null, refundTx: p.refundTx ?? null };
  }

  /** Fails an unpaid order (the price moved, the agent sold out...) before any money moved. */
  async abandon(row: LedgerRow, reason: string): Promise<void> {
    await transition(row.id, ["created", "pending_payment"], "failed", { error: reason });
  }
}
