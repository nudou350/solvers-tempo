import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Call, Charge, ChargeKind, ChargeStatus, PaymentProviderId } from "@solvers/shared";

import { db, schema } from "../db/index.js";

// Payment ledger (`payment_ledger`, plan §5): one row per charge, written BEFORE any provider call or transaction.
// Every status change is a conditional UPDATE (`WHERE status IN (...)`), so concurrent webhooks, the reconcile job and
// a user request can never move the same charge twice (e.g. two `fulfill` calls: only one wins `confirmed -> fulfilling`).

export type LedgerRow = typeof schema.paymentLedger.$inferSelect;
type LedgerInsert = typeof schema.paymentLedger.$inferInsert;

/**
 * Provider data kept in `provider_payload` (jsonb). `expiresAt` (ISO) is when an unpaid charge expires; the rest is
 * provider-specific (Pix QR code, MPP challenge ids, refund transaction, ...).
 */
export type ProviderPayload = {
  expiresAt?: string;
  [key: string]: unknown;
};

export type LedgerPatch = Partial<
  Pick<
    LedgerInsert,
    | "providerChargeId"
    | "buyerWallet"
    | "txHash"
    | "logIndex"
    | "ref"
    | "gross"
    | "fee"
    | "creatorAmount"
    | "creatorDeferred"
    | "error"
    | "confirmedAt"
    | "fulfilledAt"
    | "tokenAmount"
  >
> & { payload?: ProviderPayload };

/** New charge id: `<prefix>_<24 hex>` (the purchase id is derived from it, so it must be unpredictable). */
export function newChargeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export async function insertCharge(values: LedgerInsert): Promise<LedgerRow> {
  const [row] = await db.insert(schema.paymentLedger).values(values).returning();
  return row!;
}

export async function loadCharge(id: string): Promise<LedgerRow | undefined> {
  const [row] = await db.select().from(schema.paymentLedger).where(eq(schema.paymentLedger.id, id));
  return row;
}

/** The charge of a purchase id. Ids are scoped by payer on-chain (X22), so the payer is part of the key. */
export async function loadByPurchaseId(payer: string, purchaseId: string): Promise<LedgerRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.paymentLedger)
    .where(and(eq(schema.paymentLedger.payerWallet, payer.toLowerCase()), eq(schema.paymentLedger.purchaseId, purchaseId.toLowerCase())));
  return row;
}

export async function loadByProviderChargeId(provider: PaymentProviderId, providerChargeId: string): Promise<LedgerRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.paymentLedger)
    .where(and(eq(schema.paymentLedger.provider, provider), eq(schema.paymentLedger.providerChargeId, providerChargeId)));
  return row;
}

export async function openCharges(provider: PaymentProviderId, statuses: readonly ChargeStatus[]): Promise<LedgerRow[]> {
  return db
    .select()
    .from(schema.paymentLedger)
    .where(and(eq(schema.paymentLedger.provider, provider), inArray(schema.paymentLedger.status, [...statuses])));
}

function setOf(patch: LedgerPatch): Record<string, unknown> {
  const { payload, ...cols } = patch;
  const set: Record<string, unknown> = { ...cols, updatedAt: new Date() };
  if (payload) {
    set.providerPayload = sql`coalesce(${schema.paymentLedger.providerPayload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb`;
  }
  return set;
}

/**
 * Moves the charge to `to` only if its current status is one of `from`; returns the updated row, or null when another
 * actor moved it first (the caller re-reads and decides).
 */
export async function transition(
  id: string,
  from: readonly ChargeStatus[],
  to: ChargeStatus,
  patch: LedgerPatch = {},
  extra?: SQL,
): Promise<LedgerRow | null> {
  const [row] = await db
    .update(schema.paymentLedger)
    .set({ ...setOf(patch), status: to })
    .where(and(eq(schema.paymentLedger.id, id), inArray(schema.paymentLedger.status, [...from]), extra))
    .returning();
  return row ?? null;
}

