import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultMethod,
  doneHref,
  donePhase,
  guardOfError,
  parseKind,
  parseTxHash,
  pixPhase,
  safeExplorerUrl,
  safeSolanaPayUrl,
  solanaTxUrl,
  SOLANA_GRACE_MS,
  purchaseGuard,
  taskValid,
  unconfirmedDoneHref,
  walletCovers,
} from "../src/components/checkout/rules";

test("unconfirmed payment: go to the done page with the charge and the hash, never pay again", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const ctx = { slug: "my solver", kind: "license" as const, chargeId: "chg_1" };
  const href = unconfirmedDoneHref({ code: "unconfirmed", hash }, ctx);
  assert.equal(href, doneHref({ ...ctx, txHash: hash }));
  assert.ok(href!.includes("charge=chg_1") && href!.includes(`tx=${hash}`) && href!.includes("agent=my+solver"));
  assert.equal(unconfirmedDoneHref({ code: "transaction_failed", hash }, ctx), null, "reverted: nothing charged, may retry");
  assert.equal(unconfirmedDoneHref({ code: "unconfirmed", hash: "0x12" }, ctx), null);
  assert.equal(unconfirmedDoneHref(new Error("boom"), ctx), null);
  assert.equal(unconfirmedDoneHref(null, ctx), null);
});

const creator = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const base = { owned: false, sessionWallet: buyer, creatorWallet: creator, supply: { max: null, sold: 0, left: null }, totalUnits: 10_000_000n, minPriceUnits: 5_000_000n };

test("parseKind: legacy permanent and unknown values are the license", () => {
  assert.equal(parseKind("guarantee"), "guarantee");
  assert.equal(parseKind("permanent"), "license");
  assert.equal(parseKind(["guarantee", "license"]), "guarantee");
  assert.equal(parseKind(undefined), "license");
});

test("purchaseGuard order and D12", () => {
  assert.equal(purchaseGuard({ kind: "license", ...base }), null);
  assert.equal(purchaseGuard({ kind: "license", ...base, owned: true }), "owned");
  assert.equal(purchaseGuard({ kind: "license", ...base, sessionWallet: creator.toUpperCase().replace("0X", "0x") }), "creator");
  assert.equal(purchaseGuard({ kind: "license", ...base, supply: { max: 3, sold: 3, left: 0 } }), "sold_out");
  assert.equal(purchaseGuard({ kind: "license", ...base, totalUnits: 4_999_999n }), "below_min");
  // A guarantee never takes a license slot and is allowed for the creator (X11).
  assert.equal(purchaseGuard({ kind: "guarantee", ...base, sessionWallet: creator, supply: { max: 3, sold: 3, left: 0 } }), null);
});

test("guardOfError maps the server codes", () => {
  assert.equal(guardOfError("creator_cannot_buy"), "creator");
  assert.equal(guardOfError("sold_out"), "sold_out");
  assert.equal(guardOfError("platform_paused"), "paused");
  assert.equal(guardOfError("agent_not_listed"), "unavailable");
  assert.equal(guardOfError("price_changed"), null);
  assert.equal(guardOfError(undefined), null);
});

test("wallet coverage and default method", () => {
  assert.equal(walletCovers(10n, 10n), true);
  assert.equal(walletCovers(9n, 10n), false);
  assert.equal(walletCovers(null, 10n), false);
  assert.equal(defaultMethod({ pixEnabled: true, balanceUnits: 0n, totalUnits: 10n }), "pix");
  assert.equal(defaultMethod({ pixEnabled: true, balanceUnits: 10n, totalUnits: 10n }), "wallet");
  assert.equal(defaultMethod({ pixEnabled: false, balanceUnits: 0n, totalUnits: 10n }), "wallet");
  assert.equal(defaultMethod({ pixEnabled: true, balanceUnits: null, totalUnits: 10n }), "wallet");
  // USDC on Solana is never picked for the buyer, whatever the balance.
  for (const pixEnabled of [true, false])
    for (const balanceUnits of [null, 0n, 10n]) assert.notEqual(defaultMethod({ pixEnabled, balanceUnits, totalUnits: 10n }) as string, "solana");
});

test("pixPhase: the server status decides, the clock only warns", () => {
  const now = 1_000_000;
  assert.equal(pixPhase("pending_payment", now + 1, now), "waiting");
  assert.equal(pixPhase("pending_payment", now - 1, now), "due");
  assert.equal(pixPhase("created", now - 3 * 60_000, now), "lapsed");
  assert.equal(pixPhase("confirmed", now - 3 * 60_000, now), "paid");
  assert.equal(pixPhase("fulfilling", now, now), "paid");
  assert.equal(pixPhase("fulfilled", now, now), "done");
  assert.equal(pixPhase("refunded", now, now), "refund");
  assert.equal(pixPhase("expired", now + 10, now), "expired");
  assert.equal(pixPhase("failed", now + 10, now), "failed");
});

test("donePhase", () => {
  assert.equal(donePhase("fulfilled"), "ok");
  assert.equal(donePhase("pending_payment"), "waiting");
  assert.equal(donePhase("fulfilling"), "waiting");
  assert.equal(donePhase("refunded"), "failed");
  assert.equal(donePhase("expired"), "failed");
});

test("done URL keeps only a well-formed tx hash", () => {
  const hash = `0x${"AB".repeat(32)}`;
  assert.equal(doneHref({ slug: "a b", kind: "license", chargeId: "c1", txHash: hash }), `/checkout/done?agent=a+b&kind=license&charge=c1&tx=0x${"ab".repeat(32)}`);
  assert.equal(doneHref({ slug: "x", kind: "escrow", chargeId: "c2", txHash: "javascript:alert(1)" }), "/checkout/done?agent=x&kind=escrow&charge=c2");
  assert.equal(parseTxHash(hash), `0x${"ab".repeat(32)}`);
  assert.equal(parseTxHash("0x12"), null);
});

test("taskValid", () => {
  assert.deepEqual(taskValid("ab", "0123456789"), { titleOk: false, descOk: true });
  assert.deepEqual(taskValid("  Login form ", "short"), { titleOk: true, descOk: false });
});

test("solana pay: grace after the deadline, explorer links and safe URLs", () => {
  const now = 1_000_000_000;
  assert.equal(pixPhase("pending_payment", now - 4 * 60_000, now, SOLANA_GRACE_MS), "due", "still checked inside the 5 min grace");
  assert.equal(pixPhase("pending_payment", now - 6 * 60_000, now, SOLANA_GRACE_MS), "lapsed");
  const sig = "5".repeat(87);
  assert.equal(solanaTxUrl(sig, "devnet"), `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  assert.equal(solanaTxUrl(sig, "mainnet-beta"), `https://explorer.solana.com/tx/${sig}`);
  assert.equal(solanaTxUrl("0OIl" + "1".repeat(80), "devnet"), null, "not base58");
  assert.equal(solanaTxUrl(null, "devnet"), null);
  const url = "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=19&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  assert.equal(safeSolanaPayUrl(url), url);
  assert.equal(safeSolanaPayUrl("javascript:alert(1)"), null);
  assert.equal(safeSolanaPayUrl("solana:not-an-address"), null);
  assert.equal(safeExplorerUrl(`https://explorer.solana.com/tx/${sig}?cluster=devnet`), `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  assert.equal(safeExplorerUrl("https://evil.example/tx"), null);
});
