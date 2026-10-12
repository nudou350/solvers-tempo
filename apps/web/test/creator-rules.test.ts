import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canContest,
  formatUnits,
  maxCreatorRoyaltyBps,
  parseAmount,
  parsePercentToBps,
  publishPhases,
  royaltyCheck,
  stakeActions,
  supplyCheck,
  withdrawBlock,
  kpiHeadline,
  type StakeLive,
} from "../src/components/creator/creator-rules";

test("kpiHeadline: 2 decimals below 10 units, whole units above", () => {
  const en = { lang: "en" as const, rate: 5.4, intlLocale: "en-US" };
  const pt = { lang: "pt" as const, rate: 5, intlLocale: "pt-BR" };
  assert.equal(kpiHeadline(0.45, en), "$0.45");
  assert.equal(kpiHeadline(0, en), "$0");
  assert.equal(kpiHeadline(9.5, en), "$9.50");
  assert.equal(kpiHeadline(1234.4, en), "$1,234");
  assert.equal(kpiHeadline(0.09, pt), "R$ 0,45");
  assert.equal(kpiHeadline(1000, pt), "R$ 5.000");
  assert.equal(kpiHeadline(0.45, { ...pt, rate: null }), "$0,45", "no rate yet: dollars, Brazilian number format");
});

test("parseAmount: exact base units, comma or dot, no silent rounding", () => {
  assert.deepEqual(parseAmount("12", 6), { ok: true, units: "12000000" });
  assert.deepEqual(parseAmount(" 12.5 ", 6), { ok: true, units: "12500000" });
  assert.deepEqual(parseAmount("0,10", 6), { ok: true, units: "100000" });
  assert.deepEqual(parseAmount("0.1234567", 6), { ok: false, reason: "too_many_decimals" });
  assert.deepEqual(parseAmount("1.5000000", 6), { ok: true, units: "1500000" });
  assert.deepEqual(parseAmount("", 6), { ok: false, reason: "empty" });
  assert.deepEqual(parseAmount("1,000.50", 6), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAmount("-1", 6), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAmount("1e3", 6), { ok: false, reason: "invalid" });
  assert.deepEqual(parseAmount("0", 6), { ok: false, reason: "zero" });
  assert.deepEqual(parseAmount("0", 6, { allowZero: true }), { ok: true, units: "0" });
  // Large values stay exact (beyond Number precision).
  assert.deepEqual(parseAmount("123456789012345.123456", 6), { ok: true, units: "123456789012345123456" });
});

test("formatUnits: exact text in the page language", () => {
  assert.equal(formatUnits("12500000", 6, "en-US"), "12.5");
  assert.equal(formatUnits("12500000", 6, "en-US", 2), "12.50");
  assert.equal(formatUnits(1234500000n, 6, "pt-BR", 2), "1.234,50");
  assert.equal(formatUnits("5", 6, "en-US"), "0.000005");
  assert.equal(formatUnits("0", 6, "en-US", 2), "0.00");
  assert.equal(formatUnits("123456789012345123456", 6, "en-US"), "123,456,789,012,345.123456");
});

test("parsePercentToBps: up to two decimals", () => {
  assert.deepEqual(parsePercentToBps("5"), { ok: true, bps: 500 });
  assert.deepEqual(parsePercentToBps("2,5 %"), { ok: true, bps: 250 });
  assert.deepEqual(parsePercentToBps("0.01"), { ok: true, bps: 1 });
  assert.deepEqual(parsePercentToBps("0.005"), { ok: false, reason: "too_precise" });
  assert.deepEqual(parsePercentToBps("abc"), { ok: false, reason: "invalid" });
  assert.deepEqual(parsePercentToBps(""), { ok: false, reason: "empty" });
  assert.deepEqual(parsePercentToBps("101"), { ok: false, reason: "invalid" });
});

test("royalty: creator + platform <= 25%, editable only before the first sale", () => {
  assert.equal(maxCreatorRoyaltyBps(500), 2000);
  assert.equal(maxCreatorRoyaltyBps(null), 2500);
  assert.equal(maxCreatorRoyaltyBps(3000), 0);
  assert.deepEqual(royaltyCheck(2000, 500, 0), { ok: true });
  assert.deepEqual(royaltyCheck(2001, 500, 0), { ok: false, reason: "too_high", maxBps: 2000 });
  assert.deepEqual(royaltyCheck(100, 500, 1), { ok: false, reason: "locked", maxBps: 2000 });
});

test("supplyCheck: first cap >= max(1, sold), then raise only", () => {
  const unlimited = { max: null, sold: 3, left: null };
  assert.deepEqual(supplyCheck(unlimited, 3), { ok: true });
  assert.deepEqual(supplyCheck(unlimited, 2), { ok: false, reason: "below_sold", min: 3 });
  assert.deepEqual(supplyCheck({ max: null, sold: 0, left: null }, 0), { ok: false, reason: "invalid", min: 1 });
  const capped = { max: 10, sold: 4, left: 6 };
  assert.deepEqual(supplyCheck(capped, 10), { ok: false, reason: "not_higher", min: 11 });
  assert.deepEqual(supplyCheck(capped, 9), { ok: false, reason: "not_higher", min: 11 });
  assert.deepEqual(supplyCheck(capped, 11), { ok: true });
  assert.deepEqual(supplyCheck(capped, 2.5), { ok: false, reason: "invalid", min: 11 });
  assert.deepEqual(supplyCheck(capped, 1_000_001), { ok: false, reason: "too_high", min: 11 });
});

