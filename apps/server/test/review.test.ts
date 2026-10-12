import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sha256Hex } from "../src/lib/crypto.js";
import { chooseReviewLicense, resolvePublishedText, textMatchesHash } from "../src/store/review-rules.js";

// Reviews: the off-chain text only counts if its sha256 is the hash confirmed on-chain (no env or database).

const h = sha256Hex;

describe("textMatchesHash", () => {
  it("matches only the same text", () => {
    assert.equal(textMatchesHash("ótimo", h("ótimo")), true);
    assert.equal(textMatchesHash("ótimo!", h("ótimo")), false);
    assert.equal(textMatchesHash("", h("")), true);
  });
});

describe("resolvePublishedText (syncReview)", () => {
  it("publishes the draft with the same hash", () => {
    assert.equal(resolvePublishedText(h("versão B"), ["versão B", "versão A"]), "versão B");
  });

  it("two prepared versions, the signed one is A: publishes A, never B", () => {
    // Draft B is the last one prepared, but the chain confirmed A's hash.
    assert.equal(resolvePublishedText(h("A"), ["A", "B"]), "A");
    assert.equal(resolvePublishedText(h("A"), [undefined, "B"]), "");
  });

  it("without a draft it keeps the already published text if it matches (only the rating changed)", () => {
    assert.equal(resolvePublishedText(h("texto antigo"), [undefined, "texto antigo"]), "texto antigo");
  });

  it("no candidate matches (review made directly on the chain): empty text", () => {
    assert.equal(resolvePublishedText(h("algo que ninguém tem"), [undefined, "texto antigo"]), "");
    assert.equal(resolvePublishedText(h("x"), []), "");
  });

  it("review without text: the empty hash publishes empty", () => {
    assert.equal(resolvePublishedText(h(""), ["ignorado"]), "");
  });
});

describe("chooseReviewLicense (transferred license)", () => {
  it("uses the first license whose review has not been spent yet", () => {
    assert.deepEqual(chooseReviewLicense([{ id: "A", used: true }, { id: "B", used: false }], false), { kind: "use", asset: "B" });
    assert.deepEqual(chooseReviewLicense([{ id: "A", used: false }], false), { kind: "use", asset: "A" });
  });

  it("all spent by the previous owner: all_used (clear error, without attempting the transaction)", () => {
    assert.deepEqual(chooseReviewLicense([{ id: "A", used: true }], false), { kind: "all_used" });
  });

  it("all spent and the wallet itself already reviewed: proceeds so the contract refuses the repeated review", () => {
    assert.deepEqual(chooseReviewLicense([{ id: "A", used: true }, { id: "B", used: true }], true), { kind: "use", asset: "A" });
  });

  it("no license: none", () => {
    assert.deepEqual(chooseReviewLicense([], false), { kind: "none" });
    assert.deepEqual(chooseReviewLicense([], true), { kind: "none" });
  });
});
