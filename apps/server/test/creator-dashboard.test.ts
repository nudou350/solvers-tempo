import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { slashView, stakeExitView, sumUnits, unitsFromSql } from "../src/store/dashboard-rules.js";

// Pure rules of GET /api/creator/dashboard: base units from the SQL to the JSON, never a float.

describe("creator dashboard rules", () => {
  it("unitsFromSql: numeric text of a sum -> bigint, exact beyond 2^53 and 2^63; a real fraction throws", () => {
    assert.equal(unitsFromSql("0"), 0n);
    assert.equal(unitsFromSql("123.000"), 123n);
    assert.equal(unitsFromSql(null), 0n);
    assert.equal(unitsFromSql(undefined), 0n);
    assert.equal(unitsFromSql(7n), 7n);
    assert.equal(unitsFromSql("18446744073709551617"), 18446744073709551617n);
    assert.equal(unitsFromSql("9007199254740993"), 9007199254740993n); // 2^53 + 1: a Number would round it
    assert.throws(() => unitsFromSql("1.5"), RangeError);
    assert.throws(() => unitsFromSql("1e6"), RangeError);
  });

  it("sumUnits adds exactly", () => {
    assert.equal(sumUnits([]), 0n);
    assert.equal(sumUnits([2n ** 62n, 2n ** 62n, 1n]), 2n ** 63n + 1n);
  });

  it("stakeExitView: exitAt 0 = no exit; otherwise ISO date and extensions", () => {
    assert.equal(stakeExitView({ exitAt: 0, requestedAt: 0, extensions: 0 }), null);
    assert.deepEqual(stakeExitView({ exitAt: 1_800_000_000, requestedAt: 1_797_408_000, extensions: 1 }), {
      exitAt: "2027-01-15T08:00:00.000Z",
      extensions: 1,
    });
  });

  it("slashView: proposedAt 0 = none; windows of 72 h and 72 h + 14 days; contested flag; amount as base units", () => {
    assert.equal(slashView({ amount: 0n, proposedAt: 0, contestedAt: 0 }), null);
    const proposedAt = 1_800_000_000;
    assert.deepEqual(slashView({ amount: 2n ** 70n, proposedAt, contestedAt: 0 }), {
      amountUnits: (2n ** 70n).toString(),
      executableAt: new Date((proposedAt + 72 * 3600) * 1000).toISOString(),
      expiresAt: new Date((proposedAt + 72 * 3600 + 14 * 86_400) * 1000).toISOString(),
      contested: false,
    });
    assert.equal(slashView({ amount: 1n, proposedAt, contestedAt: proposedAt + 60 })?.contested, true);
  });
});
