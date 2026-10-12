// Friendly text for any error the web shows: API errors (`ApiError.code` -> errors.api.<code>), contract reverts decoded
// by custom error NAME (SoldOut, PriceChanged, DuplicatePurchase, SelfPurchase, Paused... -> errors.contract.<Name>),
// wallet errors (signature cancelled) and the relay declining to sponsor a fee. Pure (no React, no next-intl import):
// the caller passes the translator of the "errors" namespace, so this file is unit-tested (test/error-map.test.ts).
import { ApiError } from "@solvers/api-client";
import { decodeSolversError } from "@solvers/chain/browser";
import { formatToken } from "./format-money";

/** Translator of the "errors" namespace (next-intl `useTranslations("errors")` or lib/local-text). */
export type ErrorsT = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

export type ErrorAction = "faucet" | "login" | "retry" | null;

export type TxErrorInfo = {
  /** API code, contract error name ("contract:SoldOut") or a client kind (cancelled, sponsor_declined, wrong_network...). */
  code: string;
  title: string;
  text: string;
  /** Action the screen may offer: get test funds, sign in again or retry. */
  action: ErrorAction;
  /** Decoded contract custom error, when the failure came from a contract revert. */
  contractError?: string;
};

export type ErrorContext = {
  /** Payment token, to format amounts carried by API errors (balance, needed, price). */
  token?: { symbol: string; decimals: number } | null;
  /** BCP 47 locale for numbers (en-US, pt-BR). */
  intlLocale?: string;
  /** Test network with the faucet on: insufficient balance offers "get test funds". */
  faucetEnabled?: boolean;
};

/** Client-side failure with a known code (lib/tx.ts, lib/wallet). */
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

/**
 * An error whose message is already written for the person, in the page language (e.g. `t("walletMismatch")`). It is the
 * only kind of plain error shown verbatim; any other unexpected error shows the generic localized text.
 */
export class UserFacingError extends Error {}

/** Client codes after which retrying the same action cannot help. */
const NO_RETRY = new Set(["sponsor_declined", "unconfirmed", "privy_chain_mismatch"]);

const REVERT_IN_MESSAGE = /custom error (0x[0-9a-fA-F]{8})(?::\s*(?:0x)?([0-9a-fA-F]*))?/;
const SIMULATION_IN_MESSAGE = /simulation reverted: ([A-Za-z][A-Za-z0-9_]*)/;

function messagesOf(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const v of [o.shortMessage, o.message, o.details]) if (typeof v === "string") parts.push(v);
    cur = o.cause;
  }
  return parts.join("\n");
}

/**
 * Name of the contract custom error behind `e`, or null. Tries the viem error tree (revert data), then the revert data
 * that nodes print in the message ("custom error 0xa6dc15bd: 00..."), then the relay's "simulation reverted: Name".
 */
export function contractErrorName(e: unknown): string | null {
  if (e instanceof ApiError) {
    const named = typeof e.body.error === "string" && /^[A-Z][A-Za-z0-9]+$/.test(e.body.error) ? e.body.error : null;
    return e.code === "simulation_failed" ? named : null;
  }
  const direct = decodeSolversError(e);
  if (direct.name !== "Unknown") return direct.name;
  // Duck-typed walk for revert data: the error may come from another copy of viem (different peer resolutions in the
  // workspace), where `instanceof BaseError` inside decodeSolversError is false.
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const o = cur as { data?: unknown; raw?: unknown; cause?: unknown };
    for (const d of [o.data, o.raw, (o.data as { data?: unknown } | undefined)?.data]) {
      if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
        const decoded = decodeSolversError(d);
        if (decoded.name !== "Unknown") return decoded.name;
      }
    }
    cur = o.cause;
  }
  const text = messagesOf(e);
  const m = REVERT_IN_MESSAGE.exec(text);
  if (m) {
    const args = (m[2] ?? "").replace(/^0x/, "");
    const data = `${m[1]}${args.length % 2 === 0 ? args : `0${args}`}` as `0x${string}`;
    const decoded = decodeSolversError(data);
    if (decoded.name !== "Unknown") return decoded.name;
  }
  const s = SIMULATION_IN_MESSAGE.exec(text);
  if (s && s[1] !== "Unknown") return s[1]!;
  return null;
}

/** The person closed or refused the wallet prompt (EIP-1193 4001, viem UserRejectedRequestError, Privy exit). */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const o = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (o.code === 4001 || o.name === "UserRejectedRequestError") return true;
    cur = o.cause;
  }
  if (e instanceof ApiError) return false;
  return /user (rejected|denied|cancel)|rejected the request|exited_auth_flow|cancelled by user|canceled by user/i.test(messagesOf(e));
}

