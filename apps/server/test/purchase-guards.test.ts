import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpError } from "../src/lib/http.js";
import { notListedBlock, purchaseBlock } from "../src/store/purchase-rules.js";

// Purchase guards (purchase intents, Pix, agent-pay). Pure rules, no database or RPC.

const W = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";

describe("purchaseBlock", () => {
  it("a wallet without the license that is not the creator can buy", () => {
    assert.equal(purchaseBlock({ wallet: W, creatorWallet: CREATOR, ownedLicenseId: null }), null);
    assert.equal(purchaseBlock({ wallet: W, creatorWallet: null, ownedLicenseId: null }), null);
  });

  it("license already owned: 409 already_owned with licenseId", () => {
    const e = purchaseBlock({ wallet: W, creatorWallet: CREATOR, ownedLicenseId: "7" });
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "already_owned");
    assert.equal(e.extra?.licenseId, "7");
  });

  it("the Solver's creator does not buy (D12): 400 creator_cannot_buy, case-insensitive", () => {
    const e = purchaseBlock({ wallet: CREATOR, creatorWallet: CREATOR.toUpperCase().replace("0X", "0x"), ownedLicenseId: null });
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "creator_cannot_buy");
  });

  it("already owned wins over creator (stable answer)", () => {
    assert.equal(purchaseBlock({ wallet: CREATOR, creatorWallet: CREATOR, ownedLicenseId: "1" })?.code, "already_owned");
  });
});

describe("notListedBlock", () => {
  it("sells only what is listed AND loadable", () => {
    assert.equal(notListedBlock({ listed: true, hasPackage: true }), null);
    assert.equal(notListedBlock({ listed: false, hasPackage: true })?.code, "agent_not_listed");
    assert.equal(notListedBlock({ listed: true, hasPackage: false })?.code, "agent_not_listed");
  });
});
