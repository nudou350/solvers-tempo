import { and, eq, inArray, isNull, like, lt, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { db, schema } from "../db/index.js";
import { escrowOnChain } from "./chain-reads.js";

// Dispute texts (which agreed criterion failed, and why) stay off-chain; only sha256(criterion \n reason) goes on-chain
// with `openDispute`. Like review drafts, the text is kept as a draft keyed by that hash when the buyer asks for the
// calls (`kv['dispute-draft:<escrowId>:<idx>:<reasonHash>']`), and promoted to the milestone row only once the chain
// shows a dispute with the same hash. Several builds (different reasons) never overwrite each other, and a build the
// wallet never signed never reaches the admin's queue.

const PREFIX = "dispute-draft:";
/** Unsigned drafts are dropped after this long. */
const DRAFT_TTL_DAYS = 7;

const keyOf = (escrowId: string, idx: number, reasonHash: string) => `${PREFIX}${escrowId}:${idx}:${reasonHash.toLowerCase()}`;

export async function saveDisputeDraft(input: { escrowId: string; idx: number; reasonHash: Hex; wallet: string; criterion: string; reason: string }): Promise<void> {
  const value = { wallet: input.wallet.toLowerCase(), criterion: input.criterion, reason: input.reason };
  await db
    .insert(schema.kv)
    .values({ key: keyOf(input.escrowId, input.idx, input.reasonHash), value })
    .onConflictDoUpdate({ target: schema.kv.key, set: { value, updatedAt: new Date() } });
}

/**
 * Copies the signed dispute's text into its milestone: for disputed milestones without a text (optionally of one
 * escrow), reads the on-chain reason hash and promotes the draft with that hash; the other drafts of the milestone are
 * dropped. Idempotent; runs after `/tx/confirm`, before the admin's dispute list and as a job. Returns rows promoted.
 */
export async function promoteDisputeDrafts(escrowId?: string): Promise<number> {
  const ms = schema.milestones;
  const rows = await db
    .select({ escrowId: ms.escrowId, idx: ms.idx })
    .from(ms)
    .where(and(eq(ms.status, "disputed"), isNull(ms.disputeReason), escrowId ? eq(ms.escrowId, escrowId) : undefined))
    .limit(50);
  let promoted = 0;
  for (const r of rows) {
    const drafts = await db
      .select({ key: schema.kv.key, value: schema.kv.value })
      .from(schema.kv)
      .where(like(schema.kv.key, `${PREFIX}${r.escrowId}:${r.idx}:%`));
    if (drafts.length === 0) continue;
    const onchain = await escrowOnChain(BigInt(r.escrowId)).catch(() => null);
    const hash = onchain?.milestones[r.idx]?.disputeReasonHash;
    if (!hash || /^0x0+$/.test(hash)) continue;
    const draft = drafts.find((d) => d.key === keyOf(r.escrowId, r.idx, hash));
    if (!draft) continue;
    const v = draft.value as { criterion?: unknown; reason?: unknown };
    if (typeof v.criterion !== "string" || typeof v.reason !== "string") continue;
    await db.transaction(async (tx) => {
      await tx
        .update(ms)
        .set({ disputeCriterion: v.criterion as string, disputeReason: v.reason as string })
        .where(and(eq(ms.escrowId, r.escrowId), eq(ms.idx, r.idx), isNull(ms.disputeReason)));
      await tx.delete(schema.kv).where(inArray(schema.kv.key, drafts.map((d) => d.key)));
    });
    promoted++;
  }
  return promoted;
}

/** Drops drafts never signed. */
export async function dropOldDisputeDrafts(): Promise<number> {
  const rows = await db
    .delete(schema.kv)
    .where(and(like(schema.kv.key, `${PREFIX}%`), lt(schema.kv.updatedAt, sql`now() - make_interval(days => ${DRAFT_TTL_DAYS})`)))
    .returning({ key: schema.kv.key });
  return rows.length;
}
