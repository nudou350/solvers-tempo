import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { MAX_LICENSES_CAP, SUPPLY_UNLIMITED } from "@solvers/shared";
import { HttpError } from "../src/lib/http.js";
import { assertSupplyOpen } from "../src/store/supply.js";
import { isRowSoldOut, nextMaxLicenses, supplyLabel, supplyOfRow, validManifestMax } from "../src/store/supply-rules.js";

// License cap: pure rules (no env, database or RPC). The contract is the real barrier (SoldOut).

describe("supplyOfRow / isRowSoldOut / supplyLabel", () => {
  it("no cap is unlimited: never sold out, no text", () => {
    const row = { totalSales: 1_000_000n, maxLicenses: null };
    assert.deepEqual(supplyOfRow(row), { max: null, sold: 1_000_000, left: null });
    assert.equal(isRowSoldOut(row), false);
    assert.equal(supplyLabel(supplyOfRow(row)), null);
  });

  it("with a cap: left = max - sold, sold out at 0 (never negative)", () => {
    assert.deepEqual(supplyOfRow({ totalSales: 3n, maxLicenses: 10 }), { max: 10, sold: 3, left: 7 });
    assert.equal(isRowSoldOut({ totalSales: 9n, maxLicenses: 10 }), false);
    assert.equal(isRowSoldOut({ totalSales: 10n, maxLicenses: 10 }), true);
    assert.equal(isRowSoldOut({ totalSales: 12n, maxLicenses: 10 }), true); // mirror ahead, or a cap created after the sales
    assert.equal(supplyOfRow({ totalSales: 12n, maxLicenses: 10 }).left, 0);
  });

  it("text for the AI", () => {
    assert.equal(supplyLabel(supplyOfRow({ totalSales: 7n, maxLicenses: 10 })), "3 of 10 licenses left");
    assert.equal(supplyLabel(supplyOfRow({ totalSales: 10n, maxLicenses: 10 })), "sold out");
  });
});

describe("assertSupplyOpen", () => {
  const row = (totalSales: bigint, maxLicenses: number | null) => ({ name: "Solver X", totalSales, maxLicenses });

  it("passes with room or without a cap", () => {
    assertSupplyOpen(row(2n, 3));
    assertSupplyOpen(row(5000n, null));
  });

  it("sold out: 409 sold_out with the current limit, never promising that 'only N exist', no secondary market", () => {
    try {
      assertSupplyOpen(row(3n, 3));
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "sold_out");
      assert.deepEqual(e.extra, { maxLicenses: 3, sold: 3 });
      assert.match(e.message, /Solver X is sold out/);
      assert.match(e.message, /current license limit/);
      assert.match(e.message, /creator can raise it/);
      assert.doesNotMatch(e.message, /resell|market|only \d+/i);
    }
  });
});

describe("nextMaxLicenses (the cap only goes up)", () => {
  it("manifest without supply: nothing to do without an on-chain cap (null or 0 = unlimited)", () => {
    assert.deepEqual(nextMaxLicenses(null, null, 0), { ok: true, action: "none" });
    assert.deepEqual(nextMaxLicenses(SUPPLY_UNLIMITED, null, 50), { ok: true, action: "none" });
  });

  it("manifest without supply and a finite on-chain cap: kept with a warning (never unlimited by omission)", () => {
    const p = nextMaxLicenses(10, null, 2);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.reason, "unlimited_not_implicit");
  });

  it("no cap yet: creates it, as long as it is not below what was sold", () => {
    assert.deepEqual(nextMaxLicenses(null, 10, 0), { ok: true, action: "create", max: 10 });
    assert.deepEqual(nextMaxLicenses(SUPPLY_UNLIMITED, 5, 5), { ok: true, action: "create", max: 5 });
    assert.deepEqual(nextMaxLicenses(SUPPLY_UNLIMITED, 500, 10), { ok: true, action: "create", max: 500 });
    const p = nextMaxLicenses(null, 4, 5);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.reason, "below_sold");
  });

  it("equal does nothing, higher raises, lower is refused", () => {
    assert.deepEqual(nextMaxLicenses(10, 10, 3), { ok: true, action: "none" });
    assert.deepEqual(nextMaxLicenses(10, 25, 3), { ok: true, action: "raise", max: 25 });
    const p = nextMaxLicenses(10, 5, 3);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.reason, "lower");
  });

  it("invalid request (0, fraction, above the cap)", () => {
    for (const bad of [0, -1, 1.5, MAX_LICENSES_CAP + 1]) {
      const p = nextMaxLicenses(null, bad, 0);
      assert.equal(p.ok, false, String(bad));
      if (!p.ok) assert.equal(p.reason, "invalid");
    }
    assert.equal(validManifestMax(1), true);
    assert.equal(validManifestMax(MAX_LICENSES_CAP), true);
    assert.equal(validManifestMax("10"), false);
  });
});
