import {
  solversCreditsAbi,
  solversEscrowAbi,
  solversLicenseAbi,
  solversRegistryAbi,
  solversStakingAbi,
} from "@solvers/contracts-client";
import { decodeSolversError, type Deployment } from "@solvers/chain";
import { agentIdToBytes32 } from "@solvers/shared";
import { erc20Abi, type Address, type Hex } from "viem";

import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { createCachedReader } from "./pause-rules.js";

// Contract reads used by the store, runtime and MCP routes (always through the chain context built at boot).
// Every function throws on RPC errors; callers decide whether that fails open or closed.

/** The deployment when the chain context is initialized (null in route tests without a chain). */
export function deploymentOrNull(): Deployment | null {
  try {
    return chainContext().deployment;
  } catch {
    return null;
  }
}

export type RegistryConfig = {
  treasury: Address;
  feeBps: number;
  platformRoyaltyBps: number;
  pauseFlags: number;
  minStake: bigint;
  minPrice: bigint;
};

async function fetchRegistryConfig(): Promise<RegistryConfig> {
  const c = chainContext();
  const [treasury, feeBps, platformRoyaltyBps, flags, minStake, minPrice] = await c.publicClient.readContract({
    address: c.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "config",
  });
  return {
    treasury: treasury.toLowerCase() as Address,
    feeBps: Number(feeBps),
    platformRoyaltyBps: Number(platformRoyaltyBps),
    pauseFlags: Number(flags),
    minStake: BigInt(minStake),
    minPrice: BigInt(minPrice),
  };
}

const configReader = createCachedReader<RegistryConfig>({ fetch: fetchRegistryConfig, label: "registry config" });

/** Registry config with a 10 s cache (null when it could not be read: callers fail open where documented). */
export function registryConfig(): Promise<RegistryConfig | null> {
  return configReader.read();
}

/**
 * Drops the cached Registry config. The indexer calls this on `PauseChanged` and `ConfigUpdated` so the next purchase,
 * transfer or `/api/config` reads the new values right away.
 */
export function invalidateConfigCache(): void {
  configReader.invalidate();
}

