import { and, asc, eq, ne, sql } from "drizzle-orm";
import QRCode from "qrcode";
import type { ChargeIntent, SolanaPayCharge, SolanaPayConfig } from "@solvers/shared";

import { explorerUrl } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError } from "../lib/http.js";
import { alertAdmin } from "../payments/alerts.js";
import { appendToPayload, expiresAtOf, loadCharge, patchCharge, payloadOf, type LedgerRow, type ProviderPayload } from "../payments/ledger.js";
import { PlatformProvider, type CreateContext, type PaymentState, type StartedPayment } from "../payments/platform-provider.js";
import {
  MAX_REFUND_ATTEMPTS,
  MAX_REFUND_FAILURES,
  SOLANA_PAY_GRACE_MS,
  SOLANA_PAY_LABEL,
  SOLANA_PAY_LATE_SCAN_PER_TICK,
  SOLANA_PAY_LATE_WINDOW_MS,
  SOLANA_PAY_TOKEN_SYMBOL,
  formatUnits,
  paymentMessage,
  refundOutcome,
  solanaExplorerTxUrl,
  transferRequestUrl,
  validatePayment,
  type PaymentVerdict,
  type RefundOutcome,
  type SolanaClusterName,
} from "./rules.js";
import { newReference, recipientAddress, solanaGateway, type SignedSolanaTx, type SolanaGateway } from "./solana.js";

// solana-pay: the buyer pays ONE purchase in USDC on Solana through a Solana Pay transfer request; the payment is found by
// the charge's own reference key (32 random bytes, stored as providerChargeId), validated from the confirmed transaction
// (success, reference, recipient token account, mint, amount), and the platform buys on Tempo for the buyer from its
// float (`*For(buyer, …, purchaseId)`, payments/fulfil.ts), exactly like Pix. No webhook: the GET route and the reconcile
// job re-read Solana (expired charges too, for SOLANA_PAY_LATE_WINDOW_MS, so a late payment is not lost). When the purchase
// cannot be completed the USDC goes back to the payer automatically (returnPayment) or, when the destination or the keys
// cannot be trusted, the refund is left to an admin (`refund_manual_required`).

export function solanaPayConfig(): SolanaPayConfig {
  return {
    enabled: env.SOLANA_PAY_ENABLED,
    cluster: env.SOLANA_CLUSTER,
    mint: env.SOLANA_PAY_MINT,
    recipient: env.SOLANA_PAY_ENABLED ? recipientAddress() : null,
    tokenSymbol: SOLANA_PAY_TOKEN_SYMBOL,
  };
}

const unavailable = () => new HttpError(503, "Solana Pay is not available on this server.", "solana_pay_unavailable");

/** `error` of a `refunding` charge whose refund an admin must make by hand; the reconcile job leaves it alone. */
export const REFUND_MANUAL_REQUIRED = "refund_manual_required";

/** Payload of a Solana Pay charge (`provider_payload`). */
type SolanaPayload = ProviderPayload & {
  reference?: string;
  recipient?: string;
  mint?: string;
  cluster?: SolanaClusterName;
  decimals?: number;
  url?: string;
  qrBase64?: string;
  /** Payment transaction bound to this charge (one transaction pays at most one charge). */
  solanaSignature?: string;
  payer?: string | null;
  paidUnits?: string;
  /** Refund journal: written BEFORE the broadcast, replaced only once the previous one can no longer land. */
  refundSignature?: string;
  refundBlockhash?: string;
  refundLastValidBlockHeight?: string;
  refundWire?: string;
  /** Slot the journaled refund was signed at, and that of the first refund of the charge (memo scans go back to it). */
  refundSlot?: string;
  refundFirstSlot?: string;
  refundAttempts?: number;
  /** Refund transactions that landed but failed (moved nothing). */
  refundFailures?: number;
  /** Why the refund was left to an admin. */
  refundManual?: string;
  /** Admin alerts already sent for this charge (each once). */
  alerts?: string[];
  /** Last re-scan of an expired charge for a late payment. */
  lateCheckedAt?: string;
};

const sp = (row: LedgerRow) => payloadOf(row) as SolanaPayload;

