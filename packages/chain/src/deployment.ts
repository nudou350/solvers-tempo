import { readFileSync } from "node:fs";
import { deployments, CONTRACT_KEYS, type ContractKey } from "@solvers/contracts-client";
import { getAddress, type Address } from "viem";

/** Addresses of one deployment (`deployments/<chainId>.json`, written by contracts/script/Deploy.s.sol). */
export type Deployment = {
  chainId: number;
  token: Address;
  treasury: Address;
  deployBlock: bigint;
  gitSha: string;
} & Record<ContractKey, Address>;

/**
 * Loads the deployment for `chainId`: from `file` when given (local anvil, or an override), otherwise from the
 * addresses generated into @solvers/contracts-client. `overrides` (e.g. `CONTRACT_LICENSE`) replace single addresses.
 */
export function loadDeployment(
  chainId: number,
  options: { file?: string | undefined; overrides?: Partial<Record<ContractKey, string>> } = {},
): Deployment {
  let raw: Record<string, unknown> | undefined;
  if (options.file) raw = JSON.parse(readFileSync(options.file, "utf8")) as Record<string, unknown>;
  else raw = deployments[chainId] as unknown as Record<string, unknown> | undefined;
  if (!raw) throw new Error(`no Solvers deployment for chain ${chainId} (set DEPLOYMENTS_FILE or regenerate the client)`);
  if (Number(raw.chainId) !== chainId) throw new Error(`deployment file is for chain ${String(raw.chainId)}, expected ${chainId}`);
  const out: Record<string, unknown> = {
    chainId,
    token: getAddress(String(raw.token)),
    treasury: getAddress(String(raw.treasury)),
    deployBlock: requireBlock(raw.deployBlock, chainId),
    gitSha: String(raw.gitSha ?? ""),
  };
  for (const k of CONTRACT_KEYS) out[k] = getAddress(String(options.overrides?.[k] ?? raw[k]));
  return out as Deployment;
}

function requireBlock(v: unknown, chainId: number): bigint {
  if (v === undefined || v === null || v === "") throw new Error(`deployment for chain ${chainId} has no deployBlock (the indexer would scan from genesis)`);
  return BigInt(String(v));
}
