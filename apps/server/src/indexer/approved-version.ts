// "Chain version vs version approved by review" (PACKAGE_SPEC.md 15.4). Pure: no env, no database.
//
// A creator may call `updateVersion`/`updatePricing` directly on-chain, bypassing review. The indexer does not copy
// version, hash and price blindly: it checks them against `agent_published_versions`. On a mismatch the mirror keeps
// what was approved (the store and the served package stay on the approved version) and `agents.sync_flag` becomes
// `unapproved_chain_version` (sales blocked: `price_in_review`). When the chain reverts, or a new approval covers the
// hash, it returns to `ok`.

export const SYNC_OK = "ok" as const;
export const SYNC_UNAPPROVED = "unapproved_chain_version" as const;
export type SyncFlag = typeof SYNC_OK | typeof SYNC_UNAPPROVED;

/** What the chain says about the version (hash as hex, price in token base units). */
export type ChainVersion = { version: string; versionHash: string; price: bigint };

/** One row of `agent_published_versions`. */
export type ApprovedVersion = { version: string; versionHash: string; priceUsdc: bigint };

/** Hashes compare case-insensitively and with or without the 0x prefix. */
const normHash = (h: string) => h.toLowerCase().replace(/^0x/, "");

/**
 * The chain is "approved" only if version, hash AND price match ONE approved version of the agent. Older versions count:
 * the creator may revert to a version that already passed review. Changing only the price (`updatePricing`) diverges too.
 */
export function chainMatchesApproved(chain: ChainVersion, approved: readonly ApprovedVersion[]): boolean {
  const hash = normHash(chain.versionHash);
  return approved.some((a) => a.version === chain.version && normHash(a.versionHash) === hash && a.priceUsdc === chain.price);
}

export function syncFlagFor(chain: ChainVersion, approved: readonly ApprovedVersion[]): SyncFlag {
  return chainMatchesApproved(chain, approved) ? SYNC_OK : SYNC_UNAPPROVED;
}

type Mirrorable = { version: string; versionHash: string; price: bigint };

/**
 * Applies the verdict to the mirror values. Approved: copy everything (version, hash and price included) and the flag
 * goes to `ok`. Diverging: REMOVE version, hash and price from what will be written (the existing row keeps them) and
 * raise the flag.
 */
export function withApprovalFlag<T extends Mirrorable>(values: T, approved: readonly ApprovedVersion[]): Omit<T, "version" | "versionHash" | "price"> & Partial<Mirrorable> & { syncFlag: SyncFlag } {
  const flag = syncFlagFor(values, approved);
  if (flag === SYNC_OK) return { ...values, syncFlag: flag };
  const { version: _v, versionHash: _h, price: _p, ...rest } = values;
  return { ...rest, syncFlag: flag };
}
