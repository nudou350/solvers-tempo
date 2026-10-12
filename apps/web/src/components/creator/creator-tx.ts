// Builders of the creator operations on a registered Solver (POST /api/tx/creator/:idOrSlug/...), through the typed API
// client. Each one returns the calls of ONE sponsored batch (`TxResponse`) that the creator's wallet sends through
// `runTx`. The server checks the contract rules first (creator only, royalty locked after the first sale, raise-only cap,
// stake exit dates) and simulates the batch, so a refusal comes back as an `ApiError` with a code before the wallet opens.
import { api } from "@/lib/api";

export const creatorTx = {
  /** Pay-per-use price of the credits, in base units ("0" turns credits off). The license price stays the approved one. */
  pricing: (idOrSlug: string, pricePerUseUnits: string) => api.buildCreatorPricing(idOrSlug, pricePerUseUnits),
  /** Creator share of the transfer royalty, in bps (only before the first sale). */
  royalty: (idOrSlug: string, royaltyBps: number) => api.buildCreatorRoyalty(idOrSlug, royaltyBps),
  /** License cap: the first cap needs at least max(1, sold); afterwards it can only go up. */
  supplyCap: (idOrSlug: string, max: number) => api.buildCreatorSupplyCap(idOrSlug, max),
  /** Points the on-chain metadata link at the Solver's public page data (the server picks the URL). */
  metadata: (idOrSlug: string) => api.buildCreatorMetadata(idOrSlug),
  stakeTopUp: (idOrSlug: string, amountUnits: string) => api.buildStakeTopUp(idOrSlug, amountUnits),
  stakeExit: (idOrSlug: string) => api.buildStakeExit(idOrSlug),
  stakeCancelExit: (idOrSlug: string) => api.buildStakeCancelExit(idOrSlug),
  stakeWithdraw: (idOrSlug: string) => api.buildStakeWithdraw(idOrSlug),
  /** Contests a proposed stake penalty once; the reason stays off-chain (its hash goes on-chain). */
  slashContest: (idOrSlug: string, reason: string) => api.buildSlashContest(idOrSlug, reason),
};

export type CreatorTxKind = keyof typeof creatorTx;
