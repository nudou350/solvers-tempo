import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Agent, normalizeMaxLicenses, SUPPLY_UNLIMITED, soldOutText, toAgentSupply, isSoldOut } from "./index.js";

describe("supply (license cap)", () => {
  it("missing or 0 on-chain (maxSupply 0) = unlimited", () => {
    assert.equal(SUPPLY_UNLIMITED, 0);
    assert.equal(normalizeMaxLicenses(null), null);
    assert.equal(normalizeMaxLicenses(undefined), null);
    assert.equal(normalizeMaxLicenses(SUPPLY_UNLIMITED), null);
    assert.equal(normalizeMaxLicenses(10), 10);
    assert.equal(normalizeMaxLicenses(0xffff_ffff), 0xffff_ffff);
  });

  it("left = max - sold, never negative; unlimited has no left", () => {
    assert.deepEqual(toAgentSupply(10, 3), { max: 10, sold: 3, left: 7 });
    assert.deepEqual(toAgentSupply(10, 12), { max: 10, sold: 12, left: 0 });
    assert.deepEqual(toAgentSupply(null, 99), { max: null, sold: 99, left: null });
    assert.equal(isSoldOut(toAgentSupply(3, 3)), true);
    assert.equal(isSoldOut(toAgentSupply(3, 2)), false);
    assert.equal(isSoldOut(toAgentSupply(null, 1_000_000)), false);
  });

  it("Agent without `supply` parses as unlimited", () => {
    assert.deepEqual(Agent.shape.supply.parse(undefined), { max: null, sold: 0, left: null });
  });

  it("sold-out text says the creator can raise the cap and never suggests a secondary market", () => {
    const text = soldOutText("Frontend Builder");
    assert.match(text, /^Frontend Builder is sold out/);
    assert.match(text, /creator can raise it/);
    assert.doesNotMatch(text, /market|resell|on sale/i);
  });
});
