// Pure Solana Pay rules (no env, database or network), tested in test/solana-pay-rules.test.ts.

/** Open (unpaid) Solana Pay charges per wallet (same cap as Pix). */
export const SOLANA_PAY_MAX_PENDING = 3;
/** A payment that lands after the local expiry still counts for this long; after it the charge expires. */
export const SOLANA_PAY_GRACE_MS = 5 * 60_000;
/** Shown by the wallet next to the amount. */
export const SOLANA_PAY_LABEL = "Solvers";
export const SOLANA_PAY_TOKEN_SYMBOL = "USDC";
/** SPL Memo program (v2). */
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Blocks past `lastValidBlockHeight` before a transaction that was never seen counts as expired for good. */
export const BLOCKHASH_EXPIRY_MARGIN = 20n;
/** Expired charges are still re-scanned for a late payment for this long after their expiry. */
export const SOLANA_PAY_LATE_WINDOW_MS = 72 * 60 * 60_000;
/** Expired charges re-scanned per reconcile tick (least recently checked first). */
export const SOLANA_PAY_LATE_SCAN_PER_TICK = 20;
/** Refund transactions that landed but failed before the refund is left to an admin. */
export const MAX_REFUND_FAILURES = 3;
/** Refund transactions signed for one charge (failed + expired) before the refund is left to an admin. */
export const MAX_REFUND_ATTEMPTS = 10;
/** Circle USDC on mainnet-beta: the only mint accepted with Tempo mainnet unless SOLANA_PAY_ALLOW_CUSTOM_MINT. */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type SolanaClusterName = "devnet" | "mainnet-beta";

/** "19", "5.7", "0.000001": base units as a decimal string without trailing zeros (Solana Pay `amount`). */
export function formatUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError("negative amount");
  if (decimals === 0) return units.toString();
  const base = 10n ** BigInt(decimals);
  const int = units / base;
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}

export type TransferRequest = {
  recipient: string;
  amountUnits: bigint;
  decimals: number;
  mint: string;
  reference: string;
  label?: string;
  message?: string;
  memo?: string;
};

/**
 * Solana Pay transfer request URL (https://docs.solanapay.com/spec):
 * `solana:<recipient>?amount=<decimal>&spl-token=<mint>&reference=<ref>&label=..&message=..&memo=..`.
 * The amount never uses scientific notation nor trailing zeros; label, message and memo are URL-encoded.
 */
export function transferRequestUrl(r: TransferRequest): string {
  if (r.amountUnits <= 0n) throw new RangeError("amount must be positive");
  const q = [`amount=${formatUnits(r.amountUnits, r.decimals)}`, `spl-token=${r.mint}`, `reference=${r.reference}`];
  if (r.label) q.push(`label=${encodeURIComponent(r.label)}`);
  if (r.message) q.push(`message=${encodeURIComponent(r.message)}`);
  if (r.memo) q.push(`memo=${encodeURIComponent(r.memo)}`);
  return `solana:${r.recipient}?${q.join("&")}`;
}

/** Message shown by the wallet for a purchase of `kind`. */
export function paymentMessage(kind: string): string {
  return kind === "credits" ? "Solvers credits" : kind === "escrow" ? "Solvers guarantee" : "Solvers license";
}

export function solanaExplorerTxUrl(signature: string, cluster: SolanaClusterName): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}

/** Token balance of a transaction (pre or post), reduced to what the validation needs. */
export type TxTokenBalance = { accountIndex: number; mint: string; owner: string | null; amount: bigint };

/** A confirmed transaction as read with `getTransaction(…, { encoding: "jsonParsed" })`. */
export type PaymentTx = {
  /** `meta.err`: null when the transaction succeeded. */
  err: unknown;
  /** Every account of the message (static keys and loaded addresses), in index order. */
  accountKeys: readonly string[];
  /** Accounts that signed the transaction. */
  signers: readonly string[];
  preTokenBalances: readonly TxTokenBalance[];
  postTokenBalances: readonly TxTokenBalance[];
};

/** What a charge expects: its reference, the recipient wallet and its token account for the mint, and the amount. */
export type PaymentExpectation = { reference: string; recipient: string; recipientAta: string; mint: string; amount: bigint };

export type PaymentVerdict = {
  status: "paid" | "underpaid" | "none";
  /** Base units the recipient's token account received in this transaction. */
  received: bigint;
  /**
   * Signer of the transaction whose balance of the mint decreased the most (the refund goes back there); null when no
   * signer's balance decreased (e.g. a delegated transfer out of a pool or processor vault): the refund is then manual.
   */
  payer: string | null;
  /** Base units moved into OTHER token accounts of the recipient (not its associated account): never counted as paid. */
  misdirected: bigint;
};

/**
 * Does `tx` pay the charge? It must have succeeded, carry the charge's reference among its accounts and raise the
 * recipient's associated token account of the mint (owner = recipient) by at least the amount, computed from the pre and
 * post token balances (an account created in the transaction starts at 0). Nothing else in the transaction is trusted.
 */
export function validatePayment(tx: PaymentTx, x: PaymentExpectation): PaymentVerdict {
  const none: PaymentVerdict = { status: "none", received: 0n, payer: null, misdirected: 0n };
  if (tx.err !== null && tx.err !== undefined) return none;
  if (!tx.accountKeys.includes(x.reference)) return none;

  // Balance change of every token account of the mint, by account index.
  const deltas = new Map<number, { owner: string | null; delta: bigint }>();
  for (const b of tx.preTokenBalances) {
    if (b.mint !== x.mint) continue;
    deltas.set(b.accountIndex, { owner: b.owner, delta: -b.amount });
  }
  for (const b of tx.postTokenBalances) {
    if (b.mint !== x.mint) continue;
    const prev = deltas.get(b.accountIndex);
    deltas.set(b.accountIndex, { owner: b.owner ?? prev?.owner ?? null, delta: (prev?.delta ?? 0n) + b.amount });
  }

  let received = 0n;
  let misdirected = 0n;
  const spent = new Map<string, bigint>();
  for (const [index, d] of deltas) {
    const account = tx.accountKeys[index];
    if (account === x.recipientAta && d.owner === x.recipient) received += d.delta;
    else if (d.owner === x.recipient && d.delta > 0n) misdirected += d.delta;
    else if (d.delta < 0n && d.owner && d.owner !== x.recipient && tx.signers.includes(d.owner)) spent.set(d.owner, (spent.get(d.owner) ?? 0n) - d.delta);
  }
  let payer: string | null = null;
  let most = 0n;
  for (const [owner, amount] of spent) {
    if (amount > most) {
      payer = owner;
      most = amount;
    }
  }
  if (received <= 0n) return { ...none, payer, misdirected };
  return { status: received >= x.amount ? "paid" : "underpaid", received, payer, misdirected };
}

/** Outcome of a journaled refund transaction. */
export type RefundOutcome = "confirmed" | "failed" | "pending" | "expired";

/**
 * Where a journaled refund stands. `status` comes from getSignatureStatuses (history included) and `height` is the block
 * height read BEFORE it: a transaction not found once the height is past its last valid block height (plus a margin) can
 * never land, so a new one may be sent; until then it may still land and must not be replaced.
 */
export function refundOutcome(status: "confirmed" | "failed" | "unknown", height: bigint, lastValidBlockHeight: bigint): RefundOutcome {
  if (status === "confirmed") return "confirmed";
  if (status === "failed") return "failed";
  return height > lastValidBlockHeight + BLOCKHASH_EXPIRY_MARGIN ? "expired" : "pending";
}
