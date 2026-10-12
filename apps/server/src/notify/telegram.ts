import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { randomId } from "../lib/crypto.js";

// Human fallback and creator notifications (INSTRUCTIONS.md 5.8) via the Telegram bot.
// Without a configured token, notifications are only recorded in the database (the demo does not break).

export async function sendTelegram(chatId: string | null | undefined, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (e) {
    console.warn("[notify] Telegram failure:", (e as Error).message);
    return false;
  }
}

async function creatorChat(agentId: string): Promise<string | null> {
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) return env.TELEGRAM_ADMIN_CHAT_ID ?? null;
  const [creator] = await db.select().from(schema.creators).where(eq(schema.creators.id, agent.creatorId));
  return creator?.telegramChatId ?? env.TELEGRAM_ADMIN_CHAT_ID ?? null;
}

export async function notifyCreator(agentId: string, text: string) {
  return sendTelegram(await creatorChat(agentId), text);
}

/** Opens a ticket for the human creator and returns the protocol number. */
export async function escalate(wallet: string, agentId: string, sessionId: string | null, summary: string) {
  const id = `SLV-${randomId(3).toUpperCase()}`;
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const notified = await notifyCreator(
    agentId,
    `Solvers: new help request ${id}\nSolver: ${agent?.name ?? agentId}\nWallet: ${wallet.slice(0, 4)}…${wallet.slice(-4)}\n\n${summary.slice(0, 3000)}`,
  );
  await db.insert(schema.escalations).values({ id, wallet, agentId, sessionId, summary: summary.slice(0, 8000), notified });
  return { protocol: id, notified };
}
