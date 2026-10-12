import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_KEYS, deployments, solversAbi, solversLicenseAbi, solversRegistryAbi } from "./index.js";

const names = (abi: readonly { type: string; name?: string }[], type: string) =>
  new Set(abi.filter((i) => i.type === type).map((i) => i.name));

test("generated ABIs expose the purchase, royalty and registry surface", () => {
  const license = names(solversLicenseAbi, "function");
  for (const f of ["purchaseLicense", "purchaseLicenseFor", "transferWithRoyalty", "quoteRoyalty", "royaltyInfo", "claim"]) {
    assert.ok(license.has(f), f);
  }
  const registry = names(solversRegistryAbi, "function");
  for (const f of ["registerAgent", "approveAgent", "authorizeSale", "currentEval", "purchaseRef", "royaltyParams"]) {
    assert.ok(registry.has(f), f);
  }
});

test("the union ABI carries every custom error and event needed for decoding", () => {
  const errors = names(solversAbi, "error");
  for (const e of ["SoldOut", "PriceChanged", "DuplicatePurchase", "RoyaltyNotPaid", "Paused", "SelfPurchase", "FeeOnTransferToken"]) {
    assert.ok(errors.has(e), e);
  }
  const events = names(solversAbi, "event");
  for (const e of ["LicensePurchased", "RoyaltyPaid", "SaleAuthorized", "EscrowCreated", "PayoutDeferred", "ReviewSubmitted"]) {
    assert.ok(events.has(e), e);
  }
});

test("deployments only list public networks with all six contracts", () => {
  for (const d of Object.values(deployments)) {
    assert.notEqual(d.chainId, 31337);
    for (const k of CONTRACT_KEYS) assert.match(d[k], /^0x[0-9a-fA-F]{40}$/);
  }
});
