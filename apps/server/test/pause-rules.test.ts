import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PAUSE_FLAGS } from "@solvers/shared";
import { HttpError } from "../src/lib/http.js";
import { assertNotPaused, createCachedReader, pauseDecision, PAUSED_MESSAGE } from "../src/store/pause-rules.js";

// Emergency pause on the server: pure decision + short cache, no network. Unreadable flags never block (fail-open).

const run = (flags: number | null, bit: (typeof PAUSE_FLAGS)[keyof typeof PAUSE_FLAGS] = PAUSE_FLAGS.ENTRIES) => {
  const logs: string[] = [];
  let thrown: unknown = null;
  try {
    assertNotPaused(flags, bit, "purchase", (m) => logs.push(m));
  } catch (e) {
    thrown = e;
  }
  return { thrown, logs };
};

describe("assertNotPaused", () => {
  it("ENTRIES bit set: 503 platform_paused with the English message", () => {
    const { thrown } = run(PAUSE_FLAGS.ENTRIES);
    assert.ok(thrown instanceof HttpError);
    assert.equal(thrown.status, 503);
    assert.equal(thrown.code, "platform_paused");
    assert.equal(thrown.message, "Purchases are temporarily paused");
    assert.equal(PAUSED_MESSAGE, "Purchases are temporarily paused");
  });

  it("other bits alone do not block purchases; no pause continues without a log", () => {
    assert.deepEqual(run(PAUSE_FLAGS.PAYMENTS), { thrown: null, logs: [] });
    assert.deepEqual(run(PAUSE_FLAGS.TRANSFERS), { thrown: null, logs: [] });
    assert.deepEqual(run(0), { thrown: null, logs: [] });
  });

  it("each bit has its own code: payments_paused and transfers_paused", () => {
    assert.equal((run(PAUSE_FLAGS.PAYMENTS, PAUSE_FLAGS.PAYMENTS).thrown as HttpError).code, "payments_paused");
    assert.equal((run(PAUSE_FLAGS.TRANSFERS | PAUSE_FLAGS.ENTRIES, PAUSE_FLAGS.TRANSFERS).thrown as HttpError).code, "transfers_paused");
  });

  it("fail-open: unreadable flags continue and go to the log", () => {
    const { thrown, logs } = run(null);
    assert.equal(thrown, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /purchase.*unavailable/);
    assert.equal(pauseDecision(null, PAUSE_FLAGS.ENTRIES), "unknown");
    assert.equal(pauseDecision(7, PAUSE_FLAGS.TRANSFERS), "paused");
  });
});

describe("createCachedReader", () => {
  const setup = (results: Array<number | Error>) => {
    let t = 0;
    let calls = 0;
    const logs: string[] = [];
    const reader = createCachedReader<number>({
      fetch: async () => {
        const r = results[Math.min(calls++, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
      ttlMs: 10_000,
      failTtlMs: 2_000,
      now: () => t,
      log: (m) => logs.push(m),
    });
    return { reader, logs, calls: () => calls, advance: (ms: number) => (t += ms) };
  };

  it("reads once per 10 s window and concurrent requests share the read", async () => {
    const s = setup([0, 1]);
    const [a, b] = await Promise.all([s.reader.read(), s.reader.read()]);
    assert.equal(s.calls(), 1);
    assert.equal(a, b);
    s.advance(9_999);
    assert.equal(await s.reader.read(), 0);
    assert.equal(s.calls(), 1);
    s.advance(1);
    assert.equal(await s.reader.read(), 1);
    assert.equal(s.calls(), 2);
  });

  it("a failed read returns null (fail-open), is logged and lasts only 2 s", async () => {
    const s = setup([new Error("fetch failed"), 1]);
    assert.equal(await s.reader.read(), null);
    assert.match(s.logs[0]!, /fetch failed/);
    s.advance(1_999);
    assert.equal(await s.reader.read(), null);
    assert.equal(s.calls(), 1);
    s.advance(1);
    assert.equal(await s.reader.read(), 1);
    assert.equal(s.calls(), 2);
  });

  it("invalidate() (the indexer saw PauseChanged/ConfigUpdated) forces a new read and drops an inflight one", async () => {
    const s = setup([0, 1]);
    await s.reader.read();
    s.reader.invalidate();
    assert.equal(await s.reader.read(), 1);
    assert.equal(s.calls(), 2);
  });
});
