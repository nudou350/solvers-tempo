import { env } from "../env.js";
import { sendTelegram } from "../notify/telegram.js";

// Admin alerts of the payments module (Telegram admin chat). Throttled per key so a stuck charge or a low float does not
// flood the chat every 30 s; without a bot token the alert is only logged.

const last = new Map<string, number>();

export async function alertAdmin(key: string, text: string, opts: { everyMs?: number; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const every = opts.everyMs ?? 60 * 60_000;
  const prev = last.get(key);
  if (prev !== undefined && now - prev < every) return false;
  last.set(key, now);
  console.warn(`[payments] ALERT ${key}: ${text}`);
  return sendTelegram(env.TELEGRAM_ADMIN_CHAT_ID ?? null, `Solvers payments: ${text}`);
}

/** Test hook. */
export function resetAlerts(): void {
  last.clear();
}
