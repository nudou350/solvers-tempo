import { and, eq, gt, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { generateLinkCode, hashLinkCode, linkExpiry, normalizeLinkCode, planIssue } from "./link-rules.js";

// Database side of Telegram linking (rules in link-rules.ts). Two steps: the site issues the code (issueLinkCode) and the bot
// redeems it (redeemLinkCode). The code is never stored, only its hash.

export type IssueResult = { status: "ok"; code: string; expiresAt: Date } | { status: "no_profile" } | { status: "limited"; retryAfterSec: number };

/** Issues a new code for the creator (the previous one stops working). Up to 5 per hour; only for those who already have a creator profile. */
export async function issueLinkCode(wallet: string, now: Date = new Date(), bytes?: Uint8Array): Promise<IssueResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-link:${wallet}`}, 0))`);
    const [c] = await tx.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
    if (!c) return { status: "no_profile" } as const;
    const plan = planIssue({ windowStart: c.telegramLinkWindowStart, count: c.telegramLinkCount }, now);
    if (!plan.ok) return { status: "limited", retryAfterSec: plan.retryAfterSec } as const;
    const code = generateLinkCode(bytes);
    const expiresAt = linkExpiry(now);
    await tx
      .update(schema.creators)
      .set({ telegramLinkHash: hashLinkCode(code), telegramLinkExpiresAt: expiresAt, telegramLinkWindowStart: plan.windowStart, telegramLinkCount: plan.count })
      .where(eq(schema.creators.id, c.id));
    return { status: "ok", code, expiresAt } as const;
  });
}

export type RedeemResult = { status: "linked"; name: string } | { status: "invalid" } | { status: "chat_taken" };

/**
 * Redeems the code sent to the bot: stores `telegram_chat_id` on the creator who owns the code and deletes the code (single use).
 * A chat can belong to only ONE creator (`chat_taken`). A malformed, unknown, expired or already used code always gives `invalid`.
 */
export async function redeemLinkCode(chatId: string, raw: string, now: Date = new Date()): Promise<RedeemResult> {
  const code = normalizeLinkCode(raw);
  if (!code) return { status: "invalid" };
  const hash = hashLinkCode(code);
  return db.transaction(async (tx) => {
    // Per-chat lock: two codes from different creators sent from the same chat cannot both succeed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-chat:${chatId}`}, 0))`);
    const [c] = await tx
      .select({ id: schema.creators.id, name: schema.creators.name })
      .from(schema.creators)
      .where(and(eq(schema.creators.telegramLinkHash, hash), gt(schema.creators.telegramLinkExpiresAt, now)));
    if (!c) return { status: "invalid" } as const;
    const [other] = await tx
      .select({ id: schema.creators.id })
      .from(schema.creators)
      .where(and(eq(schema.creators.telegramChatId, chatId), ne(schema.creators.id, c.id)))
      .limit(1);
    if (other) return { status: "chat_taken" } as const;
    // The UPDATE rechecks the hash and expiry: the same code redeemed from two chats at the same time only works once.
    const done = await tx
      .update(schema.creators)
      .set({ telegramChatId: chatId, telegramLinkHash: null, telegramLinkExpiresAt: null })
      .where(and(eq(schema.creators.id, c.id), eq(schema.creators.telegramLinkHash, hash), gt(schema.creators.telegramLinkExpiresAt, now)))
      .returning({ id: schema.creators.id });
    return done.length === 1 ? ({ status: "linked", name: c.name } as const) : ({ status: "invalid" } as const);
  });
}
