import { and, gt, like, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";

// Guarantee-limit holds. `planEscrowPurchase` decides the buyer's limit under a per-wallet advisory lock, but the payments
// area writes the ledger row afterwards, outside that transaction; without a hold, two concurrent intents would both
// pass the check. So the planner writes a hold (`kv['escrow-hold:<planKey>']`) INSIDE the locked transaction, and the
// limit counts holds whose ledger row does not exist yet (matched by `payment_ledger.intent.task.planKey`). A hold stops
// counting once its ledger row exists (the row is counted instead) or after HOLD_SECS (the intent failed before the
// insert); expired holds are deleted by the acceptance cleanup job.

export const HOLD_PREFIX = "escrow-hold:";
/** Far longer than plan -> ledger insert (milliseconds); short enough that a failed intent frees the limit quickly. */
export const HOLD_SECS = 120;

type Exec = Pick<typeof db, "select">;
type Insert = Pick<typeof db, "insert">;

/** Base units held for `wallet` by intents being written right now (holds without a ledger row yet). */
export async function heldGuaranteeUnits(wallet: string, exec: Exec = db): Promise<bigint> {
  const kv = schema.kv;
  const [row] = await exec
    .select({ sum: sql<string>`coalesce(sum((${kv.value}->>'units')::numeric), 0)::text` })
    .from(kv)
    .where(
      and(
        like(kv.key, `${HOLD_PREFIX}%`),
        sql`${kv.value}->>'wallet' = ${wallet}`,
        gt(kv.updatedAt, sql`now() - make_interval(secs => ${HOLD_SECS})`),
        sql`not exists (select 1 from ${schema.paymentLedger} l where l.buyer_wallet = ${wallet} and l.intent->'task'->>'planKey' = ${kv.value}->>'planKey')`,
      ),
    );
  return BigInt(row?.sum ?? "0");
}

/** Writes the hold of a planned guarantee (call inside the transaction that holds the wallet's advisory lock). */
export async function placeHold(tx: Insert, wallet: string, planKey: string, units: bigint): Promise<void> {
  await tx.insert(schema.kv).values({ key: `${HOLD_PREFIX}${planKey}`, value: { wallet, planKey, units: units.toString() } });
}

/** Deletes holds that no longer count (expired). */
export async function dropExpiredHolds(): Promise<number> {
  const rows = await db
    .delete(schema.kv)
    .where(and(like(schema.kv.key, `${HOLD_PREFIX}%`), lt(schema.kv.updatedAt, sql`now() - make_interval(secs => ${HOLD_SECS})`)))
    .returning({ key: schema.kv.key });
  return rows.length;
}
