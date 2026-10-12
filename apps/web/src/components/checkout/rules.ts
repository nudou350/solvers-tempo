// Pure rules of the checkout, done and install pages (no React, unit-tested in apps/web/test).
import { isTxHash, sameAddress, type AgentSupply, type ChargeStatus } from "@solvers/shared";

/** What the checkout sells: a permanent license or a task with a guarantee (an escrow with milestones). */
export type CheckoutKind = "license" | "guarantee";
/** "solana" = USDC on Solana (Solana Pay): only when the buyer picks it, never chosen by default. */
export type PayMethod = "wallet" | "pix" | "solana";

export const CHECKOUT_KINDS: CheckoutKind[] = ["license", "guarantee"];

/** First non-empty value of a search param. */
export function param(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

/** `?type=` of the checkout. `permanent` is the name older links used for the license. */
export function parseKind(v: string | string[] | undefined): CheckoutKind {
  const s = param(v);
  return s === "guarantee" ? "guarantee" : "license";
}

/** Why this wallet cannot buy right now (null = it can). The server checks again; this only explains it early. */
export type GuardCode = "owned" | "creator" | "sold_out" | "below_min" | "paused" | "unavailable";

export function purchaseGuard(input: {
  kind: CheckoutKind;
  /** The session wallet already holds a license of this Solver. */
  owned: boolean;
  sessionWallet: string | null;
  creatorWallet: string | null;
  supply: AgentSupply | undefined;
  totalUnits: bigint | null;
  minPriceUnits: bigint | null;
}): GuardCode | null {
  if (input.kind === "license") {
    if (input.owned) return "owned";
    // D12: a creator cannot buy a license of their own Solver (the contract refuses it too).
    if (sameAddress(input.sessionWallet, input.creatorWallet)) return "creator";
    if (input.supply?.left === 0) return "sold_out";
  }
  if (input.totalUnits != null && input.minPriceUnits != null && input.totalUnits < input.minPriceUnits) return "below_min";
  return null;
}

/** API error code -> the guard it reveals (purchase intents and Pix charges share the codes). */
export function guardOfError(code: string | null | undefined): GuardCode | null {
  switch (code) {
    case "already_owned":
      return "owned";
    case "creator_cannot_buy":
      return "creator";
    case "sold_out":
      return "sold_out";
    case "below_min_price":
      return "below_min";
    case "platform_paused":
      return "paused";
    case "agent_unavailable":
    case "agent_not_listed":
    case "price_in_review":
    case "platform_agent_not_for_sale":
      return "unavailable";
    default:
      return null;
  }
}

/** The wallet balance covers the total (both in base units). Unknown balance: false. */
export function walletCovers(balanceUnits: bigint | null, totalUnits: bigint | null): boolean {
  return balanceUnits != null && totalUnits != null && balanceUnits >= totalUnits;
}

/**
 * Default payment method: Pix when it is on and the balance does not cover the price, else the wallet. Never "solana":
 * paying from another network is always the buyer's explicit choice.
 */
export function defaultMethod(input: { pixEnabled: boolean; balanceUnits: bigint | null; totalUnits: bigint | null }): Exclude<PayMethod, "solana"> {
  if (!input.pixEnabled) return "wallet";
  if (input.balanceUnits == null) return "wallet";
  return walletCovers(input.balanceUnits, input.totalUnits) ? "wallet" : "pix";
}

/** Where a Pix charge stands, for the panel. The server status decides; the local clock only warns. */
export type PixPhase = "waiting" | "due" | "lapsed" | "paid" | "done" | "refund" | "expired" | "failed";

/** After the deadline the panel keeps polling this long (the provider may confirm late). */
export const PIX_GRACE_MS = 2 * 60_000;

export function pixPhase(status: ChargeStatus, expiresAtMs: number, nowMs: number, graceMs = PIX_GRACE_MS): PixPhase {
  switch (status) {
    case "fulfilled":
      return "done";
    case "confirmed":
    case "fulfilling":
      return "paid";
    case "refunding":
    case "refunded":
      return "refund";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default: {
      const left = expiresAtMs - nowMs;
      if (left > 0) return "waiting";
      return left < -graceMs ? "lapsed" : "due";
    }
  }
}

/** Solana Pay: the server still accepts a payment found up to 5 min after the deadline, so the panel keeps checking. */
export const SOLANA_GRACE_MS = 5 * 60_000;

/** Solana transaction signature (base58, 64 bytes -> 86-88 chars; generous bounds), safe to put in a link. */
export function isSolanaSignature(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v);
}

