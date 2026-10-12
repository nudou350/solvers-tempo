import { env } from "../env.js";
import { createTelegramApi, type TelegramApi } from "./api.js";

// The Solvers bot for this process: `null` when TELEGRAM_BOT_TOKEN is not configured. The bot's @username comes from
// `getMe` and is cached (the link route and GET /creator/me do not call Telegram on every request).

let real: TelegramApi | null = null;
let override: TelegramApi | null | undefined;

export function telegramApi(): TelegramApi | null {
  if (override !== undefined) return override;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  real ??= createTelegramApi(env.TELEGRAM_BOT_TOKEN);
  return real;
}

/** Tests only: swaps (or, with `undefined`, restores) the Telegram client and clears the @username cache. */
export function setTelegramApiForTests(api: TelegramApi | null | undefined): void {
  override = api;
  cache = null;
}

const OK_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 30_000;
let cache: { api: TelegramApi; username: string | null; at: number } | null = null;

/** The bot's @username (without the @), or null if the bot is not configured or Telegram did not answer (a failure stays cached for 30 s). */
export async function botUsername(api: TelegramApi | null = telegramApi(), now: () => number = Date.now): Promise<string | null> {
  if (!api) return null;
  if (cache && cache.api === api && now() - cache.at < (cache.username ? OK_TTL_MS : FAIL_TTL_MS)) return cache.username;
  let username: string | null = null;
  try {
    username = (await api.getMe()).username;
  } catch (e) {
    console.warn("[telegram] getMe failed:", (e as Error).message);
  }
  cache = { api, username, at: now() };
  return username;
}
