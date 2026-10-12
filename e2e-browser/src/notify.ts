// Optional end-of-run summary to Telegram (plan §6 phase 5). Opt-in: only with E2E_TELEGRAM=1 AND the bot token and
// chat id in the environment (the server's TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID names). Never on by default.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DIR } from "./env.js";

type Summary = { status: string; tests: { title: string; project: string; status: string; txs: { chain: string; label: string; hash: string; link: string | null }[] }[] };

export async function notifyTelegram(mode: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (process.env.E2E_TELEGRAM !== "1" || !token || !chat) return;
  const file = join(REPORT_DIR, "summary.json");
  if (!existsSync(file)) return;
  const s = JSON.parse(readFileSync(file, "utf8")) as Summary;
  const lines = [`Browser e2e (${mode}): ${s.status.toUpperCase()} ${s.tests.filter((t) => t.status === "PASS").length}/${s.tests.length}`];
  for (const t of s.tests) {
    lines.push(`${t.status} ${t.title}`);
    for (const x of t.txs) if (x.link) lines.push(`  ${x.chain} ${x.label}: ${x.link}`);
  }
  const text = lines.join("\n").slice(0, 4000);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  }).catch((e: Error) => e);
  console.log(`[e2e-browser] Telegram summary: ${res instanceof Error ? `failed (${res.message})` : res.ok ? "sent" : `failed (HTTP ${res.status})`}`);
}
