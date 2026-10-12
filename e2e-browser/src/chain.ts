// On-chain checks of the browser e2e: the scripts' helpers (scripts/src/env.ts, lib/flows.ts) plus what the browser
// tests need on top (balances of several addresses, roles, fee payer, decoded events). Nothing here trusts the page.
import "./env.js";
import { solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";
import { keccak256, toHex, type Address, type Hex, type TransactionReceipt } from "viem";
import { fmt, fund as fundOnce, network, serverAccount, sleep, tokenBalance, units } from "../../scripts/src/env.js";
import { agentDetail, chainAgent, eventsOf, expectedRoyalty, getConfig, licenseOf, ownerOf, registryConfig, waitFor } from "../../scripts/src/lib/flows.js";
import { get } from "../../scripts/src/lib/http.js";
import { IS_PROD } from "./env.js";

export { agentDetail, chainAgent, eventsOf, expectedRoyalty, fmt, get, getConfig, licenseOf, network, ownerOf, registryConfig, tokenBalance, units, waitFor };

export const lower = (a: string) => a.toLowerCase();

/**
 * Test funds (scripts' fund(): anvil dev account 0 locally, the Moderato faucet on the testnet). Parallel workers share
 * that funder, so two transfers can race for the same nonce: retried after a random pause. fund() re-reads the balance
 * first, so a retry never over-funds.
 */
export async function fund(address: Address, min: bigint): Promise<Hex[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fundOnce(address, min);
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(500 + Math.floor(Math.random() * 2500));
    }
  }
}

/** Receipt of a Tempo transaction, waited for (the page may show the hash a moment before it is mined). */
export async function receiptOf(hash: string): Promise<TransactionReceipt> {
  const n = await network();
  return n.publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 90_000 });
}

/** Fee payer recorded in a Tempo 0x76 receipt (the relay or the server's in-process fee payer when sponsored). */
export const feePayerOf = (r: TransactionReceipt): string => String((r as unknown as { feePayer?: string }).feePayer ?? "").toLowerCase();

/** Payment-token balances of several addresses at once (base units). */
export async function balances<K extends string>(who: Record<K, string>): Promise<Record<K, bigint>> {
  const entries = await Promise.all(Object.entries(who).map(async ([k, a]) => [k, await tokenBalance(a as Address)] as const));
  return Object.fromEntries(entries) as Record<K, bigint>;
}

export const delta = <K extends string>(before: Record<K, bigint>, after: Record<K, bigint>): Record<K, bigint> =>
  Object.fromEntries(Object.keys(before).map((k) => [k, after[k as K] - before[k as K]])) as unknown as Record<K, bigint>;

const PLATFORM_ROLE = keccak256(toHex("PLATFORM_ROLE"));

/** True when `who` holds PLATFORM_ROLE in the Registry (read on-chain: works without the server's keys). */
export async function isPlatform(who: string): Promise<boolean> {
  const n = await network();
  return n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "hasRole", args: [PLATFORM_ROLE, who as Address] });
}

/** RELAY (fee payer) address: known only for the local QA stack (its key is in .env.qa). */
export function relayAddress(): string | null {
  if (IS_PROD) return null;
  return lower(serverAccount("RELAY_PRIVATE_KEY").address);
}

/** Licenses held by `who` (ERC-721 balanceOf). */
export async function licenseCount(who: string): Promise<bigint> {
  const n = await network();
  return n.publicClient.readContract({ address: n.deployment.license, abi: solversLicenseAbi, functionName: "balanceOf", args: [who as Address] });
}

/** Decoded Solvers events of a receipt, by name. */
export async function eventArgs<T = Record<string, unknown>>(receipt: TransactionReceipt, name: string): Promise<T[]> {
  return (await eventsOf(receipt)).filter((e) => e.eventName === name).map((e) => e.args as T);
}

/** Explorer link of a Tempo transaction (null on the local chain, which has no explorer). */
export async function tempoTxLink(hash: string): Promise<string | null> {
  const n = await network();
  const link = n.explorer(hash);
  return link === hash ? null : link;
}

/** PLATFORM key address of the local QA stack (.env.qa); mode B checks PLATFORM_ROLE on chain instead. */
export function serverPlatform(): string {
  if (IS_PROD) throw new Error("the PLATFORM key is only known on the local QA stack: check isPlatform() instead");
  return lower(serverAccount("PLATFORM_PRIVATE_KEY").address);
}
