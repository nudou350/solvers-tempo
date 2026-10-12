import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createTelegramApi, TelegramApiError, type TelegramApi, type TgUpdate } from "../src/telegram/api.js";
import {
  CHAT_MAX_FAILURES,
  createFailureLimiter,
  deepLinkOf,
  generateLinkCode,
  hashLinkCode,
  LINK_MAX_PER_WINDOW,
  LINK_TTL_MS,
  LINK_WINDOW_MS,
  linkExpiry,
  linkIsLive,
  normalizeLinkCode,
  parseCommand,
  planIssue,
  replyText,
} from "../src/telegram/link-rules.js";
import { processUpdate, runTelegramPolling, type PollDeps } from "../src/telegram/poller.js";

// Pure rules of Telegram linking, the handling of one update and the bot loop, all without network or database.

const T0 = new Date("2026-10-02T12:00:00Z");
const BOT_TOKEN = "123456:SECRET-TOKEN-VALUE";

describe("link code", () => {
  it("has the format LINK- + 8 unambiguous characters and varies on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateLinkCode();
      assert.match(c, /^LINK-[A-HJ-NP-Z2-9]{8}$/);
      seen.add(c);
    }
    assert.ok(seen.size > 190);
    assert.equal(generateLinkCode(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])), "LINK-ABCDEFGH");
  });

  it("normalizes what the person pasted: optional prefix, lowercase, spaces and hyphens; refuses the rest", () => {
    for (const raw of ["LINK-ABCD2345", "link-abcd2345", "  ABCD2345 ", "LINK ABCD 2345", "link_abcd-2345", "LINKABCD2345"]) assert.equal(normalizeLinkCode(raw), "LINK-ABCD2345", raw);
    // The alphabet has no I: no code body starts with LINK, so the prefix is never ambiguous.
    assert.equal(normalizeLinkCode("LINKABCD"), null);
    for (const bad of ["", "LINK-", "ABCD234", "ABCD23456", "LINK-ABCD234O", "LINK-ABCD2341", "LINK-ABCD234!", "SLV-ABCD-EFGH-JKLM"]) assert.equal(normalizeLinkCode(bad), null, bad);
  });

  it("the hash is stable, is not the code and changes with any character", () => {
    const h = hashLinkCode("LINK-ABCD2345");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, hashLinkCode("LINK-ABCD2345"));
    assert.notEqual(h, hashLinkCode("LINK-ABCD2346"));
    assert.ok(!h.includes("ABCD2345"));
  });

  it("is valid for 15 minutes and is gone at the moment it expires", () => {
    const exp = linkExpiry(T0);
    assert.equal(exp.getTime() - T0.getTime(), 15 * 60_000);
    assert.equal(LINK_TTL_MS, 15 * 60_000);
    assert.equal(linkIsLive(exp, new Date(exp.getTime() - 1)), true);
    assert.equal(linkIsLive(exp, exp), false);
    assert.equal(linkIsLive(null, T0), false);
    assert.equal(linkIsLive(undefined, T0), false);
  });

  it("bot deep link", () => {
    assert.equal(deepLinkOf("solvers_bot", "LINK-ABCD2345"), "https://t.me/solvers_bot?start=LINK-ABCD2345");
  });
});

describe("limit of 5 codes per hour", () => {
  it("the first opens the window; the 1st to 5th pass; the 6th waits for the window to end", () => {
    let st = { windowStart: null as Date | null, count: 0 };
    for (let i = 1; i <= LINK_MAX_PER_WINDOW; i++) {
      const p = planIssue(st, new Date(T0.getTime() + i * 1000));
      assert.equal(p.ok, true, `code ${i}`);
      if (p.ok) st = { windowStart: p.windowStart, count: p.count };
    }
    assert.equal(st.count, 5);
    assert.deepEqual(st.windowStart, new Date(T0.getTime() + 1000));
    const blocked = planIssue(st, new Date(T0.getTime() + 600_000));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.retryAfterSec, (LINK_WINDOW_MS - 599_000) / 1000);
  });

  it("after 1 h the window resets", () => {
    const p = planIssue({ windowStart: T0, count: 5 }, new Date(T0.getTime() + LINK_WINDOW_MS));
    assert.deepEqual(p, { ok: true, windowStart: new Date(T0.getTime() + LINK_WINDOW_MS), count: 1 });
  });
});

