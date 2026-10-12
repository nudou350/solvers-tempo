import { test } from "node:test";
import assert from "node:assert/strict";
import { bpsText, brlText, formatUnits, parseUnits, priceUnits, royaltyInfo, tokenText, usdText } from "../src/components/catalog/money";

test("formatUnits is exact and localized", () => {
  assert.equal(formatUnits(12_500_000n, 6, "en-US"), "12.50");
  assert.equal(formatUnits(12_500_000n, 6, "pt-BR"), "12,50");
  assert.equal(formatUnits(25_000_000n, 6, "en-US"), "25");
  assert.equal(formatUnits(25_000_000n, 6, "en-US", { fixed2: true }), "25.00");
  assert.equal(formatUnits("1234567891", 6, "en-US"), "1,234.567891");
  assert.equal(formatUnits(1n, 6, "en-US"), "0.000001");
  assert.equal(formatUnits(1_234_000_000n, 6, "pt-BR"), "1.234");
});

test("token, dollar and real texts", () => {
  const token = { symbol: "pathUSD", decimals: 6 };
  assert.equal(tokenText(5_000_000n, token, "en-US"), "5 pathUSD");
  assert.equal(usdText(5_000_000n, 6, "en-US"), "$5.00");
  assert.equal(usdText("24990000", 6, "en-US"), "$24.99");
  assert.equal(brlText(10_000_000n, 6, 5.5, "pt-BR"), "R$ 55,00");
});

test("priceUnits never rounds a real amount silently", () => {
  assert.equal(priceUnits(24.99, 6), 24_990_000n);
  assert.equal(priceUnits(0.1 + 0.2, 6), 300_000n);
  assert.equal(priceUnits(1.0000001, 6), null);
  assert.equal(priceUnits(-1, 6), null);
});

test("parseUnits accepts only base-unit strings", () => {
  assert.equal(parseUnits("5000000"), 5_000_000n);
  assert.equal(parseUnits("0"), 0n);
  assert.equal(parseUnits("05"), null);
  assert.equal(parseUnits("1.5"), null);
  assert.equal(parseUnits(null), null);
});

test("bpsText", () => {
  assert.equal(bpsText(500, "en-US"), "5%");
  assert.equal(bpsText(750, "en-US"), "7.5%");
  assert.equal(bpsText(125, "pt-BR"), "1,25%");
  assert.equal(bpsText(10_001, "en-US"), "");
});

test("royaltyInfo mirrors the contract split (each share floored, platform clamped to the cap)", () => {
  const r = royaltyInfo(19n, 500, 1000);
  assert.deepEqual(r, { creatorBps: 500, platformBps: 1000, totalBps: 1500, creatorUnits: 0n, platformUnits: 1n, totalUnits: 1n });
  const big = royaltyInfo(100_000_000n, 2000, 1000);
  assert.equal(big?.platformBps, 500);
  assert.equal(big?.totalUnits, 25_000_000n);
  assert.equal(royaltyInfo(100n, 500, null), null);
  assert.equal(royaltyInfo(null, 500, 500), null);
});
