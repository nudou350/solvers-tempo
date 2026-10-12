// Network name key (messages catalog.json -> network.<key>) for a chain id from the public config.
import { networkOf } from "@solvers/shared";

export type NetworkKey = "mainnet" | "testnet" | "local";

export function networkKey(chainId: number): NetworkKey {
  return networkOf(chainId) ?? "local";
}
