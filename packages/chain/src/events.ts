import { CONTRACT_KEYS, solversAbi, type ContractKey } from "@solvers/contracts-client";
import { parseEventLogs, type Address, type Log } from "viem";

import type { Deployment } from "./deployment.js";

export type SolversLog = ReturnType<typeof parseEventLogs<typeof solversAbi>>[number] & { contract: ContractKey };

/**
 * Decodes the Solvers events among `logs` (any order), keeping only logs emitted by the six deployed contracts and
 * tagging each with the contract it came from. Results are sorted by (blockNumber, logIndex), the order the indexer
 * processes them in (D9).
 */
export function parseSolversEvents(logs: readonly Log[], d: Pick<Deployment, ContractKey>): SolversLog[] {
  const byAddress = new Map<string, ContractKey>();
  for (const k of CONTRACT_KEYS) byAddress.set((d[k] as Address).toLowerCase(), k);
  const ours = logs.filter((l) => byAddress.has(l.address.toLowerCase()));
  if (ours.some((l) => l.blockNumber === null)) throw new Error("parseSolversEvents expects mined logs (blockNumber present)");
  const parsed = parseEventLogs({ abi: solversAbi, logs: ours as Log[], strict: true });
  return parsed
    .map((l) => Object.assign(l, { contract: byAddress.get(l.address.toLowerCase())! }))
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
    );
}
