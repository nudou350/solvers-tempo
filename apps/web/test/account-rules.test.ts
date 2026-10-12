// Pure helpers of the account screens. Run: cd apps/web && node --import tsx --test test/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoyaltyQuote } from "@solvers/shared";
import {
  bpsPercent,
  checkRecipient,
  formatMoney,
  formatUnits,
  hasEnough,
  heldTotal,
  memoryUnlockFailure,
  royaltyDisclosure,
  shortAddress,
} from "../src/components/account/account-rules";

test("memoryUnlockFailure: refused signature vs ended session vs cancel", () => {
  assert.equal(memoryUnlockFailure({ status: 400, code: "memory_signature_refused", message: "The wallet signature was refused" }), "refused");
  assert.equal(memoryUnlockFailure({ status: 401, code: "unauthorized", message: "x" }), "session");
  assert.equal(memoryUnlockFailure({ status: 401, code: "token_expired" }), "session");
  assert.equal(memoryUnlockFailure(Object.assign(new Error("User rejected the request."), { code: 4001 })), "cancelled");
  assert.equal(memoryUnlockFailure({ code: "cancelled" }), "cancelled");
  assert.equal(memoryUnlockFailure({ status: 500, code: "internal" }), "other");
  assert.equal(memoryUnlockFailure(null), "other");
});

const OWNER = "0x1111111111111111111111111111111111111111";
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

test("formatUnits is exact and localized", () => {
  assert.equal(formatUnits(12_500_000n, 6, "en-US"), "12.50");
  assert.equal(formatUnits("12500000", 6, "pt-BR"), "12,50");
  assert.equal(formatUnits(1_234_567_890_123n, 6, "en-US"), "1,234,567.890123");
  assert.equal(formatUnits(1_234_567_890_123n, 6, "pt-BR"), "1.234.567,890123");
  assert.equal(formatUnits(0n, 6, "en-US"), "0.00");
  assert.equal(formatUnits(1n, 6, "en-US"), "0.000001");
  // Beyond Number precision: still exact.
  assert.equal(formatUnits(123_456_789_012_345_678_901n, 6, "en-US"), "123,456,789,012,345.678901");
  assert.equal(formatUnits(5n, 0, "en-US"), "5");
});

test("formatMoney appends the token symbol", () => {
  assert.equal(formatMoney("5000000", { decimals: 6, symbol: "USD" }, "en-US"), "5.00 USD");
});

test("bpsPercent renders exact percentages", () => {
  assert.equal(bpsPercent(500, "en-US"), "5%");
  assert.equal(bpsPercent(1000, "en-US"), "10%");
  assert.equal(bpsPercent(750, "en-US"), "7.5%");
  assert.equal(bpsPercent(750, "pt-BR"), "7,5%");
  assert.equal(bpsPercent(333, "en-US"), "3.33%");
  assert.equal(bpsPercent(0, "en-US"), "0%");
  assert.throws(() => bpsPercent(10_001, "en-US"));
  assert.throws(() => bpsPercent(1.5, "en-US"));
});

test("checkRecipient accepts valid addresses and returns the checksummed form", () => {
  assert.deepEqual(checkRecipient(CHECKSUMMED.toLowerCase(), { owner: OWNER }), { ok: true, address: CHECKSUMMED });
  assert.deepEqual(checkRecipient(`  ${CHECKSUMMED}  `), { ok: true, address: CHECKSUMMED });
  assert.deepEqual(checkRecipient(CHECKSUMMED.toUpperCase().replace("0X", "0x")), { ok: true, address: CHECKSUMMED });
});

test("checkRecipient refuses what would lose the license", () => {
  assert.deepEqual(checkRecipient(""), { ok: false, reason: "empty" });
  assert.deepEqual(checkRecipient("   "), { ok: false, reason: "empty" });
  assert.deepEqual(checkRecipient("0x123"), { ok: false, reason: "format" });
  assert.deepEqual(checkRecipient("hello"), { ok: false, reason: "format" });
  assert.deepEqual(checkRecipient(`${CHECKSUMMED}00`), { ok: false, reason: "format" });
  // One letter's case flipped: wrong checksum (likely a typo).
  assert.deepEqual(checkRecipient(CHECKSUMMED.replace("aAeb", "AAeb")), { ok: false, reason: "checksum" });
  assert.deepEqual(checkRecipient("0x0000000000000000000000000000000000000000"), { ok: false, reason: "zero" });
  assert.deepEqual(checkRecipient(OWNER.toUpperCase().replace("0X", "0x"), { owner: OWNER }), { ok: false, reason: "self" });
  assert.deepEqual(checkRecipient("0x20c0000000000000000000000000000000000000"), { ok: false, reason: "contract" });
  assert.deepEqual(checkRecipient("0x20C000000000000000000000b9537d11c60E8b50".toLowerCase()), { ok: false, reason: "contract" });
  const license = "0x2222222222222222222222222222222222222222";
  assert.deepEqual(checkRecipient(license, { blocked: [license.toUpperCase().replace("0X", "0x")] }), { ok: false, reason: "contract" });
});

test("shortAddress shows a checksummed head and tail", () => {
  assert.equal(shortAddress(CHECKSUMMED.toLowerCase()), "0x5aAe…eAed");
});

const quote = (over: Partial<RoyaltyQuote> = {}): RoyaltyQuote => ({
  licenseId: "7",
  agentId: "0123456789abcdef0123456789abcdef",
  token: "0x20c0000000000000000000000000000000000000",
  decimals: 6,
  originalPriceUnits: "25000000",
  creatorBps: 500,
  platformBps: 500,
  creatorAmountUnits: "1250000",
  platformAmountUnits: "1250000",
  totalUnits: "2500000",
  ...over,
});

test("royaltyDisclosure uses the quote's bps and exact amounts", () => {
  const d = royaltyDisclosure(quote(), "USD", "en-US");
  assert.equal(d.totalPct, "10%");
  assert.equal(d.creatorPct, "5%");
  assert.equal(d.platformPct, "5%");
  assert.equal(d.original, "25.00 USD");
  assert.equal(d.creator, "1.25 USD");
  assert.equal(d.platform, "1.25 USD");
  assert.equal(d.total, "2.50 USD");
  assert.equal(d.totalUnits, 2_500_000n);
});

test("royaltyDisclosure follows a per-Solver creator share and floored amounts", () => {
  // 3% creator + 5% platform of 1_000_001 units: each share floored (dust stays with the payer).
  const d = royaltyDisclosure(
    quote({ originalPriceUnits: "1000001", creatorBps: 300, platformBps: 500, creatorAmountUnits: "30000", platformAmountUnits: "50000", totalUnits: "80000" }),
    "USD",
    "pt-BR",
  );
  assert.equal(d.totalPct, "8%");
  assert.equal(d.creatorPct, "3%");
  assert.equal(d.original, "1,000001 USD");
  assert.equal(d.total, "0,08 USD");
});

test("hasEnough compares base units", () => {
  assert.equal(hasEnough("2500000", "2500000"), true);
  assert.equal(hasEnough(2_499_999n, "2500000"), false);
  assert.equal(hasEnough(null, 1n), false);
});

test("heldTotal is zero when nothing is held", () => {
  assert.equal(heldTotal(null), 0n);
  assert.equal(heldTotal({ totalUnits: "0", contracts: [] }), 0n);
  assert.equal(heldTotal({ totalUnits: "1500000", contracts: [{ contract: OWNER, units: "1500000" }] }), 1_500_000n);
});
