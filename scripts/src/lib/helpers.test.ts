// Unit tests of the pure helpers of the scripts (no API, no chain).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childEnv, fmt, readEnvFile, units } from "../env.js";
import { gradeOutput, passes } from "./eval-rules.js";
import { expectedRoyalty } from "./flows.js";
import { ApiFailure, retryAfterSecs } from "./http.js";
import { sessionIdOf } from "./mcp.js";
import { assertEq } from "./report.js";

test("units / fmt use 6 decimals without float rounding", () => {
  assert.equal(units(19), 19_000_000n);
  assert.equal(units("0.95"), 950_000n);
  assert.equal(units("5.000001"), 5_000_001n);
  assert.equal(units("1.2345678"), 1_234_567n);
  assert.equal(fmt(1_900_000n), "1.9");
});

test("readEnvFile reads KEY=value lines, skips comments, strips quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "scripts-env-"));
  const f = join(dir, ".env");
  writeFileSync(f, '# comment\nPORT=3028\nNAME="quoted value"\n  SPACED = x \n# HIDDEN=1\n');
  assert.deepEqual(readEnvFile(f), { PORT: "3028", NAME: "quoted value", SPACED: "x" });
  assert.deepEqual(readEnvFile(join(dir, "missing")), {});
});

test("retryAfterSecs reads Retry-After, then the draft-8 RateLimit header, else 15", () => {
  assert.equal(retryAfterSecs(new Headers({ "retry-after": "7" })), 7);
  assert.equal(retryAfterSecs(new Headers({ ratelimit: '"costly";r=0;t=42' })), 43);
  assert.equal(retryAfterSecs(new Headers({ "retry-after": "500" })), 65);
  assert.equal(retryAfterSecs(new Headers()), 15);
});

test("ApiFailure exposes the API error code", () => {
  const e = new ApiFailure("POST", "/api/x", 409, { error: "sold", code: "sold_out" });
  assert.equal(e.code, "sold_out");
  assert.match(e.message, /POST \/api\/x -> 409/);
});

test("eval checks: regex, contains, not_contains (case-insensitive)", () => {
  assert.equal(passes({ type: "regex", value: "16\\.?000", description: "" }, "remaining 16.000"), true);
  assert.equal(passes({ type: "contains", value: "WCAG", description: "" }, "the wcag minimum"), true);
  assert.equal(passes({ type: "not_contains", value: "I guarantee", description: "" }, "I GUARANTEE it"), false);
  assert.deepEqual(gradeOutput([{ type: "contains", value: "x", description: "has x" }, { type: "contains", value: "y", description: "has y" }], "x alone"), ["has y"]);
});

test("sessionIdOf and assertEq", () => {
  assert.equal(sessionIdOf("session_id: ses_0a1b\nAccess: lifetime license."), "ses_0a1b");
  assert.equal(sessionIdOf("no session"), undefined);
  assert.doesNotThrow(() => assertEq({ a: 1n }, { a: 1n }, "same"));
  assert.throws(() => assertEq(1n, 2n, "amount"), /amount: expected "2n", got "1n"/);
});

test("childEnv: file values win over the shell, pinned variables and keys are dropped, QA needs 5546", () => {
  const dir = mkdtempSync(join(tmpdir(), "scripts-childenv-"));
  const qa = join(dir, ".env.qa");
  writeFileSync(qa, ["DATABASE_URL=postgres://u:p@127.0.0.1:5546/solvers_tempo_qa", "CHAIN_ID=31337", ""].join("\n"));
  const saved = { ...process.env };
  try {
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5433/other";
    process.env.CHAIN_ID = "42431";
    process.env.RPC_URL = "https://rpc.example";
    process.env.ADMIN_PRIVATE_KEY = "0xabc";
    process.env.KEEP_ME = "1";
    const env = childEnv(qa, { qa: true, extra: { SUBMISSIONS_INLINE: "false" } });
    assert.equal(env.DATABASE_URL, "postgres://u:p@127.0.0.1:5546/solvers_tempo_qa");
    assert.equal(env.CHAIN_ID, "31337");
    assert.equal(env.RPC_URL, undefined);
    assert.equal(env.ADMIN_PRIVATE_KEY, undefined);
    assert.equal(env.KEEP_ME, "1");
    assert.equal(env.SUBMISSIONS_INLINE, "false");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const dev = join(dir, ".env.dev");
  writeFileSync(dev, "DATABASE_URL=postgres://u:p@127.0.0.1:5546/solvers_tempo");
  assert.throws(() => childEnv(dev, { qa: true }), /not the QA database/);
  assert.doesNotThrow(() => childEnv(dev));
  const old = join(dir, ".env.old");
  writeFileSync(old, "DATABASE_URL=postgres://u:p@127.0.0.1:5433/solvers");
  assert.throws(() => childEnv(old), /port 5433/);
});

test("expectedRoyalty: each share floored on the original price, platform capped at 2500 bps total", () => {
  assert.deepEqual(expectedRoyalty(5_000_000n, 500, 500), { creatorAmount: 250_000n, platformAmount: 250_000n, total: 500_000n });
  assert.deepEqual(expectedRoyalty(19n, 500, 1000), { creatorAmount: 0n, platformAmount: 1n, total: 1n });
  assert.equal(expectedRoyalty(1_000_000n, 2000, 1000).platformAmount, 50_000n);
});
