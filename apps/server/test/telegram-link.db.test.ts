import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

// Linking the creator's Telegram against a real Postgres: the route that issues the code (createApp + signSession), redemption by
// the bot (processUpdate with a fake Telegram and the real database) and the notices that then go to the linked chat.
// Only runs with TEST_DATABASE_URL (DISPOSABLE database already migrated: `db:migrate`); see the header of platform-status.db.test.ts.
// No real token: the Telegram one below is fake and the global fetch is swapped, so nothing goes out to the network.

const url = process.env.TEST_DATABASE_URL;
const P = "tgl";
const FAKE_TOKEN = "000000:token-de-mentira";
const ADMIN_CHAT = "777000";
const AGENT = "0".repeat(24) + "7e1e0001";

describe("Telegram linking with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let eq: typeof import("drizzle-orm").eq;
  let like: typeof import("drizzle-orm").like;
  let rules: typeof import("../src/telegram/link-rules.js");
  let store: typeof import("../src/telegram/link-store.js");
  let poller: typeof import("../src/telegram/poller.js");
  let notify: typeof import("../src/submissions/notify.js");
  let tg: typeof import("../src/notify/telegram.js");
  let cookie: (wallet: string) => Promise<string>;
  let server: Server;
  let base = "";
  const realFetch = globalThis.fetch;
  const outgoing: { chat_id: string; text: string }[] = [];

  const sent: { chatId: string | number; text: string }[] = [];
  const fakeApi = {
    getMe: async () => ({ username: "solvers_bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId: string | number, text: string) => void sent.push({ chatId, text }),
    deleteWebhook: async () => undefined,
  };

  const W = (n: string) => `${P}-wallet-${n}`;
  const ID = (n: string) => `${P}-creator-${n}`;
  const call = async (wallet: string | null, path = "/api/creator/telegram-link", method = "POST") =>
    fetch(`${base}${path}`, { method, headers: wallet ? { cookie: await cookie(wallet) } : {} });
  const row = async (n: string) => (await db.select().from(schema.creators).where(eq(schema.creators.id, ID(n))))[0]!;
  const dm = (chat: number, text: string, id = 1) => ({ update_id: id, message: { message_id: id, text, chat: { id: chat, type: "private" } } });
  const deps = () => ({ api: fakeApi, redeem: store.redeemLinkCode, botUsername: "solvers_bot", limiter: rules.createFailureLimiter(), log: () => undefined });
  const link = async (wallet: string) => ((await (await call(wallet)).json()) as { code: string }).code;

  async function addCreator(n: string, name = `Criador ${n}`) {
    await db.insert(schema.creators).values({ id: ID(n), wallet: W(n), name, invited: true, termsAcceptedAt: new Date() });
  }
  async function cleanup() {
    await db.delete(schema.agents).where(like(schema.agents.slug, `${P}%`));
    await db.delete(schema.creators).where(like(schema.creators.id, `${P}%`));
  }

  before(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url,
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
    });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    ({ eq, like } = await import("drizzle-orm"));
    rules = await import("../src/telegram/link-rules.js");
    store = await import("../src/telegram/link-store.js");
    poller = await import("../src/telegram/poller.js");
    notify = await import("../src/submissions/notify.js");
    tg = await import("../src/notify/telegram.js");
    const { setTelegramApiForTests } = await import("../src/telegram/client.js");
    setTelegramApiForTests(fakeApi);
    const { createApp } = await import("../src/app.js");
    const { creatorRouter } = await import("../src/creator/routes.js");
    const { signSession, SESSION_COOKIE } = await import("../src/auth/jwt.js");
    cookie = async (wallet) => `${SESSION_COOKIE}=${await signSession(wallet)}`;
    await cleanup();
    for (const n of ["a", "b", "limit", "swap", "race", "exp", "notify", "plain"]) await addCreator(n, n === "a" ? "Ana Souza" : `Criador ${n}`);
    await new Promise<void>((resolve) => {
      server = createApp([(app) => app.use("/api", creatorRouter)]).listen(0, "127.0.0.1", () => resolve(undefined));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Telegram is never really called: the notice (sendTelegram) lands in this fetch, local calls pass straight through.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith("https://api.telegram.org/")) {
        outgoing.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    server?.close();
    const { setTelegramApiForTests } = await import("../src/telegram/client.js");
    setTelegramApiForTests(undefined);
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  it("no creator profile: 403 profile_required, and nothing is written", async () => {
    const res = await call(W("sem-perfil"));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "profile_required");
    assert.equal((await db.select().from(schema.creators).where(eq(schema.creators.wallet, W("sem-perfil")))).length, 0);
  });

  it("issues the code: format, 15-minute validity, bot and deep link; only the hash is stored in the database", async () => {
    const before = Date.now();
    const res = await call(W("a"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { code: string; expiresAt: string; botUsername: string; deepLink: string };
    assert.match(body.code, /^LINK-[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(body.botUsername, "solvers_bot");
    assert.equal(body.deepLink, `https://t.me/solvers_bot?start=${body.code}`);
    const left = new Date(body.expiresAt).getTime() - before;
    assert.ok(left > 14 * 60_000 && left <= 15 * 60_000 + 5000, `validity ${left} ms`);
    const c = await row("a");
    assert.equal(c.telegramLinkHash, rules.hashLinkCode(body.code));
    assert.deepEqual(c.telegramLinkExpiresAt, new Date(body.expiresAt));
    assert.equal(c.telegramChatId, null, "issuing the code links nothing");
    for (const v of Object.values(c)) assert.ok(typeof v !== "string" || !v.includes(body.code.slice(5)), "the code itself is not stored");
    assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN), "the response does not include the token");
  });

  it("no login: 401", async () => {
    assert.equal((await call(null)).status, 401);
  });

  it("limit: 5 codes per hour per creator, the 6th gets 429 and another creator is not affected", async () => {
    for (let i = 1; i <= 5; i++) assert.equal((await call(W("limit"))).status, 200, `code ${i}`);
    const sixth = await call(W("limit"));
    assert.equal(sixth.status, 429);
    const body = (await sixth.json()) as { code: string; retryAfterSec: number };
    assert.equal(body.code, "too_many_codes");
    assert.ok(body.retryAfterSec > 3000 && body.retryAfterSec <= 3600);
    assert.equal((await row("limit")).telegramLinkCount, 5, "the refused code does not use up quota");
    assert.equal((await call(W("b"))).status, 200);
  });

  it("after one hour the window resets (injected clock)", async () => {
    const t = new Date(Date.now() + 61 * 60_000);
    const r = await store.issueLinkCode(W("limit"), t);
    assert.equal(r.status, "ok");
    assert.equal((await row("limit")).telegramLinkCount, 1);
  });

  it("a new code cancels the previous one", async () => {
    const first = await link(W("swap"));
    const second = await link(W("swap"));
    assert.notEqual(first, second);
    assert.deepEqual(await store.redeemLinkCode("9001", first), { status: "invalid" });
    assert.deepEqual(await store.redeemLinkCode("9001", second), { status: "linked", name: "Criador swap" });
  });

  it("the bot receives /vincular: stores the chat, deletes the code, replies with the name and the site now sees the verified contact", async () => {
    const me0 = (await (await call(W("a"), "/api/creator/me", "GET")).json()) as { contactVerified: boolean; telegramBot: { username: string } | null };
    assert.equal(me0.contactVerified, false);
    assert.deepEqual(me0.telegramBot, { username: "solvers_bot" });

    const code = await link(W("a"));
    sent.length = 0;
    // Typed in lowercase and without the prefix: the bot understands it.
    const out = await poller.processUpdate(dm(5551, `/vincular ${code.slice(5).toLowerCase()}`), deps());
    assert.equal(out, "replied");
    assert.deepEqual(sent, [{ chatId: "5551", text: "Done! Your Telegram is now linked to Solvers as Ana Souza." }]);
    const c = await row("a");
    assert.equal(c.telegramChatId, "5551");
    assert.equal(c.telegramLinkHash, null);
    assert.equal(c.telegramLinkExpiresAt, null);
    const me = (await (await call(W("a"), "/api/creator/me", "GET")).json()) as { contactVerified: boolean };
    assert.equal(me.contactVerified, true);
  });

  it("single use: the same code does not link again; a wrong code reveals nothing", async () => {
    const code = await link(W("b"));
    sent.length = 0;
    await poller.processUpdate(dm(5552, `/start ${code}`), deps());
    assert.match(sent[0]!.text, /^Done! .* as Criador b\.$/);
    await poller.processUpdate(dm(5553, `/vincular ${code}`), deps());
    await poller.processUpdate(dm(5553, "/vincular LINK-ZZZZ2222"), deps());
    assert.equal(sent[1]!.text, rules.replyText({ kind: "invalid" }));
    assert.equal(sent[2]!.text, sent[1]!.text, "used and nonexistent get the same reply");
    assert.equal((await row("b")).telegramChatId, "5552", "the 2nd chat did not replace the 1st");
  });

  it("expired code: refused and the chat is not stored", async () => {
    const code = await link(W("exp"));
    await db.update(schema.creators).set({ telegramLinkExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.creators.id, ID("exp")));
    assert.deepEqual(await store.redeemLinkCode("5560", code), { status: "invalid" });
    assert.equal((await row("exp")).telegramChatId, null);
  });

  it("a chat can belong to only ONE creator: the second is refused and their code stays valid", async () => {
    const code = await link(W("plain"));
    sent.length = 0;
    await poller.processUpdate(dm(5551, `/vincular ${code}`), deps()); // 5551 already belongs to Ana
    assert.equal(sent[0]!.text, rules.replyText({ kind: "chat_taken" }));
    const c = await row("plain");
    assert.equal(c.telegramChatId, null);
    assert.ok(c.telegramLinkHash, "the code was not used up");
    // Another Telegram account works with the same code.
    assert.deepEqual(await store.redeemLinkCode("5570", code), { status: "linked", name: "Criador plain" });
  });

  it("the same creator can relink from the same chat or another one (account switch)", async () => {
    const again = await link(W("a"));
    assert.deepEqual(await store.redeemLinkCode("5551", again), { status: "linked", name: "Ana Souza" });
    const other = await link(W("a"));
    assert.deepEqual(await store.redeemLinkCode("5599", other), { status: "linked", name: "Ana Souza" });
    assert.equal((await row("a")).telegramChatId, "5599");
  });

  it("the same code in two chats at the same time works only once", async () => {
    const code = await link(W("race"));
    const results = await Promise.all(["6001", "6002", "6003", "6004"].map((chat) => store.redeemLinkCode(chat, code)));
    assert.equal(results.filter((r) => r.status === "linked").length, 1);
    assert.equal(results.filter((r) => r.status === "invalid").length, 3);
    assert.ok(["6001", "6002", "6003", "6004"].includes((await row("race")).telegramChatId!));
  });

  it("notices: a linked creator receives them in their chat; without a link the request goes to the admin chat", async () => {
    await db.insert(schema.agents).values({
      id: AGENT, slug: `${P}-agente`, name: "Agente de teste", tagline: "t", description: "d", category: "Outros",
      creatorId: ID("notify"), version: "1.0.0", versionHash: "ab".repeat(32), price: 5_000_000n, status: "active", listed: true,
    });
    outgoing.length = 0;
    // No Telegram linked yet: nothing for the creator (review) and the buyer's request goes to the admin.
    await notify.notifyCreatorWallet(W("notify"), "revisão 1");
    await tg.notifyCreator(AGENT, "chamado 1");
    assert.deepEqual(outgoing.map((o) => [String(o.chat_id), o.text]), [[ADMIN_CHAT, "chamado 1"]]);

    // The creator links later: the next messages go to them.
    const code = await link(W("notify"));
    assert.equal((await store.redeemLinkCode("8123", code)).status, "linked");
    outgoing.length = 0;
    await notify.notifyCreatorWallet(W("notify"), "revisão 2");
    await tg.notifyCreator(AGENT, "chamado 2");
    assert.deepEqual(outgoing.map((o) => [String(o.chat_id), o.text]), [["8123", "revisão 2"], ["8123", "chamado 2"]]);
  });
});
