// Development wallet: a secp256k1 key generated in this browser and kept in localStorage (viem local account). Only for
// test networks and only when the build sets NEXT_PUBLIC_ALLOW_DEV_WALLET=1; refused on Tempo mainnet (chain 4217),
// both by the build-time chain id and by the chain id the API reports. No React here, so the rules are unit-tested.
import { TEMPO_CHAIN_IDS } from "@solvers/shared";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const DEV_WALLET_STORAGE_KEY = "solvers.devWallet.evm.v1";

/** Why the dev wallet cannot be used here, or null when it can. */
export type DevWalletBlock = "not-enabled" | "mainnet" | "unknown-network";

/**
 * The dev wallet rule: enabled by the build flag, and never on mainnet. `buildChainId` is NEXT_PUBLIC_CHAIN_ID (may be
 * absent); `runtimeChainId` is `PublicConfig.chainId` (null while the config loads: refused until the network is known).
 */
export function devWalletBlock(o: { allowFlag: string | undefined; buildChainId: string | number | undefined; runtimeChainId: number | null }): DevWalletBlock | null {
  if (o.allowFlag !== "1") return "not-enabled";
  const built = o.buildChainId === undefined || o.buildChainId === "" ? null : Number(o.buildChainId);
  if (built === TEMPO_CHAIN_IDS.mainnet || o.runtimeChainId === TEMPO_CHAIN_IDS.mainnet) return "mainnet";
  if (o.runtimeChainId === null) return "unknown-network";
  return null;
}

/** Same rule with this build's env (NEXT_PUBLIC_* are inlined at build time). */
export function devWalletBlockHere(runtimeChainId: number | null): DevWalletBlock | null {
  return devWalletBlock({
    allowFlag: process.env.NEXT_PUBLIC_ALLOW_DEV_WALLET,
    buildChainId: process.env.NEXT_PUBLIC_CHAIN_ID,
    runtimeChainId,
  });
}

/** True when this build may offer the dev wallet at all (before the network is known). */
export const DEV_WALLET_ENABLED =
  process.env.NEXT_PUBLIC_ALLOW_DEV_WALLET === "1" && Number(process.env.NEXT_PUBLIC_CHAIN_ID) !== TEMPO_CHAIN_IDS.mainnet;

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): KeyStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const KEY_RE = /^0x[0-9a-f]{64}$/;

/** The stored dev key, or null. A malformed value is ignored (never thrown, never logged). */
export function readDevKey(store: KeyStore | null = browserStore()): Hex | null {
  try {
    const v = store?.getItem(DEV_WALLET_STORAGE_KEY)?.trim().toLowerCase();
    return v && KEY_RE.test(v) ? (v as Hex) : null;
  } catch {
    return null;
  }
}

/** Loads the dev account of this browser; with `create`, generates and stores a new key when there is none. */
export function loadDevAccount(create: boolean, store: KeyStore | null = browserStore()): PrivateKeyAccount | null {
  let key = readDevKey(store);
  if (!key) {
    if (!create) return null;
    key = generatePrivateKey();
    try {
      store?.setItem(DEV_WALLET_STORAGE_KEY, key);
    } catch {
      // no storage: the wallet lives only in this tab
    }
  }
  return privateKeyToAccount(key);
}

/** Forgets the dev key of this browser (the next sign-in creates another wallet). */
export function forgetDevKey(store: KeyStore | null = browserStore()): void {
  try {
    store?.removeItem(DEV_WALLET_STORAGE_KEY);
  } catch {
    // ignore
  }
}
