import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { fillEscrowTexts } from "../store/escrow.js";
import { OPEN_ESCROW_STATUSES } from "./access-rules.js";
import type { GuaranteeTask } from "./guarantee-text.js";

/**
 * Open guaranteed tasks of the wallet (newest first), optionally of a single Solver. Tasks bought through a payment
 * intent get their off-chain texts copied from the ledger first (X28), so the AI never sees placeholder steps when the
 * record exists; a step still without criteria is shown as such (and `submit_deliverable` refuses to check it).
 */
export async function openGuarantees(wallet: string, agentId?: string): Promise<GuaranteeTask[]> {
  const query = () =>
    db
      .select()
      .from(schema.escrows)
      .where(
        and(
          eq(schema.escrows.buyerWallet, wallet),
          inArray(schema.escrows.status, [...OPEN_ESCROW_STATUSES]),
          agentId ? eq(schema.escrows.agentId, agentId) : undefined,
        ),
      )
      .orderBy(desc(schema.escrows.createdAt))
      .limit(10);
  let rows = await query();
  if (rows.length === 0) return [];
  const missing = rows.filter((r) => r.title === "");
  if (missing.length) {
    let filled = 0;
    for (const r of missing) filled += await fillEscrowTexts(r.id).catch((e: unknown) => (console.warn(`[guarantees] texts of ${r.id}:`, (e as Error).message), 0));
    if (filled > 0) rows = await query();
  }
  const ms = await db
    .select()
    .from(schema.milestones)
    .where(inArray(schema.milestones.escrowId, rows.map((r) => r.id)))
    .orderBy(asc(schema.milestones.idx));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    title: r.title,
    description: r.description,
    deliveryDeadline: r.deliveryDeadline,
    milestones: ms.filter((m) => m.escrowId === r.id).map((m) => ({ idx: m.idx, title: m.title, criteria: m.criteria, verify: m.verify, status: m.status, amount: m.amount })),
  }));
}
