import { test } from "node:test";
import assert from "node:assert/strict";
import { averageRating, creatorReputationScore, guaranteeLevel, reputationScore, splitGuaranteeAmounts, splitGuaranteeUnits } from "./rules.js";

test("reputation", () => {
  assert.equal(reputationScore(0, 0), 50);
  assert.equal(reputationScore(30, 0), 80);
  assert.equal(reputationScore(2, 2), 23);
  assert.equal(guaranteeLevel(0, 0), "limited");
  assert.equal(guaranteeLevel(5, 0), "full");
  assert.equal(guaranteeLevel(20, 3), "none");
  assert.equal(guaranteeLevel(2, 2), "none");
});

test("rating", () => {
  assert.equal(averageRating(14, 3), 4.7);
  assert.equal(averageRating(14n, 3), 4.7);
  assert.equal(averageRating(0, 0), 0);
});

test("creator reputation", () => {
  assert.equal(creatorReputationScore(0, 0, 0), 50);
  assert.equal(creatorReputationScore(40, 5, 0), 90);
  assert.equal(creatorReputationScore(10, 4, 2), 40);
});

test("guarantee split in base units: exact sum, remainder on the last milestone", () => {
  assert.deepEqual(splitGuaranteeUnits(19_000_000n, [50, 50]), [9_500_000n, 9_500_000n]);
  assert.deepEqual(splitGuaranteeUnits(10_000_000n, [1, 1, 1]), [3_333_333n, 3_333_333n, 3_333_334n]);
  assert.deepEqual(splitGuaranteeUnits(5n, []), []);
  const parts = splitGuaranteeUnits(7_770_000n, [30, 70]);
  assert.equal(parts.reduce((s, x) => s + x, 0n), 7_770_000n);
  assert.throws(() => splitGuaranteeUnits(10n, [0, 0]), RangeError);
});

test("guarantee split for display amounts", () => {
  assert.deepEqual(splitGuaranteeAmounts(19, [50, 50]), [9.5, 9.5]);
  assert.deepEqual(splitGuaranteeAmounts(10, [1, 1, 1]), [3.333333, 3.333333, 3.333334]);
  assert.equal(splitGuaranteeAmounts(7.77, [30, 70]).reduce((s, x) => s + x, 0).toFixed(6), "7.770000");
  assert.deepEqual(splitGuaranteeAmounts(10, [1, 1, 1], 2), [3.33, 3.33, 3.34]);
});
