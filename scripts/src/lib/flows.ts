// Flows shared by the e2e scripts: catalog lookups, a direct-wallet license purchase through the API, on-chain reads.
import { parseSolversEvents } from "@solvers/chain";
import { solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";
import { agentIdToBytes32 } from "@solvers/shared";
import type { Hex, TransactionReceipt } from "viem";
import { network, sleep } from "../env.js";
import { get } from "./http.js";
import type { TestWallet } from "./wallet.js";

export type AgentRow = { id: string; slug: string; name: string; priceUsdc: number; royaltyBps: number; trialAvailable: boolean; guaranteeAvailable: boolean; creatorId: string; platform: boolean };
export type AgentDetail = {
  agent: AgentRow;
  trial: { uses: number; steps: number; totalSteps: number; searches: number; tools: { name: string; limit: number }[] } | null;
  guarantee: { priceUsdc: number; milestones: { title: string; criteria: string[] }[] } | null;
  onchain: { agentId: Hex | null; creatorWallet: string | null };
};
export type PublicConfig = {
  chainId: number;
  feeBps: number | null;
  royalty: { creatorBps: number; platformBps: number | null };
  minPriceUnits: string;
  faucetEnabled: boolean;
  pix: { enabled: boolean; simulate: boolean; provider: string | null };
  /** Absent on servers older than the Solana Pay checkout. */
  solanaPay?: { enabled: boolean; cluster: "devnet" | "mainnet-beta"; mint: string; recipient: string | null; tokenSymbol: string };
  agentPay: { enabled: boolean; minPriceUnits: string; maxPriceUnits: string };
  guaranteeMinSales: number;
  guaranteeMinRating: number;
  paymentToken: { address: string; symbol: string; decimals: number };
};

export const getConfig = () => get<PublicConfig>("/api/config");

/** Catalog entry by slug or id (404 -> clear error naming the publish command). */
export async function agentDetail(idOrSlug: string): Promise<AgentDetail> {
  try {
    return await get<AgentDetail>(`/api/agents/${encodeURIComponent(idOrSlug)}`);
  } catch (e) {
    throw new Error(`Solver ${idOrSlug} is not in the catalog of the API under test (publish it: cli:publish ${idOrSlug}): ${(e as Error).message}`);
  }
}

/** On-chain agent state (Registry.getAgent). */
export async function chainAgent(agentId: string) {
  const n = await network();
  return n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "getAgent", args: [agentIdToBytes32(agentId)] });
}

/** Registry config read on-chain (independent of the API's /api/config). */
export async function registryConfig() {
  const n = await network();
  const [treasury, feeBps, platformRoyaltyBps, , minStake, minPrice] = await n.publicClient.readContract({
    address: n.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "config",
  });
  return { treasury: treasury.toLowerCase() as Hex, feeBps: Number(feeBps), platformRoyaltyBps: Number(platformRoyaltyBps), minStake, minPrice };
}

/**
 * Transfer royalty computed here with plain bigint arithmetic (D15: each share = floor(originalPrice * bps / 10_000),
 * platform share capped so the total stays <= 2500 bps), so the scripts never check the API against the same helper.
 */
export function expectedRoyalty(originalPrice: bigint, creatorBps: number, platformBps: number) {
  const platform = Math.min(platformBps, 2500 - creatorBps);
  const creatorAmount = (originalPrice * BigInt(creatorBps)) / 10_000n;
  const platformAmount = (originalPrice * BigInt(platform)) / 10_000n;
  return { creatorAmount, platformAmount, total: creatorAmount + platformAmount };
}

export async function ownerOf(tokenId: bigint): Promise<string> {
  const n = await network();
  return (await n.publicClient.readContract({ address: n.deployment.license, abi: solversLicenseAbi, functionName: "ownerOf", args: [tokenId] })).toLowerCase();
}

export async function licenseOf(tokenId: bigint) {
  const n = await network();
  const [agentId, originalPrice, mintedAt, reviewId] = await n.publicClient.readContract({
    address: n.deployment.license,
    abi: solversLicenseAbi,
    functionName: "licenseOf",
    args: [tokenId],
  });
  return { agentId, originalPrice, mintedAt, reviewId };
}

/** Decoded Solvers events of a receipt. */
export async function eventsOf(receipt: TransactionReceipt) {
  const n = await network();
  return parseSolversEvents(receipt.logs, n.deployment);
}

/** Token id minted by a purchase receipt (LicensePurchased). */
export async function mintedTokenId(receipt: TransactionReceipt): Promise<bigint> {
  const e = (await eventsOf(receipt)).find((x) => x.eventName === "LicensePurchased");
  if (!e) throw new Error(`no LicensePurchased event in ${receipt.transactionHash}`);
  return (e.args as { tokenId: bigint }).tokenId;
}

export type Purchase = { tokenId: bigint; txHash: Hex; receipt: TransactionReceipt; chargeId: string; purchaseId: Hex; amountUnits: bigint };

/** Direct-wallet license purchase: intent (ledger row + calls) -> wallet sends through the relay -> confirm. */
export async function buyLicense(w: TestWallet, agentId: string, expectedPriceUnits?: bigint): Promise<Purchase> {
  const intent = await w.post<{ calls: { to: Hex; data: Hex }[]; purchaseId: Hex; chargeId: string; amountUnits: string; feePayer: boolean }>("/api/purchases/intent", {
    kind: "license",
    agentId,
    ...(expectedPriceUnits !== undefined ? { expectedPriceUnits: expectedPriceUnits.toString() } : {}),
  });
  if (intent.feePayer !== true) throw new Error(`intent without feePayer: ${JSON.stringify(intent)}`);
  const sent = await w.sendAndConfirm(intent.calls);
  return {
    tokenId: await mintedTokenId(sent.receipt),
    txHash: sent.txHash,
    receipt: sent.receipt,
    chargeId: intent.chargeId,
    purchaseId: intent.purchaseId,
    amountUnits: BigInt(intent.amountUnits),
  };
}

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 1500): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}`);
}

export const randomHex32 = (): Hex => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
