import { desc, eq, sql } from "drizzle-orm";
import { isAddress } from "@solvers/shared";
import { db, pool, schema } from "../db/index.js";
import { generateInviteCode, normalizeInviteCode } from "../submissions/rules.js";

// Creator invites and Telegram linking (PACKAGE_SPEC.md 14.1). Run it on the server (or through the database tunnel).
// With pnpm do NOT add the extra `--`: pnpm passes it on to the script and the command breaks. In apps/server:
//
//   pnpm cli:invite create [--email someone@x.com] [--note "who"] [--count 3]   # generates code(s); you e-mail them
//   pnpm cli:invite list                                                         # all of them, with who used them
//   pnpm cli:invite revoke <code>                                                # deletes an unused invite
//   pnpm cli:invite set-chat <wallet> <chatId>                                   # admin shortcut: links the creator's Telegram
//
// From the repository root: `pnpm --filter @solvers/server cli:invite create ...` (same form, no `--`).
// Creators normally link it themselves on the site (POST /creator/telegram-link + /vincular in the bot); `set-chat` is the shortcut.

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function create() {
  const count = Math.max(1, Math.min(50, Number(opt("--count") ?? 1) || 1));
  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    await db.insert(schema.creatorInvites).values({ code, email: opt("--email") ?? null, note: opt("--note") ?? null });
    console.log(code);
  }
}

async function list() {
  const rows = await db.select().from(schema.creatorInvites).orderBy(desc(schema.creatorInvites.createdAt));
  if (rows.length === 0) return console.log("no invites");
  for (const r of rows) {
    const state = r.usedAt ? `used by ${r.wallet} at ${r.usedAt.toISOString()}` : "free";
    console.log(`${r.code}  ${state}${r.email ? `  <${r.email}>` : ""}${r.note ? `  (${r.note})` : ""}`);
  }
}

async function revoke() {
  const code = normalizeInviteCode(rest[0] ?? "");
  if (!code) throw new Error("usage: revoke <code>");
  const gone = await db.delete(schema.creatorInvites).where(sql`${schema.creatorInvites.code} = ${code} and ${schema.creatorInvites.usedAt} is null`).returning({ code: schema.creatorInvites.code });
  if (gone.length === 0) {
    const [row] = await db.select().from(schema.creatorInvites).where(eq(schema.creatorInvites.code, code));
    throw new Error(row ? "this invite was already used and cannot be revoked" : "invite not found");
  }
  console.log(`invite ${code} revoked`);
}

async function setChat() {
  const [wallet, chatId] = rest;
  if (!wallet || !chatId) throw new Error("usage: set-chat <wallet> <chatId>");
  if (!isAddress(wallet)) throw new Error(`"${wallet}" is not a wallet address`);
  const upd = await db
    .update(schema.creators)
    .set({ telegramChatId: chatId })
    .where(eq(schema.creators.wallet, wallet.toLowerCase()))
    .returning({ id: schema.creators.id, name: schema.creators.name });
  if (upd.length === 0) throw new Error("no creator with this wallet (the creator must have saved the profile on the site)");
  console.log(`Telegram linked to ${upd[0]!.name} (${upd[0]!.id}); contact verified.`);
}

try {
  if (cmd === "create") await create();
  else if (cmd === "list") await list();
  else if (cmd === "revoke") await revoke();
  else if (cmd === "set-chat") await setChat();
  else {
    console.error("usage: cli:invite create|list|revoke|set-chat (see the header of src/cli/invite.ts)");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