describe("bot commands", () => {
  it("/link (English), /vincular (alias) and /start with a code (including @bot, letter case and text after the code)", () => {
    assert.deepEqual(parseCommand("/link LINK-ABCD2345"), { kind: "link", command: "link", arg: "LINK-ABCD2345" });
    assert.deepEqual(parseCommand("  /LINK   link-abcd2345  thanks "), { kind: "link", command: "link", arg: "link-abcd2345" });
    assert.deepEqual(parseCommand("/link@Solvers_Bot LINK-ABCD2345", "solvers_bot"), { kind: "link", command: "link", arg: "LINK-ABCD2345" });
    assert.deepEqual(parseCommand("/vincular LINK-ABCD2345"), { kind: "link", command: "vincular", arg: "LINK-ABCD2345" });
    assert.deepEqual(parseCommand("/start LINK-ABCD2345"), { kind: "link", command: "start", arg: "LINK-ABCD2345" });
    assert.deepEqual(parseCommand("  /VINCULAR   link-abcd2345  obrigado "), { kind: "link", command: "vincular", arg: "link-abcd2345" });
    assert.deepEqual(parseCommand("/vincular@Solvers_Bot LINK-ABCD2345", "solvers_bot"), { kind: "link", command: "vincular", arg: "LINK-ABCD2345" });
  });

  it("no code: empty arg; a command for another bot and any other text: other", () => {
    assert.deepEqual(parseCommand("/start"), { kind: "link", command: "start", arg: "" });
    assert.deepEqual(parseCommand("/vincular"), { kind: "link", command: "vincular", arg: "" });
    assert.deepEqual(parseCommand("/link"), { kind: "link", command: "link", arg: "" });
    assert.deepEqual(parseCommand("/link@outro_bot LINK-ABCD2345", "solvers_bot"), { kind: "other" });
    assert.deepEqual(parseCommand("/vincular@outro_bot LINK-ABCD2345", "solvers_bot"), { kind: "other" });
    for (const t of ["oi", "vincular LINK-ABCD2345", "/ajuda", "/vincularx LINK-ABCD2345", "/linkx LINK-ABCD2345", "link LINK-ABCD2345", "", "/start2 x"]) assert.deepEqual(parseCommand(t), { kind: "other" }, t);
  });
});

describe("replies", () => {
  it("the success text includes the name; the bad-code text does not reveal whether the code exists", () => {
    assert.equal(replyText({ kind: "linked", name: "Ana" }), "Done! Your Telegram is now linked to Solvers as Ana.");
    const bad = replyText({ kind: "invalid" });
    assert.match(bad, /wrong, expired or already used/);
    assert.match(replyText({ kind: "chat_taken" }), /another Solvers creator/);
    assert.match(replyText({ kind: "usage" }), /\/link LINK-ABCD2345/);
    assert.match(replyText({ kind: "help" }), /\/link YOUR-CODE/);
    assert.ok(replyText({ kind: "help" }).length < 200 && !replyText({ kind: "help" }).includes("\n"));
  });
});

