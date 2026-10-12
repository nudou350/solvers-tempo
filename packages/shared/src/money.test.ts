import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIN_PRICE_UNITS,
  DEFAULT_TOKEN_DECIMALS,
  MAX_BPS,
  MAX_FEE_BPS,
  MAX_TOTAL_ROYALTY_BPS,
  feeSplit,
  fromUnits,
  numberToUnits,
  royaltySplit,
  toUnits,
  unitsToNumber,
  unitsToUsdc,
  usdcToUnits,
} from "./money.js";

const U256_MAX = 2n ** 256n - 1n;

test("constants mirror the contracts", () => {
  assert.equal(MAX_BPS, 10_000);
  assert.equal(MAX_FEE_BPS, 2_000);
  assert.equal(MAX_TOTAL_ROYALTY_BPS, 2_500);
  assert.equal(DEFAULT_TOKEN_DECIMALS, 6);
  assert.equal(DEFAULT_MIN_PRICE_UNITS(6), 5_000_000n);
  assert.equal(DEFAULT_MIN_PRICE_UNITS(), 5_000_000n);
  assert.equal(DEFAULT_MIN_PRICE_UNITS(18), 5n * 10n ** 18n);
  assert.equal(DEFAULT_MIN_PRICE_UNITS(0), 5n);
  assert.throws(() => DEFAULT_MIN_PRICE_UNITS(-1), RangeError);
  assert.throws(() => DEFAULT_MIN_PRICE_UNITS(1.5), RangeError);
});

test("feeSplit: contract vectors", () => {
  assert.deepEqual(feeSplit(5_000_009n, 1000), { fee: 500_000n, rest: 4_500_009n });
  assert.deepEqual(feeSplit(0n, 1000), { fee: 0n, rest: 0n });
  assert.deepEqual(feeSplit(19n, 1000), { fee: 1n, rest: 18n });
  assert.deepEqual(feeSplit(9n, 1000), { fee: 0n, rest: 9n });
  assert.deepEqual(feeSplit(5_000_000n, 0), { fee: 0n, rest: 5_000_000n });
  assert.deepEqual(feeSplit(5_000_000n, 2000), { fee: 1_000_000n, rest: 4_000_000n });
  assert.deepEqual(feeSplit(7n, 10_000), { fee: 7n, rest: 0n });
});

test("feeSplit: floor and exact conservation, including uint256-sized amounts", () => {
  const amounts = [0n, 1n, 2n, 9_999n, 10_000n, 10_001n, 5_000_009n, 2n ** 96n - 1n, U256_MAX / 10_000n];
  for (const amount of amounts) {
    for (const bps of [0, 1, 333, 999, 1000, 2000, 9999, 10_000]) {
      const { fee, rest } = feeSplit(amount, bps);
      assert.equal(fee + rest, amount, `${amount} @ ${bps}`);
      assert.equal(fee, (amount * BigInt(bps)) / 10_000n);
    }
  }
});

test("feeSplit: invalid input throws", () => {
  for (const bps of [-1, 10_001, 0.5, Number.NaN]) assert.throws(() => feeSplit(100n, bps), RangeError, String(bps));
  assert.throws(() => feeSplit(-1n, 100), RangeError);
});

test("royaltySplit: contract vectors", () => {
  const split = (p: bigint, c: number, f: number) => {
    const r = royaltySplit(p, c, f);
    return [r.creatorAmount, r.platformAmount, r.total];
  };
  assert.deepEqual(split(19n, 500, 1000), [0n, 1n, 1n]);
  assert.deepEqual(split(1_000_001n, 333, 333), [33_300n, 33_300n, 66_600n]);
  assert.deepEqual(split(10_000_000n, 500, 500), [500_000n, 500_000n, 1_000_000n]);
  // The platform share is clamped to 2500 - creatorBps = 500 bps.
  assert.deepEqual(split(100n, 2000, 1000), [20n, 5n, 25n]);
  assert.deepEqual(split(100n, 2500, 1000), [25n, 0n, 25n]);
  assert.deepEqual(split(0n, 500, 500), [0n, 0n, 0n]);
});

