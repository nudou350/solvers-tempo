// Public surface of the indexer (D9). Wiring: `indexerJob` in src/jobs.ts; `processTxHash(hash)` right after every
// server-sent or user-confirmed transaction; `onGovernanceChange` for cache invalidation; `onChainEvent` for reactions.

export { processTxHash, onChainEvent, retryFailures, reviveDeadFailures, reprocessTxs, type ProcessStats } from "./processor.js";
export { indexerJob, pollOnce, scanRange, startIndexer, stopIndexer, type PollOptions, type PollResult } from "./poller.js";
export { onGovernanceChange, type GovernanceChange } from "./governance.js";
export {
  loadApprovedVersions,
  refreshLicenseOwner,
  syncAgent,
  syncCredits,
  syncEscrow,
  syncLicense,
  syncReputation,
  syncReview,
} from "./sync.js";