describe("per-chat failure limiter", () => {
  it("blocks after 10 failures within the hour, unblocks later and resets on success", () => {
    const lim = createFailureLimiter();
    const t = T0.getTime();
    for (let i = 0; i < CHAT_MAX_FAILURES; i++) {
      assert.equal(lim.blocked("1", t + i), false);
      lim.fail("1", t + i);
    }
    assert.equal(lim.blocked("1", t + 100), true);
    assert.equal(lim.blocked("2", t + 100), false, "another chat is not affected");
    assert.equal(lim.blocked("1", t + LINK_WINDOW_MS + CHAT_MAX_FAILURES), false, "once the window has passed, it unblocks");
    lim.clear("1");
    assert.equal(lim.blocked("1", t + 100), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// processUpdate: what the bot replies to each update

type Sent = { chatId: string | number; text: string };
function fakeApi(over: Partial<TelegramApi> = {}) {
  const sent: Sent[] = [];
  const api: TelegramApi = {
    getMe: async () => ({ username: "solvers_bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => void sent.push({ chatId, text }),
    deleteWebhook: async () => undefined,
    ...over,
  };
  return { api, sent };
}
const msg = (text: string | undefined, chat: { id: number; type: string } = { id: 4242, type: "private" }, id = 1): TgUpdate => ({ update_id: id, message: { message_id: id, text, chat } });

describe("processUpdate", () => {
  const deps = (api: TelegramApi, redeem: PollDeps["redeem"]): PollDeps => ({ api, redeem, now: () => T0, botUsername: "solvers_bot", limiter: createFailureLimiter(), log: () => undefined });

  it("right code: redeems with the chat and the typed code and replies with the name", async () => {
    const { api, sent } = fakeApi();
    const calls: unknown[][] = [];
    const out = await processUpdate(msg("/vincular LINK-ABCD2345"), deps(api, async (...a) => (calls.push(a), { status: "linked", name: "Ana" })));
    assert.equal(out, "replied");
    assert.deepEqual(calls, [["4242", "LINK-ABCD2345", T0]]);
    assert.deepEqual(sent, [{ chatId: "4242", text: "Done! Your Telegram is now linked to Solvers as Ana." }]);
  });

  it("/link CODE (English) redeems just like /vincular", async () => {
    const { api, sent } = fakeApi();
    const calls: unknown[][] = [];
    await processUpdate(msg("/link LINK-ABCD2345"), deps(api, async (...x) => (calls.push(x), { status: "linked", name: "Ana" })));
    assert.deepEqual(calls, [["4242", "LINK-ABCD2345", T0]]);
    assert.equal(sent[0]!.text, "Done! Your Telegram is now linked to Solvers as Ana.");
  });

  it("deep link /start CODE works the same", async () => {
    const { api, sent } = fakeApi();
    await processUpdate(msg("/start LINK-ABCD2345"), deps(api, async () => ({ status: "linked", name: "Ana" })));
    assert.match(sent[0]!.text, /^Done!/);
  });

  it("wrong, expired or used code: the same short reply; another creator's chat: refused", async () => {
    const { api, sent } = fakeApi();
    await processUpdate(msg("/vincular LINK-ZZZZ2222"), deps(api, async () => ({ status: "invalid" })));
    await processUpdate(msg("/vincular LINK-ZZZZ2222"), deps(api, async () => ({ status: "chat_taken" })));
    assert.equal(sent[0]!.text, replyText({ kind: "invalid" }));
    assert.equal(sent[1]!.text, replyText({ kind: "chat_taken" }));
  });

  it("other messages: one-line help, without touching the database", async () => {
    const { api, sent } = fakeApi();
    const never: PollDeps["redeem"] = async () => assert.fail("should not redeem");
    await processUpdate(msg("oi, tudo bem?"), deps(api, never));
    await processUpdate(msg("/start"), deps(api, never));
    await processUpdate(msg("/vincular"), deps(api, never));
    assert.equal(sent[0]!.text, replyText({ kind: "help" }));
    assert.equal(sent[1]!.text, replyText({ kind: "help" }));
    assert.equal(sent[2]!.text, replyText({ kind: "usage" }));
  });

  it("only private chats with text: group, channel, a message without text and an update without a message are ignored", async () => {
    const { api, sent } = fakeApi();
    const never: PollDeps["redeem"] = async () => assert.fail("should not redeem");
    for (const u of [msg("/vincular LINK-ABCD2345", { id: -100, type: "group" }), msg("/vincular LINK-ABCD2345", { id: -200, type: "supergroup" }), msg("/vincular LINK-ABCD2345", { id: -300, type: "channel" }), msg(undefined), { update_id: 9 }]) {
      assert.equal(await processUpdate(u, deps(api, never)), "ignored");
    }
    assert.equal(sent.length, 0);
  });

  it("a command addressed to another bot is treated as a plain message", async () => {
    const { api, sent } = fakeApi();
    await processUpdate(msg("/vincular@outro_bot LINK-ABCD2345"), deps(api, async () => assert.fail("should not redeem")));
    assert.equal(sent[0]!.text, replyText({ kind: "help" }));
  });

  it("after 10 wrong codes the chat is no longer checked; a correct one resets the count", async () => {
    const { api, sent } = fakeApi();
    let redeems = 0;
    const d = deps(api, async () => (redeems++, { status: "invalid" }));
    for (let i = 0; i < CHAT_MAX_FAILURES + 3; i++) await processUpdate(msg(`/vincular LINK-ZZZZ222${i % 8 + 2}`), d);
    assert.equal(redeems, CHAT_MAX_FAILURES);
    assert.equal(sent.at(-1)!.text, replyText({ kind: "throttled" }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// runTelegramPolling

describe("runTelegramPolling", () => {
  const noBackoff = { timeoutSec: 1, backoffMinMs: 1, backoffMaxMs: 4 };

  it("without a client (no token) it stays off and logs once", async () => {
    const logs: string[] = [];
    await runTelegramPolling(() => false, { api: null, redeem: async () => ({ status: "invalid" }), log: (m) => logs.push(m) });
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /stays off/);
  });

  it("advances the offset, handles each update and stops when asked to", async () => {
    let stop = false;
    const offsets: number[] = [];
    const batches: TgUpdate[][] = [[msg("/vincular LINK-ABCD2345", undefined, 10), msg("oi", undefined, 11)], []];
    const { api, sent } = fakeApi({
      getUpdates: async ({ offset }) => {
        offsets.push(offset);
        const b = batches.shift();
        if (!b) {
          stop = true;
          return [];
        }
        return b;
      },
    });
    const redeemed: string[] = [];
    await runTelegramPolling(() => stop, { api, redeem: async (_c, code) => (redeemed.push(code), { status: "linked", name: "Ana" }), log: () => undefined }, noBackoff);
    assert.deepEqual(offsets, [0, 12, 12]);
    assert.deepEqual(redeemed, ["LINK-ABCD2345"]);
    assert.equal(sent.length, 2);
  });

  it("a failing update neither blocks the loop nor repeats: the offset advances", async () => {
    let stop = false;
    const offsets: number[] = [];
    const { api } = fakeApi({
      getUpdates: async ({ offset }) => {
        offsets.push(offset);
        if (offsets.length === 1) return [msg("/vincular LINK-ABCD2345", undefined, 5)];
        stop = true;
        return [];
      },
    });
    await runTelegramPolling(() => stop, { api, redeem: async () => Promise.reject(new Error("banco caiu")), log: () => undefined }, noBackoff);
    assert.deepEqual(offsets, [0, 6]);
  });

  it("network error: backoff and retry, without bringing the loop down", async () => {
    let stop = false;
    let calls = 0;
    const logs: string[] = [];
    const { api } = fakeApi({
      getUpdates: async () => {
        calls++;
        if (calls < 3) throw new TelegramApiError(0, "getUpdates: falha de rede");
        stop = true;
        return [];
      },
    });
    await runTelegramPolling(() => stop, { api, redeem: async () => ({ status: "invalid" }), log: (m) => logs.push(m) }, noBackoff);
    assert.equal(calls, 3);
    assert.equal(logs.filter((l) => l.includes("getUpdates failed")).length, 2);
  });

  it("409 from an active webhook: calls deleteWebhook ONCE and moves on; a second 409 only backs off", async () => {
    let stop = false;
    let calls = 0;
    let deletes = 0;
    const { api } = fakeApi({
      getUpdates: async () => {
        calls++;
        if (calls <= 2) throw new TelegramApiError(409, "getUpdates: Conflict: can't use getUpdates method while webhook is active");
        stop = true;
        return [];
      },
      deleteWebhook: async () => void deletes++,
    });
    await runTelegramPolling(() => stop, { api, redeem: async () => ({ status: "invalid" }), log: () => undefined }, noBackoff);
    assert.equal(deletes, 1);
    assert.equal(calls, 3);
  });

  it("409 from another poller (no webhook) does not call deleteWebhook", async () => {
    let stop = false;
    let calls = 0;
    let deletes = 0;
    const { api } = fakeApi({
      getUpdates: async () => {
        if (++calls === 1) throw new TelegramApiError(409, "getUpdates: Conflict: terminated by other getUpdates request");
        stop = true;
        return [];
      },
      deleteWebhook: async () => void deletes++,
    });
    await runTelegramPolling(() => stop, { api, redeem: async () => ({ status: "invalid" }), log: () => undefined }, noBackoff);
    assert.equal(deletes, 0);
  });

  it("SIGTERM during the long wait: aborts getUpdates and exits quickly", async () => {
    let stop = false;
    const { api } = fakeApi({
      getUpdates: ({ signal }) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => rej(new TelegramApiError(0, "getUpdates: interrompido", true)));
        }),
    });
    const t0 = Date.now();
    const run = runTelegramPolling(() => stop, { api, redeem: async () => ({ status: "invalid" }), log: () => undefined }, { timeoutSec: 25 });
    setTimeout(() => (stop = true), 100);
    await run;
    assert.ok(Date.now() - t0 < 2000, "did not wait the 25 s");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP client: the token never appears in an error

describe("createTelegramApi", () => {
  const ok = (result: unknown) => async () => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  it("calls the right method with the right body", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return ok(seen.length === 1 ? { username: "solvers_bot" } : [])();
    }) as unknown as typeof fetch;
    const api = createTelegramApi(BOT_TOKEN, f);
    assert.deepEqual(await api.getMe(), { username: "solvers_bot" });
    await api.getUpdates({ offset: 7, timeoutSec: 25 });
    assert.equal(seen[0]!.url, `https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    assert.deepEqual(seen[1]!.body, { offset: 7, timeout: 25, allowed_updates: ["message"] });
  });

  it("a Telegram error becomes a TelegramApiError with status and description, without the token", async () => {
    const f = (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }), { status: 401 })) as unknown as typeof fetch;
    const api = createTelegramApi(BOT_TOKEN, f);
    await assert.rejects(api.getMe(), (e: unknown) => {
      assert.ok(e instanceof TelegramApiError);
      assert.equal(e.status, 401);
      assert.ok(!e.message.includes("SECRET-TOKEN-VALUE"), e.message);
      return true;
    });
  });

  it("a network failure does not leak the token either", async () => {
    const f = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    }) as unknown as typeof fetch;
    await assert.rejects(createTelegramApi(BOT_TOKEN, f).sendMessage(1, "oi"), (e: unknown) => {
      assert.ok(e instanceof TelegramApiError);
      assert.equal(e.status, 0);
      assert.ok(!e.message.includes("SECRET-TOKEN-VALUE"), e.message);
      return true;
    });
  });
});