/** Contract error name -> the tx message id with a title (errors.tx.<id>), when one is more specific than the generic. */
const CONTRACT_TO_TX: Record<string, { id: string; action?: ErrorAction }> = {
  SoldOut: { id: "sold_out" },
  PriceChanged: { id: "price_changed" },
  InsufficientBalance: { id: "insufficient_funds", action: "faucet" },
  RoyaltyChanged: { id: "royalty_changed" },
  Paused: { id: "paused", action: "retry" },
  ContractPaused: { id: "paused", action: "retry" },
  TransfersPaused: { id: "paused", action: "retry" },
};

export function errorInfo(e: unknown, t: ErrorsT, ctx: ErrorContext = {}): TxErrorInfo {
  const locale = ctx.intlLocale ?? "en-US";
  const amount = (units: unknown): string | null =>
    ctx.token && (typeof units === "string" || typeof units === "bigint") ? formatToken(units, ctx.token, locale) : null;
  const tx = (code: string, id: string, action: ErrorAction = null, values?: Record<string, string | number>): TxErrorInfo => ({
    code,
    title: t(`tx.${id}.title`),
    text: t(`tx.${id}.text`, values),
    action,
  });
  const withText = (code: string, id: string, text: string, action: ErrorAction = null): TxErrorInfo => ({ code, title: t(`tx.${id}.title`), text, action });
  const apiText = (err: ApiError) => (err.code && t.has(`api.${err.code}`) ? t(`api.${err.code}`) : err.message || t("generic"));
  const faucet: ErrorAction = ctx.faucetEnabled ? "faucet" : null;

  // ----- Wallet prompt closed -----
  if (isUserRejection(e)) return tx("cancelled", "cancelled");

  // ----- Contract revert (simulated by the relay or the node, or reported by the server) -----
  const name = contractErrorName(e);
  if (name) {
    const specific = CONTRACT_TO_TX[name];
    if (specific) {
      const info = tx(`contract:${name}`, specific.id, specific.action === "faucet" ? faucet : (specific.action ?? null));
      return { ...info, contractError: name };
    }
    const text = t.has(`contract.${name}`) ? t(`contract.${name}`) : t("tx.contract_rejected.text");
    return { code: `contract:${name}`, title: t("tx.contract_rejected.title"), text, action: null, contractError: name };
  }

  // ----- Client-side failures -----
  if (e instanceof ClientError || (e as { code?: unknown } | null)?.code === "sponsor_declined") {
    const code = (e as { code: string }).code;
    if (t.has(`tx.${code}.title`)) return tx(code, code, NO_RETRY.has(code) ? null : "retry");
  }

  // ----- API errors -----
  if (e instanceof ApiError) {
    const b = e.body;
    switch (e.code) {
      case "insufficient_funds": {
        const balance = amount(b.balanceUnits);
        const needed = amount(b.neededUnits);
        const action = b.faucetEnabled === true || ctx.faucetEnabled ? "faucet" : null;
        if (balance && needed) return tx(e.code, "insufficient_funds_amounts", action, { balance, needed });
        return tx(e.code, "insufficient_funds", action);
      }
      case "price_changed": {
        const now = amount(b.priceUnits);
        if (now) return tx(e.code, "price_changed_amount", null, { now });
        return tx(e.code, "price_changed");
      }
      case "royalty_changed":
      case "sold_out":
      case "guarantee_limit":
      case "license_already_reviewed":
      case "submission_state":
      case "not_approved":
      case "wrong_step":
      case "publication_blocked":
      case "invalid_criterion":
        return tx(e.code, e.code);
      case "rate_limited":
        return tx(e.code, "rate_limited", "retry");
      case "unauthorized":
        return tx(e.code, "unauthorized", "login");
      case "faucet_cooldown":
      case "faucet_daily_cap":
        return withText(e.code, "faucet_unavailable", apiText(e));
      case "transaction_failed":
        return withText(e.code, "transaction_failed", apiText(e), "retry");
      case "validation":
      case "bad_request":
        return withText(e.code, "bad_request", t.has(`api.${e.code}`) ? t(`api.${e.code}`) : e.message);
      default:
        if (e.status >= 500) return tx(e.code, "server_error", "retry");
        if (e.status === 0) return tx("network", "offline", "retry");
        return withText(e.code, "bad_request", apiText(e));
    }
  }

  // ----- Anything else (network down, unexpected exception) -----
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return tx("network", "offline", "retry");
  // Text the app wrote for the person (already translated) is shown as is. Anything else (library errors, plain English
  // `Error`s) shows the generic localized text; the raw error stays in the console for debugging.
  if (e instanceof UserFacingError && msg) return { code: "unknown", title: t("tx.unknown.title"), text: msg, action: "retry" };
  console.error("[solvers] unexpected error", e);
  return { code: "unknown", title: t("tx.unknown.title"), text: t("tx.unknown.text"), action: "retry" };
}

/** One line of text for a toast or an inline error. */
export function errorText(e: unknown, t: ErrorsT, ctx?: ErrorContext): string {
  return errorInfo(e, t, ctx).text;
}
