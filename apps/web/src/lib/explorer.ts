// Network explorer links and the network name shown to people, from the public config (`PublicConfig.explorerUrl`,
// e.g. https://explore.testnet.tempo.xyz on the Moderato testnet). Local chains have no explorer: links are null.
import { TEMPO_CHAIN_IDS, type PublicConfig } from "@solvers/api-client";
import { loadPublicConfigSync } from "./config-cache";

type ExplorerInfo = Pick<PublicConfig, "explorerUrl" | "chainId">;

function base(config: ExplorerInfo | null | undefined): string | null {
  const url = config?.explorerUrl?.trim().replace(/\/$/, "");
  if (!url || !/^https:\/\//.test(url)) return null;
  return url;
}

/** Explorer link of a transaction; null without a config or an explorer (local chain). */
export function txUrl(hash: string, config: ExplorerInfo | null | undefined = loadPublicConfigSync()): string | null {
  const b = base(config);
  return b && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${b}/tx/${hash}` : null;
}

/** Explorer link of an address (wallet or contract); null without a config or an explorer (local chain). */
export function addressUrl(addr: string, config: ExplorerInfo | null | undefined = loadPublicConfigSync()): string | null {
  const b = base(config);
  return b && /^0x[0-9a-fA-F]{40}$/.test(addr) ? `${b}/address/${addr}` : null;
}

/**
 * An explorer URL that arrived in a page parameter (e.g. /checkout/done?explorer=...): accepted only when it is https
 * on one of the Tempo explorers. Anything else is dropped (the caller falls back to `txUrl`).
 */
export function trustedExplorerUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (u.hostname === "explore.tempo.xyz" || u.hostname === "explore.testnet.tempo.xyz") ? u.toString() : null;
  } catch {
    return null;
  }
}

export type NetworkKind = "mainnet" | "testnet" | "local";

/** Which kind of network the chain id is (used for the header label and the test-only features). */
export function networkKind(chainId: number): NetworkKind {
  if (chainId === TEMPO_CHAIN_IDS.mainnet) return "mainnet";
  if (chainId === TEMPO_CHAIN_IDS.testnet) return "testnet";
  return "local";
}
