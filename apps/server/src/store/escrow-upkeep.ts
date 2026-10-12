import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError } from "../lib/http.js";
import { discardAcceptance } from "../verifier/deliverables.js";
import { dropOldDisputeDrafts } from "./dispute-drafts.js";
import { fillEscrowTexts } from "./escrow.js";
import { dropExpiredHolds } from "./guarantee-holds.js";

// Upkeep of guaranteed tasks bought through a payment intent (X28): the off-chain texts must be on the mirrored rows
// before a delivery is checked, and the acceptance suites saved at intent time (`DELIVERABLES_DIR/plan-<id>`) must not
// pile up when the purchase never happens.

/**
 * A guarantee charge of this escrow's buyer with its purchase id carries the task texts (`payment_ledger.intent.task`),
 * whatever its status (it may still be `fulfilling` while the indexer already mirrored the escrow). Another wallet reusing
 * a known purchase id in its own `createEscrow` does not match (same rule as `fillEscrowTexts`).
 */
async function hasIntentRecord(escrowId: string): Promise<boolean> {
  const e = schema.escrows;
  const l = schema.paymentLedger;
  const [row] = await db
    .select({ task: sql<unknown>`${l.intent}->'task'` })
    .from(e)
    .innerJoin(l, and(eq(l.purchaseId, e.purchaseId), eq(l.buyerWallet, e.buyerWallet), eq(l.kind, "escrow")))
    .where(eq(e.id, escrowId));
  const t = row?.task as { title?: unknown; milestones?: unknown } | null | undefined;
  return !!t && typeof t.title === "string" && Array.isArray(t.milestones);
}

/**
 * Refuses to check a delivery while the step's agreed texts are missing. The indexer mirrors an escrow with placeholder
 * texts (no criteria, `verify = tests`, no acceptance suite); checking it then would pass the delivery on its OWN tests
 * and skip the agreed suite. So: fill the texts from the purchase's ledger row first; if the step still has no criteria,
 * refuse (409) — `guarantee_texts_pending` while the record exists but was not copied yet, `guarantee_texts_mismatch` when
 * the on-chain criteria hash is not the planned one, `no_agreed_criteria` when no record exists at all (an escrow created
 * without an intent). Returns quietly when the step does not exist (the verifier answers 404).
 */
export async function assertMilestoneTexts(escrowId: string, idx: number): Promise<void> {
  const load = async () => {
    const [m] = await db
      .select({ criteria: schema.milestones.criteria, escrowTitle: schema.escrows.title })
      .from(schema.milestones)
      .innerJoin(schema.escrows, eq(schema.escrows.id, schema.milestones.escrowId))
      .where(and(eq(schema.milestones.escrowId, escrowId), eq(schema.milestones.idx, idx)));
    return m;
  };
  let m = await load();
  if (!m || m.criteria.trim() !== "") return;
  await fillEscrowTexts(escrowId).catch((e: unknown) => console.warn(`[escrow] filling texts of ${escrowId}:`, (e as Error).message));
  m = await load();
  if (!m || m.criteria.trim() !== "") return;
  if (!(await hasIntentRecord(escrowId))) {
    throw new HttpError(
      409,
      "This guaranteed task has no agreed criteria on record, so its deliveries can't be checked. Please contact support.",
      "no_agreed_criteria",
    );
  }
  if (m.escrowTitle !== "") {
    console.error(`[escrow] ${escrowId}#${idx}: the on-chain criteria hash differs from the planned one`);
    throw new HttpError(
      409,
      "The agreed criteria of this step don't match what was recorded on the network, so the delivery can't be checked. Please contact support.",
      "guarantee_texts_mismatch",
    );
  }
  throw new HttpError(409, "The agreed criteria of this guaranteed task are still being recorded. Try the delivery again in a minute.", "guarantee_texts_pending");
}

// ---------- Acceptance suites of intents that never became an escrow ----------

const PLAN_DIR = /^plan-[0-9a-f]{8,64}$/;
/** A plan folder is never removed before this age (intents expire after 30 min; Pix allows a grace period). */
export const PLAN_MAX_AGE_MS = 24 * 3600_000;
/** Ledger states in which a charge can no longer turn into an escrow by itself. */
const DEAD_CHARGE = ["expired", "failed", "refunded"];

/**
 * Is a plan folder still needed? Yes when a milestone points into it (its escrow exists: the folder IS the step's agreed
 * suite, read through `milestones.acceptance_path`), when a ledger row that mentions it is still alive, or when an escrow
 * with that row's purchase id exists (texts not copied yet).
 */
async function planInUse(key: string): Promise<boolean> {
  const [ref] = await db
    .select({ n: sql<number>`1` })
    .from(schema.milestones)
    .where(sql`position(${key} in coalesce(${schema.milestones.acceptancePath}, '')) > 0`)
    .limit(1);
  if (ref) return true;
  const rows = await db
    .select({ status: schema.paymentLedger.status, purchaseId: schema.paymentLedger.purchaseId })
    .from(schema.paymentLedger)
    .where(sql`position(${key} in ${schema.paymentLedger.intent}::text) > 0`);
  for (const r of rows) {
    if (!DEAD_CHARGE.includes(r.status)) return true;
    const [e] = await db.select({ id: schema.escrows.id }).from(schema.escrows).where(eq(schema.escrows.purchaseId, r.purchaseId)).limit(1);
    if (e) return true;
  }
  return false;
}

/**
 * Removes `plan-*` folders older than PLAN_MAX_AGE_MS whose intent never became an escrow (ledger row expired, failed,
 * refunded or missing, and no milestone points into them); folders of escrows that exist stay where they are (the
 * milestones reference them, so "adopting" them is just keeping them). Also drops expired guarantee-limit holds and
 * unsigned dispute drafts. Returns the removed folder names.
 */
export async function cleanupAcceptancePlansOnce(now = Date.now()): Promise<string[]> {
  await dropExpiredHolds().catch((e: unknown) => console.warn("[escrow] dropping holds:", (e as Error).message));
  await dropOldDisputeDrafts().catch((e: unknown) => console.warn("[escrow] dropping dispute drafts:", (e as Error).message));
  const root = resolve(env.DELIVERABLES_DIR);
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || !PLAN_DIR.test(ent.name)) continue;
    try {
      if (now - statSync(join(root, ent.name)).mtimeMs < PLAN_MAX_AGE_MS) continue;
      if (await planInUse(ent.name)) continue;
      discardAcceptance(ent.name);
      removed.push(ent.name);
    } catch (e) {
      console.warn(`[escrow] acceptance plan ${ent.name}:`, (e as Error).message);
    }
  }
  return removed;
}