test("royaltySplit: each share floored independently, total never above 25% of the original price", () => {
  for (const price of [1n, 19n, 99n, 1_000_001n, 5_000_009n, 2n ** 96n - 1n]) {
    for (const c of [0, 1, 300, 500, 2000, 2500]) {
      for (const p of [0, 1, 500, 1000, 2500, 10_000]) {
        const r = royaltySplit(price, c, p);
        const eff = Math.min(p, 2500 - c);
        assert.equal(r.creatorAmount, (price * BigInt(c)) / 10_000n);
        assert.equal(r.platformAmount, (price * BigInt(eff)) / 10_000n);
        assert.equal(r.total, r.creatorAmount + r.platformAmount);
        assert.ok(r.total <= (price * 2500n) / 10_000n, `${price} ${c} ${p}`);
      }
    }
  }
});

test("royaltySplit: invalid input throws", () => {
  assert.throws(() => royaltySplit(100n, 2501, 0), RangeError);
  assert.throws(() => royaltySplit(100n, -1, 0), RangeError);
  assert.throws(() => royaltySplit(100n, 0, 10_001), RangeError);
  assert.throws(() => royaltySplit(100n, 0.5, 0), RangeError);
  assert.throws(() => royaltySplit(-1n, 0, 0), RangeError);
});

test("toUnits / fromUnits: exact decimal strings", () => {
  assert.equal(toUnits("12.5", 6), 12_500_000n);
  assert.equal(toUnits(" 5 ", 6), 5_000_000n);
  assert.equal(toUnits("0.000001", 6), 1n);
  assert.equal(toUnits("1.0000000", 6), 1_000_000n);
  assert.equal(toUnits("7", 0), 7n);
  assert.equal(toUnits("1.5", 18), 1_500_000_000_000_000_000n);
  for (const bad of ["1.0000001", "-1", "1e3", "", ".5", "5.", "0x10", "1,5", "abc"]) {
    assert.throws(() => toUnits(bad, 6), RangeError, bad);
  }
  assert.equal(fromUnits(12_500_000n, 6), "12.5");
  assert.equal(fromUnits(1n, 6), "0.000001");
  assert.equal(fromUnits(0n, 6), "0");
  assert.equal(fromUnits(5_000_000n, 6), "5");
  assert.equal(fromUnits(-1_500_000n, 6), "-1.5");
  assert.equal(fromUnits(42n, 0), "42");
  for (const u of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n, 2n ** 96n - 1n]) assert.equal(toUnits(fromUnits(u, 6), 6), u);
});

test("numberToUnits: exact, float noise tolerated, real extra decimals rejected (never rounded silently)", () => {
  assert.equal(numberToUnits(12, 6), 12_000_000n);
  assert.equal(numberToUnits(0.1 + 0.2, 6), 300_000n);
  assert.equal(numberToUnits(9.99, 6), 9_990_000n);
  assert.throws(() => numberToUnits(1.005, 2), RangeError);
  assert.throws(() => numberToUnits(1e-7, 6), RangeError);
  assert.throws(() => numberToUnits(5e-7, 6), RangeError);
  assert.throws(() => numberToUnits(1.5e-7, 6), RangeError);
  assert.equal(numberToUnits(1e21, 6), 10n ** 27n);
  assert.throws(() => numberToUnits(0.9999995, 6), RangeError);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => numberToUnits(bad, 6), RangeError);
});

test("unitsToNumber: nearest double, no float noise", () => {
  assert.equal(unitsToNumber(1_140_000n, 6), 1.14);
  assert.equal(unitsToNumber(5_560_000n, 6), 5.56);
  assert.equal(unitsToNumber(1n, 6), 0.000001);
  assert.equal(unitsToNumber(0n, 6), 0);
  assert.equal(unitsToNumber(123, 6), 0.000123);
  assert.equal(unitsToNumber("2500000", 6), 2.5);
  // every price in cents from 0.00 to 1000.00 is the nearest double of c/100 (what the user typed)
  for (let c = 0; c <= 100_000; c++) assert.equal(unitsToNumber(BigInt(c) * 10_000n, 6), c / 100, `cents ${c}`);
  assert.equal(unitsToNumber(18_446_744_073_709_551_615n, 6), 18_446_744_073_709.55);
});

test("deprecated aliases default to the documented 6 decimals", () => {
  assert.equal(usdcToUnits(12), 12_000_000n);
  assert.equal(usdcToUnits(12, 2), 1200n);
  assert.equal(unitsToUsdc(12_500_000n), 12.5);
  assert.equal(unitsToUsdc(1250n, 2), 12.5);
});
