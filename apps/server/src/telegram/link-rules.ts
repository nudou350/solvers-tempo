import { createHash, randomBytes } from "node:crypto";

// Pure rules for linking a creator's Telegram (PACKAGE_SPEC.md 14.1): short code, hash, expiry, hourly limit,
// parsing the bot command and choosing the reply. No database, network or env: tested in test/telegram-link-rules.test.ts.

/** No 0/O/1/I: the code is typed or pasted from the site. 32 symbols, so `byte % 32` has no bias. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_PREFIX = "LINK-";
export const LINK_CHARS = 8;
export const LINK_TTL_MS = 15 * 60_000;
export const LINK_MAX_PER_WINDOW = 5;
export const LINK_WINDOW_MS = 60 * 60_000;
/** Wrong attempts per chat (per hour) before the bot stops checking codes. */
export const CHAT_MAX_FAILURES = 10;

/** `LINK-` + 8 characters (40 bits), valid for 15 min, single use and stored only as a hash: brute force does not pay off. */
export function generateLinkCode(bytes: Uint8Array = randomBytes(LINK_CHARS)): string {
  return LINK_PREFIX + Array.from(bytes.slice(0, LINK_CHARS), (b) => ALPHABET[b % ALPHABET.length]!).join("");
}

/**
 * Turns what the person pasted into the canonical code (`LINK-XXXXXXXX`), or null if it does not match the format. Accepts it
 * without the prefix, in lowercase, or with spaces or hyphens in between.
 */
export function normalizeLinkCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s\-_]/g, "");
  const body = s.length === LINK_PREFIX.length - 1 + LINK_CHARS && s.startsWith("LINK") ? s.slice(4) : s;
  if (body.length !== LINK_CHARS) return null;
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return LINK_PREFIX + body;
}

/** Hash of the canonical code (the database never stores the code). */
export const hashLinkCode = (code: string): string => createHash("sha256").update(`telegram-link:${code}`).digest("hex");

export const linkExpiry = (now: Date): Date => new Date(now.getTime() + LINK_TTL_MS);

/** Is the code still valid (exists and has not expired)? */
export const linkIsLive = (expiresAt: Date | null | undefined, now: Date): boolean => expiresAt != null && expiresAt.getTime() > now.getTime();

export type IssueWindow = { windowStart: Date | null; count: number };
export type IssuePlan = { ok: true; windowStart: Date; count: number } | { ok: false; retryAfterSec: number };

/** At most 5 codes per hour per creator: a 1 h window that starts at the first code and resets when it ends. */
export function planIssue(state: IssueWindow, now: Date): IssuePlan {
  const start = state.windowStart;
  if (!start || now.getTime() - start.getTime() >= LINK_WINDOW_MS || state.count < 0) return { ok: true, windowStart: now, count: 1 };
  if (state.count >= LINK_MAX_PER_WINDOW) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((start.getTime() + LINK_WINDOW_MS - now.getTime()) / 1000)) };
  return { ok: true, windowStart: start, count: state.count + 1 };
}

export const deepLinkOf = (botUsername: string, code: string): string => `https://t.me/${botUsername}?start=${code}`;

// ---------------------------------------------------------------------------------------------------------------
// Bot commands

export type Command = { kind: "link"; command: "start" | "link" | "vincular"; arg: string } | { kind: "other" };

/**
 * `/link CODE` (English, the default), `/vincular CODE` (Portuguese alias), `/start CODE` (deep link) and the `/link@mybot CODE` forms. In a group, a command
 * addressed to another bot (`@otherbot`) is not ours. Any other text becomes `other` (the bot replies with help).
 */
export function parseCommand(text: string, botUsername?: string | null): Command {
  const m = /^\/(start|link|vincular)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return { kind: "other" };
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return { kind: "other" };
  // Only the first word counts: "/link LINK-ABCD2345 thanks" still links.
  const arg = (m[3] ?? "").trim().split(/\s+/)[0] ?? "";
  return { kind: "link", command: m[1]!.toLowerCase() as "start" | "link" | "vincular", arg };
}

/** Limit on wrong attempts per chat (in memory, only in the bot's process). */
export function createFailureLimiter(max = CHAT_MAX_FAILURES, windowMs = LINK_WINDOW_MS) {
  const hits = new Map<string, number[]>();
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  return {
    blocked: (key: string, now: number): boolean => recent(key, now).length >= max,
    fail(key: string, now: number): void {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    },
    clear: (key: string): void => void hits.delete(key),
  };
}

export type LinkOutcome =
  | { kind: "linked"; name: string }
  | { kind: "invalid" } // wrong, expired or already used code: does not say which
  | { kind: "chat_taken" }
  | { kind: "throttled" }
  | { kind: "usage" }
  | { kind: "help" };

/** The bot's reply as plain text (no formatting, so it does not depend on Telegram escaping). */
export function replyText(o: LinkOutcome): string {
  switch (o.kind) {
    case "linked":
      return `Done! Your Telegram is now linked to Solvers as ${o.name}.`;
    case "invalid":
      return "That code isn't valid: it may be wrong, expired or already used. Generate a new one on the site, under Creator > Publish, and send it here.";
    case "chat_taken":
      return "This Telegram account is already linked to another Solvers creator. Use another Telegram account or contact the team.";
    case "throttled":
      return "Too many attempts with a wrong code. Wait an hour and generate a new code on the site.";
    case "usage":
      return "Send the command with the code shown on the site, like this: /link LINK-ABCD2345";
    case "help":
      return "To link your Telegram, generate a code on the Solvers site (Creator > Publish) and send it here: /link YOUR-CODE";
  }
}
