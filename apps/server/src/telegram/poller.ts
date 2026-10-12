import type { TelegramApi, TgUpdate } from "./api.js";
import { createFailureLimiter, parseCommand, replyText, type LinkOutcome } from "./link-rules.js";
import type { RedeemResult } from "./link-store.js";

// The bot loop (getUpdates long polling) that handles `/vincular <code>` and `/start <code>` (deep link from the site). Runs only
// in the solvers-tempo-worker process, the ONLY one that polls (two pollers with the same token knock each other out with 409). Nothing
// here reads env or the database: Telegram and code redemption come in through `PollDeps`, and the test uses fakes.

export type PollDeps = {
  api: TelegramApi;
  redeem: (chatId: string, code: string, now: Date) => Promise<RedeemResult>;
  now?: () => Date;
  /** The bot's @username, to ignore `/vincular@otherbot` in groups. */
  botUsername?: string | null;
  limiter?: ReturnType<typeof createFailureLimiter>;
  log?: (msg: string) => void;
};

const toOutcome = (r: RedeemResult): LinkOutcome => (r.status === "linked" ? { kind: "linked", name: r.name } : r.status === "chat_taken" ? { kind: "chat_taken" } : { kind: "invalid" });

/** Handles one update. Only private chats with text count; everything else is silently ignored. */
export async function processUpdate(update: TgUpdate, deps: PollDeps): Promise<"ignored" | "replied"> {
  const m = update.message;
  if (!m || m.chat.type !== "private" || typeof m.text !== "string") return "ignored";
  const chatId = String(m.chat.id);
  const now = (deps.now ?? (() => new Date()))();
  const limiter = deps.limiter ?? defaultLimiter;
  const cmd = parseCommand(m.text, deps.botUsername);

  let outcome: LinkOutcome;
  if (cmd.kind === "other" || (cmd.arg === "" && cmd.command === "start")) outcome = { kind: "help" };
  else if (cmd.arg === "") outcome = { kind: "usage" };
  else if (limiter.blocked(chatId, now.getTime())) outcome = { kind: "throttled" };
  else {
    const result = await deps.redeem(chatId, cmd.arg, now);
    outcome = toOutcome(result);
    if (result.status === "linked") limiter.clear(chatId);
    else if (result.status === "invalid") limiter.fail(chatId, now.getTime());
  }
  await deps.api.sendMessage(chatId, replyText(outcome));
  return "replied";
}

const defaultLimiter = createFailureLimiter();

export type PollOptions = { timeoutSec?: number; backoffMinMs?: number; backoffMaxMs?: number };

const sleep = (ms: number, stopped: () => boolean) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    const tick = setInterval(() => stopped() && done(), 250);
    function done() {
      clearTimeout(t);
      clearInterval(tick);
      resolve();
    }
  });

/**
 * The bot loop: getUpdates with long polling (~25 s), offset kept only in memory (an update repeated after a restart only
 * produces one extra reply, with no effect: the code is single use), exponential backoff on errors and a clean stop (SIGTERM).
 * Without a client (TELEGRAM_BOT_TOKEN missing) the loop stays off.
 */
export async function runTelegramPolling(stopped: () => boolean, deps: Omit<PollDeps, "api"> & { api: TelegramApi | null }, opts: PollOptions = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(`[telegram] ${m}`));
  const { api } = deps;
  if (!api) {
    log("TELEGRAM_BOT_TOKEN not set: the linking bot stays off");
    return;
  }
  const full: PollDeps = { ...deps, api, log };
  const timeoutSec = opts.timeoutSec ?? 25;
  const backoffMin = opts.backoffMinMs ?? 1000;
  const backoffMax = opts.backoffMaxMs ?? 60_000;
  let backoff = backoffMin;
  let offset = 0;
  let webhookCleared = false;
  log("listening to the bot (getUpdates)");

  while (!stopped()) {
    const ac = new AbortController();
    const watch = setInterval(() => stopped() && ac.abort(), 250);
    let updates: TgUpdate[];
    try {
      updates = await api.getUpdates({ offset, timeoutSec, signal: ac.signal });
      backoff = backoffMin;
    } catch (e) {
      if (stopped()) break;
      const err = e as Error & { status?: number };
      if (err.status === 409 && /webhook/i.test(err.message) && !webhookCleared) {
        // The bot had an active webhook (getUpdates and a webhook cannot coexist): remove it once and carry on.
        webhookCleared = true;
        log("active webhook on the bot: calling deleteWebhook (once)");
        await api.deleteWebhook().catch((d: Error) => log(`deleteWebhook failed: ${d.message}`));
        continue;
      }
      log(`getUpdates failed (${err.message}); retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff, stopped);
      backoff = Math.min(backoff * 2, backoffMax);
      continue;
    } finally {
      clearInterval(watch);
    }
    for (const u of updates) {
      // The offset advances even if handling fails: one bad message must not stall the loop.
      offset = Math.max(offset, u.update_id + 1);
      try {
        await processUpdate(u, full);
      } catch (e) {
        log(`failed to handle update ${u.update_id}: ${(e as Error).message}`);
      }
    }
  }
}
