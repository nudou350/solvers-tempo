// ABIs and deployment addresses of the six Solvers contracts.
// src/generated is produced by `pnpm --filter @solvers/contracts-client generate` (never edit it by hand).
export {
  solversRegistryAbi,
  solversLicenseAbi,
  solversCreditsAbi,
  solversReviewsAbi,
  solversEscrowAbi,
  solversStakingAbi,
} from "./generated/abis.js";
export { deployments, type SolversDeployment } from "./generated/addresses.js";

import {
  solversCreditsAbi,
  solversEscrowAbi,
  solversLicenseAbi,
  solversRegistryAbi,
  solversReviewsAbi,
  solversStakingAbi,
} from "./generated/abis.js";

/** Union of every Solvers ABI (events and custom errors of all six contracts), for log and error decoding. */
export const solversAbi = [
  ...solversRegistryAbi,
  ...solversLicenseAbi,
  ...solversCreditsAbi,
  ...solversReviewsAbi,
  ...solversEscrowAbi,
  ...solversStakingAbi,
] as const;

export const CONTRACT_KEYS = ["registry", "license", "credits", "reviews", "escrow", "staking"] as const;
export type ContractKey = (typeof CONTRACT_KEYS)[number];
