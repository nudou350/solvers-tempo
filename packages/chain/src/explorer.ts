import { CHAIN_IDS } from "./chains.js";

const EXPLORERS: Record<number, string> = {
  [CHAIN_IDS.mainnet]: "https://explore.tempo.xyz",
  [CHAIN_IDS.moderato]: "https://explore.testnet.tempo.xyz",
};

/** Explorer base URL for a chain, or null for local chains (no explorer). */
export function explorerBase(chainId: number): string | null {
  return EXPLORERS[chainId] ?? null;
}

/**
 * Link to a transaction or an address on the chain's explorer; null when the chain has no explorer. `kind` defaults to
 * "tx" for 66-character values and "address" otherwise (pass it explicitly for bytes32 values that are not tx hashes).
 */
export function explorerUrl(chainId: number, value: string, kind?: "tx" | "address"): string | null {
  const base = explorerBase(chainId);
  if (!base) return null;
  return `${base}/${kind ?? (value.length === 66 ? "tx" : "address")}/${value}`;
}