/** Updates columns (not the status) only if the row's status is one of `statuses` and `extra` holds; null otherwise. */
export async function patchWhere(id: string, statuses: readonly ChargeStatus[], extra: SQL, patch: LedgerPatch): Promise<LedgerRow | null> {
  const [row] = await db
    .update(schema.paymentLedger)
    .set(setOf(patch))
    .where(and(eq(schema.paymentLedger.id, id), inArray(schema.paymentLedger.status, [...statuses]), extra))
    .returning();
  return row ?? null;
}

/**
 * Claims a step of a charge (e.g. sending its refund) for exactly one caller at a time: stamps `payload[key]` with the
 * current time only if the status is one of `statuses` and the step was never claimed or its last claim is older than
 * `staleMs` (the claimer crashed). Concurrent callers race on one conditional UPDATE and only one matches; a caller that
 * read the row after another claimed it also fails while that claim is live. Wall clock on purpose: it guards
 * processes, not business time. Returns the claimed row or null.
 */
export async function claimStep(id: string, statuses: readonly ChargeStatus[], key: string, staleMs: number): Promise<LedgerRow | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleMs).toISOString();
  const p = schema.paymentLedger.providerPayload;
  const [row] = await db
    .update(schema.paymentLedger)
    .set(setOf({ payload: { [key]: now.toISOString() } }))
    .where(
      and(
        eq(schema.paymentLedger.id, id),
        inArray(schema.paymentLedger.status, [...statuses]),
        sql`((${p} ->> ${key}) is null or (${p} ->> ${key})::timestamptz < ${staleBefore}::timestamptz)`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Updates columns without changing the status. */
export async function patchCharge(id: string, patch: LedgerPatch): Promise<LedgerRow | null> {
  const [row] = await db.update(schema.paymentLedger).set(setOf(patch)).where(eq(schema.paymentLedger.id, id)).returning();
  return row ?? null;
}

/** Appends `value` to the jsonb array `payload[key]` (e.g. every MPP challenge issued for an order). */
export async function appendToPayload(id: string, key: string, value: string): Promise<void> {
  await db
    .update(schema.paymentLedger)
    .set({
      providerPayload: sql`jsonb_set(coalesce(${schema.paymentLedger.providerPayload}, '{}'::jsonb), ${`{${key}}`}::text[],
        coalesce(${schema.paymentLedger.providerPayload} -> ${key}, '[]'::jsonb) || to_jsonb(${value}::text))`,
      updatedAt: new Date(),
    })
    .where(eq(schema.paymentLedger.id, id));
}

export function payloadOf(row: LedgerRow): ProviderPayload {
  return (row.providerPayload ?? {}) as ProviderPayload;
}

export function expiresAtOf(row: LedgerRow): Date | null {
  const v = payloadOf(row).expiresAt;
  return typeof v === "string" ? new Date(v) : null;
}

/** Server view of a ledger row (`Charge`, @solvers/shared). */
export function toCharge(row: LedgerRow, extra: { calls?: Call[] | null; payment?: Record<string, unknown> | null } = {}): Charge {
  return {
    id: row.id,
    provider: row.provider as PaymentProviderId,
    providerChargeId: row.providerChargeId,
    purchaseId: row.purchaseId as `0x${string}`,
    kind: row.kind as ChargeKind,
    agentId: row.agentId,
    buyer: row.buyerWallet as `0x${string}`,
    status: row.status as ChargeStatus,
    amount: row.tokenAmount,
    token: row.tokenAddress as `0x${string}`,
    amountBrlCents: row.amountBrlCents === null ? null : Number(row.amountBrlCents),
    fxRate: row.fxRate,
    calls: extra.calls ?? null,
    txHash: (row.txHash as `0x${string}` | null) ?? null,
    error: row.error,
    payment: extra.payment ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: expiresAtOf(row),
    confirmedAt: row.confirmedAt,
    fulfilledAt: row.fulfilledAt,
  };
}
