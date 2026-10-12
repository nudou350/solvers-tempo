// The chain Privy is configured with. PrivyProvider takes its chains once, at mount, before `/api/config` loads, so the
// chain comes from the build (NEXT_PUBLIC_CHAIN_ID). A build without it falls back to the Moderato testnet; next.config.ts
// warns at build time and the wallet layer refuses to sign with Privy when the API reports another chain. No React and
// no Privy import here (unit-tested, and importable without loading the Privy SDK).
import { tempo, tempoModerato } from "viem/chains";

/** The Privy chain for a build: Tempo mainnet only when the build targets chain 4217, else the Moderato testnet. */
export function privyChain(chainId: number | null) {
  return chainId === tempo.id ? tempo : tempoModerato;
}

/** NEXT_PUBLIC_CHAIN_ID of this build (inlined at build time), or null when the build does not set it. */
export const BUILD_CHAIN_ID: number | null = Number(process.env.NEXT_PUBLIC_CHAIN_ID) || null;

/**
 * Null when Privy's chain for this build is the chain the API serves; otherwise the two ids. A mismatch means every
 * Privy signature would be for the wrong network, so the wallet layer refuses to sign.
 */
export function privyChainMismatch(buildChainId: number | null, runtimeChainId: number): { privy: number; api: number } | null {
  const privy = privyChain(buildChainId).id;
  return privy === runtimeChainId ? null : { privy, api: runtimeChainId };
}