/** Payment-token balance of a wallet, in base units. */
export async function tokenBalance(wallet: Address): Promise<bigint> {
  const c = chainContext();
  return c.publicClient.readContract({ address: env.PAYMENT_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
}

/** Current owner (lowercase) of a license NFT; null when the token does not exist (never minted or burned). */
export async function licenseOwnerOf(tokenId: bigint): Promise<Address | null> {
  const c = chainContext();
  try {
    const owner = await c.publicClient.readContract({ address: c.deployment.license, abi: solversLicenseAbi, functionName: "ownerOf", args: [tokenId] });
    return owner.toLowerCase() as Address;
  } catch (e) {
    if (decodeSolversError(e).name === "ERC721NonexistentToken") return null;
    throw e;
  }
}

export type LicenseOnChain = { agentId: Hex; originalPrice: bigint; mintedAt: number; reviewId: bigint };

/** License slot (`licenseOf`); null when the token was never minted (the contract reverts `ERC721NonexistentToken`). */
export async function licenseOnChain(tokenId: bigint): Promise<LicenseOnChain | null> {
  const c = chainContext();
  const slot = await c.publicClient
    .readContract({ address: c.deployment.license, abi: solversLicenseAbi, functionName: "licenseOf", args: [tokenId] })
    .catch((e: unknown) => {
      if (decodeSolversError(e).name === "ERC721NonexistentToken") return null;
      throw e;
    });
  if (!slot) return null;
  const [agentId, originalPrice, mintedAt, reviewId] = slot;
  if (BigInt(mintedAt) === 0n) return null;
  return { agentId: agentId.toLowerCase() as Hex, originalPrice: BigInt(originalPrice), mintedAt: Number(mintedAt), reviewId: BigInt(reviewId) };
}

export type RoyaltyQuoteOnChain = { creator: Address; creatorAmount: bigint; treasury: Address; platformAmount: bigint };

/** What the current owner pays to transfer the license (creator + platform shares, as the contract charges them). */
export async function quoteRoyaltyOnChain(tokenId: bigint): Promise<RoyaltyQuoteOnChain> {
  const c = chainContext();
  const [creator, creatorAmount, treasury, platformAmount] = await c.publicClient.readContract({
    address: c.deployment.license,
    abi: solversLicenseAbi,
    functionName: "quoteRoyalty",
    args: [tokenId],
  });
  return {
    creator: creator.toLowerCase() as Address,
    creatorAmount: BigInt(creatorAmount),
    treasury: treasury.toLowerCase() as Address,
    platformAmount: BigInt(platformAmount),
  };
}

/** The four contracts that can hold deferred payouts (D5). */
export function payoutContracts(d: Deployment): { key: "license" | "credits" | "escrow" | "staking"; address: Address }[] {
  return [
    { key: "license", address: d.license },
    { key: "credits", address: d.credits },
    { key: "escrow", address: d.escrow },
    { key: "staking", address: d.staking },
  ];
}

/** `deferredOf(wallet)` on every payout-holding contract, read live (the `payouts_deferred` mirror may lag). */
export async function deferredOnChain(wallet: Address): Promise<{ contract: Address; units: bigint }[]> {
  const c = chainContext();
  const abis = { license: solversLicenseAbi, credits: solversCreditsAbi, escrow: solversEscrowAbi, staking: solversStakingAbi } as const;
  return Promise.all(
    payoutContracts(c.deployment).map(async (p) => ({
      contract: p.address.toLowerCase() as Address,
      units: BigInt(
        await c.publicClient.readContract({ address: p.address, abi: abis[p.key] as typeof solversLicenseAbi, functionName: "deferredOf", args: [wallet] }),
      ),
    })),
  );
}

export type AgentOnChain = {
  creator: Address;
  status: number;
  royaltyBps: number;
  totalSales: number;
  maxSupply: number;
  price: bigint;
  pricePerUse: bigint;
  stake: bigint;
  version: string;
  versionHash: Hex;
  metadataUri: string;
};

/** Registry agent for a package id (32 hex); null when it is not registered on-chain. */
export async function agentOnChain(agentId: string): Promise<AgentOnChain | null> {
  const c = chainContext();
  const id = agentIdToBytes32(agentId);
  const reg = { address: c.deployment.registry, abi: solversRegistryAbi } as const;
  if (!(await c.publicClient.readContract({ ...reg, functionName: "agentExists", args: [id] }))) return null;
  const a = await c.publicClient.readContract({ ...reg, functionName: "getAgent", args: [id] });
  return {
    creator: a.creator.toLowerCase() as Address,
    status: Number(a.status),
    royaltyBps: Number(a.royaltyBps),
    totalSales: Number(a.totalSales),
    maxSupply: Number(a.maxSupply),
    price: BigInt(a.price),
    pricePerUse: BigInt(a.pricePerUse),
    stake: BigInt(a.stake),
    version: a.version,
    versionHash: a.versionHash.toLowerCase() as Hex,
    metadataUri: a.metadataUri,
  };
}

export type EscrowMilestoneOnChain = { amount: bigint; status: number; passedAt: number; disputedAt: number; disputeReasonHash: Hex };
export type EscrowOnChain = {
  buyer: Address;
  creator: Address;
  reviewWindowSecs: number;
  deliveryDeadline: number;
  milestones: EscrowMilestoneOnChain[];
};

/** Escrow state (`escrowOf`); null when the id does not exist. */
export async function escrowOnChain(escrowId: bigint): Promise<EscrowOnChain | null> {
  const c = chainContext();
  try {
    const e = await c.publicClient.readContract({ address: c.deployment.escrow, abi: solversEscrowAbi, functionName: "escrowOf", args: [escrowId] });
    const [buyer, , creator, , , reviewWindowSecs, deliveryDeadline, milestones] = e;
    return {
      buyer: buyer.toLowerCase() as Address,
      creator: creator.toLowerCase() as Address,
      reviewWindowSecs: Number(reviewWindowSecs),
      deliveryDeadline: Number(deliveryDeadline),
      milestones: milestones.map((m) => ({
        amount: BigInt(m.amount),
        status: Number(m.status),
        passedAt: Number(m.passedAt),
        disputedAt: Number(m.disputedAt),
        disputeReasonHash: m.disputeReasonHash.toLowerCase() as Hex,
      })),
    };
  } catch (e) {
    if (decodeSolversError(e).name === "EscrowNotFound") return null;
    throw e;
  }
}

/** Default admin of the Registry (lowercase). */
export async function registryAdmin(): Promise<Address> {
  const c = chainContext();
  const a = await c.publicClient.readContract({ address: c.deployment.registry, abi: solversRegistryAbi, functionName: "defaultAdmin" });
  return a.toLowerCase() as Address;
}

/** Contracts the store builds calls for (`stakingCalls` etc. take this shape). */
export type CallTargets = Pick<Deployment, "token" | "registry" | "license" | "credits" | "reviews" | "escrow" | "staking">;

/** Call targets of the running deployment, with the configured payment token. */
export function callTargets(): CallTargets {
  const d = chainContext().deployment;
  return { ...d, token: env.PAYMENT_TOKEN };
}

// The staking reads below back the creator stake routes.

export type StakeExitOnChain = { exitAt: number; requestedAt: number; extensions: number };

export async function stakeExitOnChain(agentId: string): Promise<StakeExitOnChain> {
  const c = chainContext();
  const e = await c.publicClient.readContract({
    address: c.deployment.staking,
    abi: solversStakingAbi,
    functionName: "stakeExitOf",
    args: [agentIdToBytes32(agentId)],
  });
  return { exitAt: Number(e.exitAt), requestedAt: Number(e.requestedAt), extensions: Number(e.extensions) };
}

export type SlashOnChain = { amount: bigint; proposedAt: number; contestedAt: number };

/** Pending slash proposal (`slashOf`); `proposedAt` 0 = none. */
export async function slashOnChain(agentId: string): Promise<SlashOnChain> {
  const c = chainContext();
  const s = await c.publicClient.readContract({
    address: c.deployment.staking,
    abi: solversStakingAbi,
    functionName: "slashOf",
    args: [agentIdToBytes32(agentId)],
  });
  return { amount: BigInt(s.amount), proposedAt: Number(s.proposedAt), contestedAt: Number(s.contestedAt) };
}
