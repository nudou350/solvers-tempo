import { and, asc, gte, lt } from "drizzle-orm";

import { db, schema } from "../db/index.js";
import type { LedgerRow } from "./ledger.js";

// CSV export of the payment ledger (cli:ledger-export). Amounts stay in token base units and BRL cents (integers, no
// float rounding); the decimals of the token are in their own column so a spreadsheet can convert them.

export const LEDGER_CSV_COLUMNS = [
  "charge_id",
  "provider",
  "provider_charge_id",
  "status",
  "kind",
  "agent_id",
  "buyer_wallet",
  "payer_wallet",
  "purchase_id",
  "token_address",
  "token_decimals",
  "token_amount",
  "gross",
  "fee",
  "creator_amount",
  "creator_deferred",
  "amount_brl_cents",
  "fx_rate",
  "fx_source",
  "tx_hash",
  "log_index",
  "ref",
  "error",
  "created_at",
  "confirmed_at",
  "fulfilled_at",
  "updated_at",
] as const;

/** RFC 4180 field: quoted when it contains a comma, quote or line break; leading formula characters are neutralised. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ledgerCsv(rows: readonly LedgerRow[], tokenDecimals: number): string {
  const lines = [LEDGER_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.provider,
        r.providerChargeId,
        r.status,
        r.kind,
        r.agentId,
        r.buyerWallet,
        r.payerWallet,
        r.purchaseId,
        r.tokenAddress,
        tokenDecimals,
        r.tokenAmount,
        r.gross,
        r.fee,
        r.creatorAmount,
        r.creatorDeferred,
        r.amountBrlCents,
        r.fxRate,
        r.fxSource,
        r.txHash,
        r.logIndex,
        r.ref,
        r.error,
        r.createdAt,
        r.confirmedAt,
        r.fulfilledAt,
        r.updatedAt,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Ledger rows created in [from, to). */
export async function ledgerRows(from: Date, to: Date): Promise<LedgerRow[]> {
  return db
    .select()
    .from(schema.paymentLedger)
    .where(and(gte(schema.paymentLedger.createdAt, from), lt(schema.paymentLedger.createdAt, to)))
    .orderBy(asc(schema.paymentLedger.createdAt), asc(schema.paymentLedger.id));
}

/** `--from 2026-10-01 --to 2026-10-31` (dates are UTC days; `to` is inclusive). Pure. */
export function parseRange(args: readonly string[], now = new Date()): { from: Date; to: Date } {
  const get = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const day = (s: string, flag: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${flag} expects YYYY-MM-DD, got ${s}`);
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`${flag}: invalid date ${s}`);
    return d;
  };
  const fromArg = get("--from");
  const toArg = get("--to");
  const from = fromArg ? day(fromArg, "--from") : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toDay = toArg ? day(toArg, "--to") : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(toDay.getTime() + 86_400_000);
  if (to <= from) throw new Error("--to must not be before --from");
  return { from, to };
}