test("stakeActions: by status", () => {
  assert.deepEqual(stakeActions("active"), { topUp: true, exit: true, cancelExit: false, withdraw: false });
  assert.deepEqual(stakeActions("suspended"), { topUp: true, exit: true, cancelExit: false, withdraw: false });
  assert.deepEqual(stakeActions("retired"), { topUp: false, exit: false, cancelExit: true, withdraw: true });
});

test("stakeActions with the live Staking state: dates, extensions and a pending penalty", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const past = "2026-10-01T00:00:00.000Z";
  const future = "2026-11-01T00:00:00.000Z";
  const slash = { amountUnits: "1000000", executableAt: future, expiresAt: future, contested: false };
  const live = (x: Partial<StakeLive>): StakeLive => ({ chainRead: true, stakeExit: null, slash: null, ...x });
  // Not retired: the live state does not change top-up / exit.
  assert.deepEqual(stakeActions("active", live({ slash }), now), { topUp: true, exit: true, cancelExit: false, withdraw: false });
  // Waiting for the exit date: cancel yes, withdraw not yet.
  assert.deepEqual(stakeActions("retired", live({ stakeExit: { exitAt: future, extensions: 0 } }), now), { topUp: false, exit: false, cancelExit: true, withdraw: false });
  assert.deepEqual(withdrawBlock("retired", live({ stakeExit: { exitAt: future, extensions: 0 } }), now), { reason: "waiting", until: future });
  // Date passed: withdraw; after an admin extension the exit can no longer be cancelled.
  assert.deepEqual(stakeActions("retired", live({ stakeExit: { exitAt: past, extensions: 1 } }), now), { topUp: false, exit: false, cancelExit: false, withdraw: true });
  assert.equal(withdrawBlock("retired", live({ stakeExit: { exitAt: past, extensions: 0 } }), now), null);
  // A pending penalty blocks the withdrawal.
  assert.equal(stakeActions("retired", live({ stakeExit: { exitAt: past, extensions: 0 }, slash }), now).withdraw, false);
  assert.deepEqual(withdrawBlock("retired", live({ stakeExit: { exitAt: past, extensions: 0 }, slash }), now), { reason: "slash" });
  // Retired without an exit on record: nothing to cancel or withdraw.
  assert.deepEqual(stakeActions("retired", live({}), now), { topUp: false, exit: false, cancelExit: false, withdraw: false });
  assert.deepEqual(withdrawBlock("retired", live({}), now), { reason: "no_exit" });
  // Unknown state (RPC failed): only the status decides.
  assert.deepEqual(stakeActions("retired", live({ chainRead: false }), now), { topUp: false, exit: false, cancelExit: true, withdraw: true });
  assert.equal(withdrawBlock("retired", live({ chainRead: false }), now), null);
});

test("canContest: once, only while a penalty is proposed (unknown state: let the server decide)", () => {
  const slash = { amountUnits: "1", executableAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-15T00:00:00.000Z", contested: false };
  assert.equal(canContest({ chainRead: true, stakeExit: null, slash: null }), false);
  assert.equal(canContest({ chainRead: true, stakeExit: null, slash }), true);
  assert.equal(canContest({ chainRead: true, stakeExit: null, slash: { ...slash, contested: true } }), false);
  assert.equal(canContest({ chainRead: false, stakeExit: null, slash: null }), true);
});

test("publishPhases: sign -> confirmed -> platform approval (new Solvers only) -> live", () => {
  assert.deepEqual(publishPhases("register-agent", true), { sign: "current", confirmed: "todo", approval: "todo", live: "todo" });
  assert.deepEqual(publishPhases("register-agent", true, "confirming"), { sign: "done", confirmed: "current", approval: "todo", live: "todo" });
  assert.deepEqual(publishPhases("await-admin-approval", true), { sign: "done", confirmed: "done", approval: "current", live: "todo" });
  assert.deepEqual(publishPhases("ready", true), { sign: "done", confirmed: "done", approval: "done", live: "current" });
  assert.deepEqual(publishPhases("update-version", false), { sign: "current", confirmed: "todo", approval: "skipped", live: "todo" });
  assert.deepEqual(publishPhases("ready", false), { sign: "done", confirmed: "done", approval: "skipped", live: "current" });
  assert.deepEqual(publishPhases("blocked", false), { sign: "blocked", confirmed: "todo", approval: "skipped", live: "todo" });
  assert.deepEqual(publishPhases(null, true), { sign: "todo", confirmed: "todo", approval: "todo", live: "todo" });
});
