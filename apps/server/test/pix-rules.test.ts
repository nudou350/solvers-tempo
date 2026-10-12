import "./helpers/fake-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PIX_MAX_CENTS,
  PIX_MIN_CENTS,
  brlCentsFor,
  formatRateE8,
  mpOrderOutcome,
  pixLimitError,
  rateToE8,
  simulateBlockReason,
  simulatedPixCode,
} from "../src/pix/rules.js";

test("simulate: a charge of the simulated provider can be simulated", () => {
  assert.equal(simulateBlockReason("simulated"), null);
});

test("simulate: a Mercado Pago charge can never be approved through the simulation route", () => {
  assert.equal(simulateBlockReason("mercadopago"), "pix_not_simulated");
});

test("simulate: an unknown or empty provider is refused too", () => {
  assert.equal(simulateBlockReason(""), "pix_not_simulated");
  assert.equal(simulateBlockReason("other"), "pix_not_simulated");
});

test("fx: the rate is stored with exactly 8 decimals", () => {
  assert.equal(rateToE8(5.4), 540_000_000n);
  assert.equal(formatRateE8(rateToE8(5.4)), "5.40000000");
  assert.equal(formatRateE8(rateToE8(5.43219876)), "5.43219876");
  assert.throws(() => rateToE8(0));
  assert.throws(() => rateToE8(Number.NaN));
});

test("brl: cents = units x rate, rounded half up to the cent (6-decimal token)", () => {
  const r = rateToE8(5.4);
  assert.equal(brlCentsFor(10_000_000n, r, 6), 5400n); // 10 USD -> R$ 54.00
  assert.equal(brlCentsFor(5_000_000n, r, 6), 2700n);
  // 1.234567 USD x 5.4 = 6.6666618 -> R$ 6.67
  assert.equal(brlCentsFor(1_234_567n, r, 6), 667n);
  // exactly half a cent rounds up: 0.0925 USD x 5.4 = 0.4995 -> 0.50
  assert.equal(brlCentsFor(92_500n, r, 6), 50n);
  // other decimals
  assert.equal(brlCentsFor(10n ** 18n, r, 18), 540n);
});

test("brl: limits", () => {
  assert.equal(pixLimitError(BigInt(PIX_MIN_CENTS)), null);
  assert.equal(pixLimitError(BigInt(PIX_MAX_CENTS)), null);
  assert.equal(pixLimitError(BigInt(PIX_MIN_CENTS - 1))?.code, "pix_min");
  assert.equal(pixLimitError(BigInt(PIX_MAX_CENTS + 1))?.code, "pix_max");
});

test("mercado pago: order status mapping (state always comes from GET /v1/orders)", () => {
  assert.equal(mpOrderOutcome("processed"), "paid");
  assert.equal(mpOrderOutcome("action_required"), "pending");
  assert.equal(mpOrderOutcome("processing"), "pending");
  assert.equal(mpOrderOutcome(undefined), "pending");
  assert.equal(mpOrderOutcome("expired"), "expired");
  assert.equal(mpOrderOutcome("canceled"), "expired");
  assert.equal(mpOrderOutcome("failed"), "failed");
  assert.equal(mpOrderOutcome("refunded"), "refunded");
  assert.equal(mpOrderOutcome("charged_back"), "refunded");
});

test("simulated code is an unpayable placeholder", () => {
  const code = simulatedPixCode("pix_abc", 5400n);
  assert.match(code, /^PIX-TEST-SOLVERS\|DO-NOT-PAY\|SIMULATED\|pix_abc\|R\$54\.00$/);
});

test("mercado pago webhook: the signed ts must be fresh (seconds or milliseconds), a replay later is refused", async () => {
  const { createHmac } = await import("node:crypto");
  const { verifyWebhookSignature, webhookTsMs, WEBHOOK_MAX_AGE_MS } = await import("../src/pix/mercadopago.js");
  const secret = "whsec-test";
  const sign = (ts: string) => `ts=${ts},v1=${createHmac("sha256", secret).update(`id:ord1;request-id:r1;ts:${ts};`).digest("hex")}`;
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(webhookTsMs("1791720000"), 1791720000_000);
  assert.equal(webhookTsMs("1791720000123"), 1791720000123);
  assert.equal(webhookTsMs("abc"), null);
  const base = { requestId: "r1", dataId: "ORD1", secret, now };
  assert.ok(verifyWebhookSignature({ ...base, signature: sign(String(now)) }));
  assert.ok(verifyWebhookSignature({ ...base, signature: sign(String(Math.floor(now / 1000) - 60)) }));
  assert.ok(!verifyWebhookSignature({ ...base, signature: sign(String(now - WEBHOOK_MAX_AGE_MS - 1000)) }), "too old");
  assert.ok(!verifyWebhookSignature({ ...base, signature: sign(String(now + WEBHOOK_MAX_AGE_MS + 1000)) }), "from the future");
  assert.ok(!verifyWebhookSignature({ ...base, dataId: "ORD2", signature: sign(String(now)) }), "id not covered");
});
