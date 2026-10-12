import { HttpError, badRequest } from "../lib/http.js";

/** Pure rule: what stops this wallet from buying a license? (null = it can). No database or RPC. */
export function purchaseBlock(input: { wallet: string; creatorWallet: string | null; ownedLicenseId: string | null }): HttpError | null {
  if (input.ownedLicenseId) {
    return new HttpError(409, "You already have this specialist's license.", "already_owned", { licenseId: input.ownedLicenseId });
  }
  // D12: the contract also refuses it (`SelfPurchase`); this answers before any call is built.
  if (input.creatorWallet && input.creatorWallet.toLowerCase() === input.wallet.toLowerCase()) {
    return badRequest("The specialist's creator can't buy their own license.", "creator_cannot_buy");
  }
  return null;
}

/**
 * Pure rule: only what the storefront lists AND the server can load is sold. A Solver that is Active on-chain but whose
 * publication failed (`publish_failed`, `listed = false`, no folder on disk) would charge for something that cannot be
 * delivered.
 */
export function notListedBlock(input: { listed: boolean; hasPackage: boolean }): HttpError | null {
  if (input.listed && input.hasPackage) return null;
  return new HttpError(409, "This specialist is not available in the catalog yet.", "agent_not_listed");
}
