import { defineChain, type Chain } from "viem";
import { tempo, tempoModerato } from "viem/chains";

/** Chain ids the platform supports: Tempo mainnet, Moderato testnet, local `anvil --tempo`. */
export const CHAIN_IDS = { mainnet: 4217, moderato: 42431, local: 31337 } as const;
export type SupportedChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id === CHAIN_IDS.mainnet || id === CHAIN_IDS.moderato || id === CHAIN_IDS.local;
}

/**
 * The viem chain for a supported id. Tempo mainnet and Moderato come from `viem/chains` (Tempo formatters and the 0x76
 * serializer); the local chain reuses Moderato's Tempo config with anvil's id and an explicit RPC URL.
 */
export function getChain(chainId: number, rpcUrl?: string): Chain {
  if (chainId === CHAIN_IDS.mainnet) return withRpc(tempo, rpcUrl);
  if (chainId === CHAIN_IDS.moderato) return withRpc(tempoModerato, rpcUrl);
  if (chainId === CHAIN_IDS.local) {
    return defineChain({
      ...tempoModerato,
      id: CHAIN_IDS.local,
      name: "Anvil (Tempo)",
      blockExplorers: undefined,
      rpcUrls: { default: { http: [rpcUrl ?? "http://127.0.0.1:8545"] } },
      testnet: true,
    });
  }
  throw new Error(`unsupported chain id ${chainId} (expected 4217, 42431 or 31337)`);
}

function withRpc(chain: Chain, rpcUrl: string | undefined): Chain {
  if (!rpcUrl) return chain;
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [rpcUrl] } } };
}

/** Network label shown to users ("Tempo", "Tempo Testnet", "Local"). */
export function networkLabel(chainId: number): string {
  if (chainId === CHAIN_IDS.mainnet) return "Tempo";
  if (chainId === CHAIN_IDS.moderato) return "Tempo Testnet";
  return "Local";
}