/** Solana Explorer link of a transaction; null when the signature is not well formed. */
export function solanaTxUrl(signature: string | null | undefined, cluster: "devnet" | "mainnet-beta"): string | null {
  if (!isSolanaSignature(signature)) return null;
  return `https://explorer.solana.com/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

/** Only a Solana Pay transfer request (`solana:<recipient>?...`) may become the "open in wallet" link. */
export function safeSolanaPayUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}(\?|$)/.test(url) ? url : null;
}

/** Only an https Solana Explorer link from the server is shown as a link. */
export function safeExplorerUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/explorer\.solana\.com\//.test(url) ? url : null;
}

/** Done page: the purchase is confirmed (fulfilled), still settling, or did not go through. */
export type DonePhase = "ok" | "waiting" | "failed";

export function donePhase(status: ChargeStatus): DonePhase {
  if (status === "fulfilled") return "ok";
  if (status === "refunding" || status === "refunded" || status === "expired" || status === "failed") return "failed";
  return "waiting";
}

/** Purchase kind on the done page (license or escrow), from `?kind=`. */
export type DoneKind = "license" | "escrow";

export function parseDoneKind(v: string | string[] | undefined): DoneKind {
  return param(v) === "escrow" ? "escrow" : "license";
}

/** Done page URL: the charge id is what the page re-checks; the tx hash only feeds the explorer link. */
export function doneHref(input: { slug: string; kind: DoneKind; chargeId: string; txHash?: string | null }): string {
  const q = new URLSearchParams({ agent: input.slug, kind: input.kind, charge: input.chargeId });
  if (input.txHash && isTxHash(input.txHash)) q.set("tx", input.txHash.toLowerCase());
  return `/checkout/done?${q}`;
}

/**
 * The wallet broadcast the payment but its confirmation timed out (`TxUnconfirmedError` from lib/tx.ts: code
 * "unconfirmed" with the hash). The payment may still land, so the checkout must not offer to pay again: it goes to the
 * done page, which follows the charge. Returns that link, or null for any other error. Duck-typed (no React import).
 */
export function unconfirmedDoneHref(e: unknown, ctx: { slug: string; kind: DoneKind; chargeId: string }): string | null {
  const o = e as { code?: unknown; hash?: unknown } | null;
  if (!o || typeof o !== "object" || o.code !== "unconfirmed" || typeof o.hash !== "string" || !isTxHash(o.hash)) return null;
  return doneHref({ ...ctx, txHash: o.hash });
}

/** `?tx=` of the done page: only a well-formed transaction hash is kept (it ends up in an explorer link). */
export function parseTxHash(v: string | string[] | undefined): `0x${string}` | null {
  const s = param(v);
  return s && isTxHash(s) ? (s.toLowerCase() as `0x${string}`) : null;
}

/** Guarantee task text limits (the server allows up to 200 / 10 000; the form asks for a bit more substance). */
export const TASK_LIMITS = { titleMin: 3, titleMax: 120, descMin: 10, descMax: 4000 } as const;
/** Delivery deadlines offered for a guarantee, in days (the server assumes 14 when missing, at most 60). */
export const DELIVERY_OPTIONS = [7, 14, 30, 60] as const;

export function taskValid(title: string, desc: string): { titleOk: boolean; descOk: boolean } {
  const tl = title.trim().length;
  const dl = desc.trim().length;
  return {
    titleOk: tl >= TASK_LIMITS.titleMin && tl <= TASK_LIMITS.titleMax,
    descOk: dl >= TASK_LIMITS.descMin && dl <= TASK_LIMITS.descMax,
  };
}
