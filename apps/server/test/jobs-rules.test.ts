import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { batchVerdict, merkleRoot } from "../src/jobs.js";

// Usage batches: the outcome of a non-idempotent batch is decided only from its tx journal (sent_txs) and receipts.

const sha = (s: string) => createHash("sha256").update(s).digest();
const now = new Date("2026-10-11T12:00:00Z");
const past = new Date(now.getTime() - 60_000);
const future = new Date(now.getTime() + 60_000);

describe("batchVerdict", () => {
  it("no journaled transaction: waits, then releases the uses (never signed)", () => {
    assert.equal(batchVerdict([], 30, now), "pending");
    assert.equal(batchVerdict([], 300, now), "released");
  });

  it("a confirmed transaction (journal or receipt) wins", () => {
    assert.equal(batchVerdict([{ status: "confirmed", hasReceipt: true, receiptOk: true, validBefore: past }], 10, now), "confirmed");
    assert.equal(batchVerdict([{ status: "failed", hasReceipt: true, receiptOk: true, validBefore: past }], 10, now), "confirmed");
  });

  it("reverted, or past validBefore without a receipt (expired / failed broadcast): released", () => {
    assert.equal(batchVerdict([{ status: "reverted", hasReceipt: true, receiptOk: false, validBefore: past }], 10, now), "released");
    assert.equal(batchVerdict([{ status: "expired", hasReceipt: false, receiptOk: null, validBefore: past }], 10, now), "released");
    assert.equal(batchVerdict([{ status: "failed", hasReceipt: false, receiptOk: null, validBefore: past }], 10, now), "released");
  });

  it("still within validBefore without a receipt: waits (it may still land)", () => {
    assert.equal(batchVerdict([{ status: "pending", hasReceipt: false, receiptOk: null, validBefore: future }], 10, now), "pending");
    assert.equal(batchVerdict([{ status: "failed", hasReceipt: false, receiptOk: null, validBefore: future }], 10, now), "pending");
  });
});

describe("merkleRoot", () => {
  it("empty is 32 zero bytes; one leaf is the leaf; order of a pair does not matter", () => {
    assert.deepEqual(merkleRoot([]), Buffer.alloc(32));
    assert.deepEqual(merkleRoot([sha("a")]), sha("a"));
    assert.deepEqual(merkleRoot([sha("a"), sha("b")]), merkleRoot([sha("b"), sha("a")]));
    assert.equal(merkleRoot([sha("a"), sha("b"), sha("c")]).length, 32);
  });
});

describe("receiptOrMissing (usage batch reconcile)", () => {
  it("only TransactionReceiptNotFoundError means missing; any other RPC error is rethrown (skip this tick)", async () => {
    const { TransactionReceiptNotFoundError } = await import("viem");
    const { receiptOrMissing } = await import("../src/jobs.js");
    const hash = `0x${"1".repeat(64)}` as const;
    assert.equal(await receiptOrMissing(async () => { throw new TransactionReceiptNotFoundError({ hash }); }), null);
    assert.deepEqual(await receiptOrMissing(async () => ({ status: "success" })), { status: "success" });
    await assert.rejects(receiptOrMissing(async () => { throw new Error("fetch failed: ECONNREFUSED"); }), /ECONNREFUSED/);
    const timeout = Object.assign(new Error("took too long"), { name: "TimeoutError" });
    await assert.rejects(receiptOrMissing(async () => { throw timeout; }), /took too long/);
  });
});
