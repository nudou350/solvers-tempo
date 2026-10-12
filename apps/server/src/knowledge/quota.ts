import { and, count, eq, gt, ne, or, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { sha256Hex } from "../lib/crypto.js";
import { QUOTA_WINDOW_MS, quotaExceeded, quotaText } from "./search-rules.js";

// Daily search_knowledge quota per wallet + specialist (PACKAGE_SPEC.md 6.5, item 2). Counts the
// `usage_events` rows the connector already writes on every call (no new table). "Limit reached"
// responses are not counted: otherwise every attempt would extend the block.

/** The wallet's queries to this specialist in the last 24 hours (excluding "limit reached" responses). */
export async function searchesInWindow(wallet: string, agentId: string, quota = env.SEARCH_DAILY_QUOTA, now = new Date()): Promise<number> {
  const blocked = sha256Hex(quotaText(quota));
  const [row] = await db
    .select({ n: count() })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.wallet, wallet),
        eq(schema.usageEvents.agentId, agentId),
        eq(schema.usageEvents.tool, "search_knowledge"),
        gt(schema.usageEvents.createdAt, new Date(now.getTime() - QUOTA_WINDOW_MS)),
        or(isNull(schema.usageEvents.responseHash), ne(schema.usageEvents.responseHash, blocked)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** "Daily limit reached" text if the wallet is already over the quota; null if it may query (or the quota is off). */
export async function searchQuotaBlock(wallet: string, agentId: string, quota = env.SEARCH_DAILY_QUOTA): Promise<string | null> {
  if (quota <= 0) return null;
  return quotaExceeded(await searchesInWindow(wallet, agentId, quota), quota) ? quotaText(quota) : null;
}