export type SolanaPayOptions = {
  /** How long one refund call waits for its transaction to confirm before leaving it to the reconcile job. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** New refund transactions one call may send (each only after the previous one expired without landing). */
const MAX_REFUND_SENDS_PER_CALL = 3;

/** The journaled refund may still land: not a failure, the reconcile job checks it again once the claim is stale. */
class RefundPending extends Error {}
/** The refund was left to an admin (already marked and alerted). */
class RefundManual extends Error {}

export class SolanaPayProvider extends PlatformProvider {
  readonly id = "solana-pay" as const;
  protected readonly prefix = "sol";
  private mintChecked: Promise<number> | null = null;

  constructor(
    private readonly gateway: () => SolanaGateway = solanaGateway,
    private readonly opts: SolanaPayOptions = {},
  ) {
    super();
  }

  protected ttlMs(): number {
    return env.SOLANA_PAY_TTL_MIN * 60_000;
  }

  /** The mint's decimals must equal the Tempo token's (6): amounts are copied 1:1 between the chains. Cached once ok. */
  private async checkMint(gw: SolanaGateway): Promise<number> {
    this.mintChecked ??= gw.mintDecimals().then((d) => {
      if (d !== env.PAYMENT_TOKEN_DECIMALS) {
        void alertAdmin("solana-mint-decimals", `SOLANA_PAY_MINT ${gw.mint} has ${d} decimals, PAYMENT_TOKEN_DECIMALS is ${env.PAYMENT_TOKEN_DECIMALS}. Solana Pay is refused.`);
        throw new Error(`SOLANA_PAY_MINT has ${d} decimals, expected ${env.PAYMENT_TOKEN_DECIMALS}`);
      }
      return d;
    });
    try {
      return await this.mintChecked;
    } catch (e) {
      // A transient RPC failure must not stick (a wrong mint fails again on the next call anyway).
      this.mintChecked = null;
      throw e;
    }
  }

  protected async startPayment(row: LedgerRow, intent: ChargeIntent, _ctx: CreateContext): Promise<StartedPayment> {
    if (!env.SOLANA_PAY_ENABLED) throw unavailable();
    const gw = this.gateway();
    const decimals = await this.checkMint(gw).catch((e) => {
      console.error("[solana-pay] mint check failed:", (e as Error).message);
      throw unavailable();
    });
    const recipient = gw.recipient();
    const reference = newReference();
    const url = transferRequestUrl({
      recipient,
      amountUnits: row.tokenAmount,
      decimals,
      mint: gw.mint,
      reference,
      label: SOLANA_PAY_LABEL,
      message: paymentMessage(intent.kind),
      memo: row.id,
    });
    const qr = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 });
    const payload: SolanaPayload = { reference, recipient, mint: gw.mint, cluster: gw.cluster, decimals, url, qrBase64: qr.toString("base64") };
    return { providerChargeId: reference, payload };
  }

  /** A payment can land after our expiry: `paymentState` expires the charge only after the grace period. */
  protected override expiresLocally(): boolean {
    return false;
  }

  protected async paymentState(row: LedgerRow, now: Date): Promise<PaymentState> {
    const p = sp(row);
    const reference = row.providerChargeId;
    if (!reference || !p.recipient || !p.mint) return "failed";
    const gw = this.gateway();
    // The charge's own terms (where the buyer was told to pay), not the current config.
    const expect = { reference, recipient: p.recipient, recipientAta: await gw.ata(p.recipient, p.mint), mint: p.mint, amount: row.tokenAmount };
    const usdc = (units: bigint) => formatUnits(units, p.decimals ?? env.PAYMENT_TOKEN_DECIMALS);

    const seen = await gw.signaturesFor(reference);
    const candidates = seen.filter((s) => !s.failed).map((s) => s.signature);
    // A transaction bound before a crash (bound, but not marked paid yet) is re-validated first.
    if (p.solanaSignature && !candidates.includes(p.solanaSignature)) candidates.unshift(p.solanaSignature);
    let lagging = false;
    for (const signature of candidates) {
      const tx = await gw.transaction(signature);
      if (!tx) {
        // The RPC lists the signature but cannot serve the transaction yet: never expire on that (nor bind another
        // payment over the bound one); check again later.
        if (signature === p.solanaSignature) return "pending";
        lagging = true;
        continue;
      }
      const verdict = validatePayment(tx, expect);
      if (verdict.misdirected > 0n) {
        await this.alertOnce(
          row,
          `misdirected:${signature}`,
          `Solana Pay charge ${row.id}: transaction ${signature} sent ${usdc(verdict.misdirected)} USDC to a token account of the recipient that is not its associated account. Not counted; return it by hand.`,
        );
      }
      if (verdict.status === "underpaid") {
        await this.alertOnce(
          row,
          `underpaid:${signature}`,
          `Solana Pay charge ${row.id}: transaction ${signature} paid ${usdc(verdict.received)} of ${usdc(row.tokenAmount)} USDC (payer ${verdict.payer ?? "?"}). Not accepted; return it by hand.`,
        );
        continue;
      }
      if (verdict.status !== "paid") continue;
      if (!(await this.bindPayment(row.id, signature, verdict))) {
        await this.alertOnce(row, `reused:${signature}`, `Solana transaction ${signature} carries the reference of charge ${row.id} but already paid another charge.`);
        continue;
      }
      if (verdict.received > row.tokenAmount) {
        await this.alertOnce(
          row,
          "overpaid",
          `Solana Pay charge ${row.id} was overpaid by ${usdc(verdict.received - row.tokenAmount)} USDC (transaction ${signature}, payer ${verdict.payer ?? "?"}).`,
        );
      }
      return "paid";
    }
    if (lagging) return "pending";
    const exp = expiresAtOf(row);
    if (exp && exp.getTime() + SOLANA_PAY_GRACE_MS < now.getTime()) return "expired";
    return "pending";
  }

  /** Sends an admin alert about this charge once (recorded in the payload, so a restart does not repeat it). */
  private async alertOnce(row: LedgerRow, key: string, text: string): Promise<void> {
    const sent = sp((await loadCharge(row.id)) ?? row).alerts ?? [];
    if (sent.includes(key)) return;
    await appendToPayload(row.id, "alerts", key);
    await alertAdmin(`solana:${row.id}:${key}`, text, { everyMs: 0 });
  }

  /**
   * Binds a payment transaction to the charge: one Solana transaction pays at most one charge, even if it carried the
   * references of several. Serialised per signature with a transaction-scoped advisory lock.
   */
  private async bindPayment(chargeId: string, signature: string, v: PaymentVerdict): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`solana-pay:${signature}`}))`);
      const p = schema.paymentLedger;
      const [other] = await tx
        .select({ id: p.id })
        .from(p)
        .where(and(eq(p.provider, "solana-pay"), ne(p.id, chargeId), sql`${p.providerPayload} ->> 'solanaSignature' = ${signature}`))
        .limit(1);
      if (other) return false;
      const patch = { solanaSignature: signature, payer: v.payer, paidUnits: v.received.toString() };
      await tx
        .update(p)
        .set({ providerPayload: sql`coalesce(${p.providerPayload}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
        .where(eq(p.id, chargeId));
      return true;
    });
  }

  /** Whether an expired charge is still re-scanned for a late payment. */
  lateScanOpen(row: LedgerRow, now = new Date()): boolean {
    const exp = expiresAtOf(row);
    return row.status === "expired" && exp !== null && now.getTime() - exp.getTime() < SOLANA_PAY_LATE_WINDOW_MS;
  }

  /** The open charges (shared path), then up to SOLANA_PAY_LATE_SCAN_PER_TICK expired ones. */
  override async reconcile(now: Date): Promise<{ advanced: number }> {
    const open = await super.reconcile(now);
    return { advanced: open.advanced + (await this.scanLate(now)) };
  }

  /**
   * Re-scans expired charges, least recently checked first, for a payment that landed after the grace period (one
   * getSignaturesForAddress each when nothing came in). A valid late payment revives the charge (`markPaid` accepts
   * `expired`) and is fulfilled, or refunded when the purchase is no longer possible.
   */
  async scanLate(now: Date): Promise<number> {
    const p = schema.paymentLedger;
    const since = new Date(now.getTime() - SOLANA_PAY_LATE_WINDOW_MS).toISOString();
    const rows = await db
      .select()
      .from(p)
      .where(and(eq(p.provider, "solana-pay"), eq(p.status, "expired"), sql`(${p.providerPayload} ->> 'expiresAt')::timestamptz > ${since}::timestamptz`))
      .orderBy(asc(sql`${p.providerPayload} ->> 'lateCheckedAt'`))
      .limit(SOLANA_PAY_LATE_SCAN_PER_TICK);
    let advanced = 0;
    for (const row of rows) {
      try {
        if ((await this.paymentState(row, now)) === "paid") {
          const paid = await this.markPaid(row);
          console.warn(`[solana-pay] late payment for expired charge ${row.id}: ${paid.status}`);
          if (paid.status === "confirmed") await this.fulfill(row.id);
          advanced++;
        } else {
          await patchCharge(row.id, { payload: { lateCheckedAt: now.toISOString() } });
        }
      } catch (e) {
        console.error(`[solana-pay] late scan of ${row.id} failed:`, (e as Error).message);
      }
    }
    return advanced;
  }

  /** A refund left to an admin is never retried by the reconcile job. */
  protected override async reconcileOne(row: LedgerRow, now: Date): Promise<LedgerRow> {
    if (row.status === "refunding" && row.error === REFUND_MANUAL_REQUIRED) return row;
    return super.reconcileOne(row, now);
  }

  /**
   * Sends the charge's amount back to the payer, exactly once. The signed transaction is journaled in the payload BEFORE
   * the broadcast; a retry (crash, timeout, reconcile) first asks Solana about the journaled one: landed -> done; may
   * still land -> rebroadcast and wait; landed but failed -> a fresh one (at most MAX_REFUND_FAILURES); its blockhash
   * expired without it -> a second look (the transaction itself, then the memo history of the recipient's token account
   * back to the first refund) before a new one is signed. The caller (`sendRefund`) holds the refund claim, so two of
   * these never run at once. The refund is left to an admin (nothing sent) when the destination is not a signer that
   * paid or the keys or mint changed.
   */
  protected async returnPayment(row: LedgerRow, reason: string): Promise<ProviderPayload> {
    try {
      const signature = await this.refundOnce(row, reason);
      await alertAdmin(`solana-refund:${row.id}`, `Solana Pay charge ${row.id} refunded (${reason}): ${signature}.`);
      return { refund: "solana", refundSignature: signature };
    } catch (e) {
      if (e instanceof RefundPending) {
        console.warn(`[solana-pay] ${e.message}`);
        throw e;
      }
      if (e instanceof RefundManual) throw e;
      await alertAdmin(`solana-refund-failed:${row.id}`, `Solana Pay refund of charge ${row.id} (${reason}) is not done yet: ${(e as Error).message.slice(0, 300)}`);
      throw e;
    }
  }

  /** Leaves the refund to an admin: marks the charge (stays `refunding`, never retried) and alerts once. */
  private async manual(row: LedgerRow, why: string, reason: string): Promise<never> {
    const p = sp(row);
    await patchCharge(row.id, { error: REFUND_MANUAL_REQUIRED, payload: { refundManual: why, refundManualReason: reason } });
    await this.alertOnce(
      row,
      "refund-manual",
      `Solana Pay charge ${row.id} (${reason}) needs a MANUAL refund of ${formatUnits(row.tokenAmount, p.decimals ?? env.PAYMENT_TOKEN_DECIMALS)} USDC: ${why}. Payment ${p.solanaSignature ?? "?"}, payer ${p.payer ?? "unknown"}. It is not retried automatically.`,
    );
    throw new RefundManual(`refund of ${row.id} needs an admin: ${why}`);
  }

  private async refundOnce(row: LedgerRow, reason: string): Promise<string> {
    const p = sp(row);
    const gw = this.gateway();
    const payer = p.payer;
    if (!payer) return this.manual(row, "no signer of the payment transaction spent the USDC, so the refund destination is unknown", reason);
    const recipient = gw.recipient();
    if (!p.recipient || p.recipient !== recipient) {
      return this.manual(row, `the payment went to ${p.recipient ?? "?"} but SOLANA_PAY_KEYPAIR is now ${recipient}`, reason);
    }
    if (payer === recipient) return this.manual(row, "the payer is the recipient wallet", reason);
    if (p.mint !== gw.mint) return this.manual(row, `the payment was in ${p.mint ?? "?"} but SOLANA_PAY_MINT is now ${gw.mint}`, reason);
    const decimals = await this.checkMint(gw);

    let journal: SignedSolanaTx | null =
      p.refundSignature && p.refundWire && p.refundLastValidBlockHeight
        ? {
            signature: p.refundSignature,
            wire: p.refundWire,
            blockhash: p.refundBlockhash ?? "",
            lastValidBlockHeight: BigInt(p.refundLastValidBlockHeight),
            slot: BigInt(p.refundSlot ?? "0"),
          }
        : null;
    // Memo scans go back to the first refund of the charge (0 when unknown: the scan is bounded, then inconclusive).
    let firstSlot = p.refundFirstSlot !== undefined ? BigInt(p.refundFirstSlot) : null;
    let attempts = p.refundAttempts ?? 0;
    let failures = p.refundFailures ?? 0;
    let sends = 0;
    for (;;) {
      if (journal) {
        let outcome: RefundOutcome = await this.settle(gw, journal);
        if (outcome === "confirmed") return journal.signature;
        if (outcome === "pending") throw new RefundPending(`refund ${journal.signature} of ${row.id} is not confirmed yet; it is checked again later`);
        if (outcome === "expired") {
          // Never replace a refund on one RPC answer: read the transaction itself, then the memo history.
          const tx = await gw.transaction(journal.signature);
          if (tx && (tx.err === null || tx.err === undefined)) return journal.signature;
          if (tx) outcome = "failed";
          else {
            const landed = await gw.findByMemo(`refund:${row.id}`, firstSlot ?? journal.slot);
            if (landed) return landed;
          }
        }
        if (outcome === "failed") {
          // It landed and moved nothing: a fresh one is safe, a bounded number of times.
          failures++;
          await patchCharge(row.id, { payload: { refundFailures: failures } });
          if (failures >= MAX_REFUND_FAILURES) return this.manual(row, `${failures} refund transactions failed on Solana (last ${journal.signature})`, reason);
        }
      }
      if (attempts >= MAX_REFUND_ATTEMPTS) return this.manual(row, `${attempts} refund transactions were sent without one landing`, reason);
      if (sends >= MAX_REFUND_SENDS_PER_CALL) throw new RefundPending(`refund transactions of ${row.id} keep expiring; retrying later`);
      const signed = await gw.signRefund({ to: payer, amount: row.tokenAmount, decimals, memo: `refund:${row.id}` });
      attempts++;
      sends++;
      firstSlot ??= signed.slot;
      await patchCharge(row.id, {
        payload: {
          refundSignature: signed.signature,
          refundBlockhash: signed.blockhash,
          refundLastValidBlockHeight: signed.lastValidBlockHeight.toString(),
          refundWire: signed.wire,
          refundSlot: signed.slot.toString(),
          refundFirstSlot: firstSlot.toString(),
          refundAttempts: attempts,
        },
      });
      journal = signed;
      try {
        await gw.broadcast(signed.wire);
      } catch (e) {
        // A preflight refusal means it was not forwarded; a transport error may have been. Either way the journal decides.
        console.error(`[solana-pay] refund broadcast of ${row.id} failed:`, (e as Error).message);
      }
    }
  }

  /** Waits (bounded) for a journaled refund: confirmed, failed, expired (can no longer land) or still pending. */
  private async settle(gw: SolanaGateway, tx: SignedSolanaTx): Promise<RefundOutcome> {
    const timeout = this.opts.confirmTimeoutMs ?? 30_000;
    const pollMs = this.opts.pollMs ?? 1_000;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const polls = Math.max(1, Math.ceil(timeout / pollMs));
    for (let i = 0; i < polls; i++) {
      if (i > 0) await sleep(pollMs);
      // Height first: a transaction not seen after its last valid height can no longer land.
      const height = await gw.blockHeight();
      const outcome = refundOutcome(await gw.signatureState(tx.signature), height, tx.lastValidBlockHeight);
      if (outcome !== "pending") return outcome;
      if (i % 3 === 2) await gw.broadcast(tx.wire, { resend: true }).catch(() => undefined);
    }
    return "pending";
  }

  protected override paymentView(row: LedgerRow): Record<string, unknown> {
    const c = this.toSolanaPayCharge(row);
    return { cluster: c.cluster, url: c.url, qrCodeBase64: c.qrCodeBase64, recipient: c.recipient, mint: c.mint, reference: c.reference };
  }

  toSolanaPayCharge(row: LedgerRow): SolanaPayCharge {
    const p = sp(row);
    const cluster = p.cluster ?? env.SOLANA_CLUSTER;
    const exp = expiresAtOf(row) ?? row.createdAt;
    const fulfilledTx = row.status === "fulfilled" ? (row.txHash as `0x${string}` | null) : null;
    const signature = p.solanaSignature ?? null;
    return {
      id: row.id,
      status: row.status as SolanaPayCharge["status"],
      kind: row.kind as SolanaPayCharge["kind"],
      agentId: row.agentId,
      purchaseId: row.purchaseId as `0x${string}`,
      amountUnits: row.tokenAmount.toString(),
      amount: formatUnits(row.tokenAmount, p.decimals ?? env.PAYMENT_TOKEN_DECIMALS),
      tokenSymbol: SOLANA_PAY_TOKEN_SYMBOL,
      cluster,
      url: p.url ?? "",
      qrCodeBase64: p.qrBase64 ?? "",
      recipient: p.recipient ?? "",
      mint: p.mint ?? env.SOLANA_PAY_MINT,
      reference: row.providerChargeId ?? "",
      expiresAt: exp.toISOString(),
      solanaSignature: signature,
      solanaExplorerUrl: signature ? solanaExplorerTxUrl(signature, cluster) : null,
      // The journaled refund may still be replaced while refunding (or never sent, when manual); final once refunded.
      refundSignature: row.status === "refunded" ? (p.refundSignature ?? null) : null,
      txHash: fulfilledTx,
      explorerUrl: fulfilledTx ? explorerUrl(fulfilledTx) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
