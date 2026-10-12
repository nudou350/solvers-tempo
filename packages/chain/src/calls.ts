import {
  solversCreditsAbi,
  solversEscrowAbi,
  solversLicenseAbi,
  solversRegistryAbi,
  solversReviewsAbi,
  solversStakingAbi,
} from "@solvers/contracts-client";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

import type { Deployment } from "./deployment.js";

/** One call of a Tempo (0x76) batch. Values are always 0 on Tempo (no native token). */
export type Call = { to: Address; data: Hex };

type D = Pick<Deployment, "token" | "registry" | "license" | "credits" | "reviews" | "escrow" | "staking">;

const approve = (token: Address, spender: Address, amount: bigint): Call => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});

/** `[approve(license, price), purchaseLicense]`: buyer = payer = the sender. */
export function purchaseLicenseCalls(d: D, p: { agentId: Hex; price: bigint; purchaseId: Hex }): Call[] {
  return [
    approve(d.token, d.license, p.price),
    {
      to: d.license,
      data: encodeFunctionData({
        abi: solversLicenseAbi,
        functionName: "purchaseLicense",
        args: [p.agentId, p.price, p.purchaseId],
      }),
    },
  ];
}

/** `[approve(license, price), purchaseLicenseFor(buyer)]`: the platform float pays (PLATFORM_ROLE). */
export function purchaseLicenseForCalls(
  d: D,
  p: { buyer: Address; agentId: Hex; price: bigint; purchaseId: Hex },
): Call[] {
  return [
    approve(d.token, d.license, p.price),
    {
      to: d.license,
      data: encodeFunctionData({
        abi: solversLicenseAbi,
        functionName: "purchaseLicenseFor",
        args: [p.buyer, p.agentId, p.price, p.purchaseId],
      }),
    },
  ];
}

/** `[approve(credits, maxTotal), buyCredits]`. */
export function buyCreditsCalls(d: D, p: { agentId: Hex; amount: number; maxTotal: bigint; purchaseId: Hex }): Call[] {
  return [
    approve(d.token, d.credits, p.maxTotal),
    {
      to: d.credits,
      data: encodeFunctionData({
        abi: solversCreditsAbi,
        functionName: "buyCredits",
        args: [p.agentId, p.amount, p.maxTotal, p.purchaseId],
      }),
    },
  ];
}

/** `[approve(credits, maxTotal), buyCreditsFor(buyer)]` from the platform float. */
export function buyCreditsForCalls(
  d: D,
  p: { buyer: Address; agentId: Hex; amount: number; maxTotal: bigint; purchaseId: Hex },
): Call[] {
  return [
    approve(d.token, d.credits, p.maxTotal),
    {
      to: d.credits,
      data: encodeFunctionData({
        abi: solversCreditsAbi,
        functionName: "buyCreditsFor",
        args: [p.buyer, p.agentId, p.amount, p.maxTotal, p.purchaseId],
      }),
    },
  ];
}

export type MilestoneInput = { amount: bigint; criteriaHash: Hex };

/** `[approve(escrow, total), createEscrow]`. `deliveryDays` 0 means the default (14). */
export function createEscrowCalls(
  d: D,
  p: { agentId: Hex; milestones: MilestoneInput[]; reviewWindowSecs: number; deliveryDays: number; purchaseId: Hex },
): Call[] {
  const total = p.milestones.reduce((s, m) => s + m.amount, 0n);
  return [
    approve(d.token, d.escrow, total),
    {
      to: d.escrow,
      data: encodeFunctionData({
        abi: solversEscrowAbi,
        functionName: "createEscrow",
        args: [p.agentId, p.milestones, p.reviewWindowSecs, p.deliveryDays, p.purchaseId],
      }),
    },
  ];
}

/** `[approve(escrow, total), createEscrowFor(buyer)]` from the platform float. */
export function createEscrowForCalls(
  d: D,
  p: {
    buyer: Address;
    agentId: Hex;
    milestones: MilestoneInput[];
    reviewWindowSecs: number;
    deliveryDays: number;
    purchaseId: Hex;
  },
): Call[] {
  const total = p.milestones.reduce((s, m) => s + m.amount, 0n);
  return [
    approve(d.token, d.escrow, total),
    {
      to: d.escrow,
      data: encodeFunctionData({
        abi: solversEscrowAbi,
        functionName: "createEscrowFor",
        args: [p.buyer, p.agentId, p.milestones, p.reviewWindowSecs, p.deliveryDays, p.purchaseId],
      }),
    },
  ];
}

/** `[approve(license, maxRoyalty), transferWithRoyalty]`: the owner pays the royalty (5% + 5% of the original price). */
export function transferWithRoyaltyCalls(d: D, p: { to: Address; tokenId: bigint; maxRoyalty: bigint }): Call[] {
  return [
    approve(d.token, d.license, p.maxRoyalty),
    {
      to: d.license,
      data: encodeFunctionData({
        abi: solversLicenseAbi,
        functionName: "transferWithRoyalty",
        args: [p.to, p.tokenId, p.maxRoyalty],
      }),
    },
  ];
}

export type AgentRegistration = {
  agentId: Hex;
  metadataUri: string;
  version: string;
  versionHash: Hex;
  price: bigint;
  pricePerUse: bigint;
  royaltyBps: number;
};

/**
 * Co-signed publication batch (plan §3.3): `[approve(staking, minStake)?, registerAgent, setSupplyCap?]`, signed by the
 * creator and sponsored by the relay.
 */
export function publishAgentCalls(d: D, p: { registration: AgentRegistration; minStake: bigint; maxSupply?: number }): Call[] {
  const calls: Call[] = [];
  if (p.minStake > 0n) calls.push(approve(d.token, d.staking, p.minStake));
  calls.push({
    to: d.registry,
    data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "registerAgent", args: [p.registration] }),
  });
  if (p.maxSupply && p.maxSupply > 0) {
    calls.push({
      to: d.registry,
      data: encodeFunctionData({
        abi: solversRegistryAbi,
        functionName: "setSupplyCap",
        args: [p.registration.agentId, p.maxSupply],
      }),
    });
  }
  return calls;
}

/** New package version (creator). */
export function updateVersionCalls(d: D, p: { agentId: Hex; version: string; versionHash: Hex }): Call[] {
  return [
    {
      to: d.registry,
      data: encodeFunctionData({
        abi: solversRegistryAbi,
        functionName: "updateVersion",
        args: [p.agentId, p.version, p.versionHash],
      }),
    },
  ];
}

export function submitReviewCalls(d: D, p: { agentId: Hex; tokenId: bigint; rating: number; contentHash: Hex }): Call[] {
  return [
    {
      to: d.reviews,
      data: encodeFunctionData({
        abi: solversReviewsAbi,
        functionName: "submitReview",
        args: [p.agentId, p.tokenId, p.rating, p.contentHash],
      }),
    },
  ];
}

export function submitReviewWithCreditsCalls(d: D, p: { agentId: Hex; rating: number; contentHash: Hex }): Call[] {
  return [
    {
      to: d.reviews,
      data: encodeFunctionData({
        abi: solversReviewsAbi,
        functionName: "submitReviewWithCredits",
        args: [p.agentId, p.rating, p.contentHash],
      }),
    },
  ];
}

const escrowCall = (d: D, data: Hex): Call[] => [{ to: d.escrow, data }];

export const releaseMilestoneCalls = (d: D, p: { escrowId: bigint; index: number }) =>
  escrowCall(d, encodeFunctionData({ abi: solversEscrowAbi, functionName: "releaseMilestone", args: [p.escrowId, p.index] }));
export const openDisputeCalls = (d: D, p: { escrowId: bigint; index: number; reasonHash: Hex }) =>
  escrowCall(
    d,
    encodeFunctionData({ abi: solversEscrowAbi, functionName: "openDispute", args: [p.escrowId, p.index, p.reasonHash] }),
  );
export const cancelUndeliveredCalls = (d: D, p: { escrowId: bigint; index: number }) =>
  escrowCall(d, encodeFunctionData({ abi: solversEscrowAbi, functionName: "cancelUndelivered", args: [p.escrowId, p.index] }));
export const resolveStaleDisputeCalls = (d: D, p: { escrowId: bigint; index: number }) =>
  escrowCall(
    d,
    encodeFunctionData({ abi: solversEscrowAbi, functionName: "resolveStaleDispute", args: [p.escrowId, p.index] }),
  );
/** Verifier only (VERIFIER_ROLE). */
export const markPassedCalls = (d: D, p: { escrowId: bigint; index: number; deliverableHash: Hex }) =>
  escrowCall(
    d,
    encodeFunctionData({
      abi: solversEscrowAbi,
      functionName: "markPassed",
      args: [p.escrowId, p.index, p.deliverableHash],
    }),
  );
/** Admin only. */
export const resolveDisputeCalls = (d: D, p: { escrowId: bigint; index: number; refund: boolean }) =>
  escrowCall(
    d,
    encodeFunctionData({ abi: solversEscrowAbi, functionName: "resolveDispute", args: [p.escrowId, p.index, p.refund] }),
  );

/** Claims a deferred payout from one of the payout-holding contracts. */
export function claimCalls(target: Address): Call[] {
  return [{ to: target, data: encodeFunctionData({ abi: solversLicenseAbi, functionName: "claim" }) }];
}

/** Admin: approve / suspend an agent. */
export const approveAgentCalls = (d: D, agentId: Hex): Call[] => [
  { to: d.registry, data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "approveAgent", args: [agentId] }) },
];
export const suspendAgentCalls = (d: D, agentId: Hex): Call[] => [
  { to: d.registry, data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "suspendAgent", args: [agentId] }) },
];

/** Usage authority (USAGE_ROLE): consume credits / record a verified-use batch. */
export const consumeCreditsCalls = (d: D, p: { agentId: Hex; owner: Address; count: number }): Call[] => [
  {
    to: d.credits,
    data: encodeFunctionData({
      abi: solversCreditsAbi,
      functionName: "consumeCredits",
      args: [p.agentId, p.owner, p.count],
    }),
  },
];
export const recordUsageBatchCalls = (d: D, p: { agentId: Hex; count: bigint; merkleRoot: Hex }): Call[] => [
  {
    to: d.credits,
    data: encodeFunctionData({
      abi: solversCreditsAbi,
      functionName: "recordUsageBatch",
      args: [p.agentId, p.count, p.merkleRoot],
    }),
  },
];

/** Verifier: version-scoped eval (D6). */
export const setEvalCalls = (d: D, p: { agentId: Hex; versionHash: Hex; scoreBps: number; evalHash: Hex }): Call[] => [
  {
    to: d.registry,
    data: encodeFunctionData({
      abi: solversRegistryAbi,
      functionName: "setEval",
      args: [p.agentId, p.versionHash, p.scoreBps, p.evalHash],
    }),
  },
];

/** Staking: creator top-up (approve + topUpStake). */
export function topUpStakeCalls(d: D, p: { agentId: Hex; amount: bigint }): Call[] {
  return [
    approve(d.token, d.staking, p.amount),
    {
      to: d.staking,
      data: encodeFunctionData({ abi: solversStakingAbi, functionName: "topUpStake", args: [p.agentId, p.amount] }),
    },
  ];
}

// ---- creator configuration (Registry) ----

export const updatePricingCalls = (d: D, p: { agentId: Hex; price: bigint; pricePerUse: bigint }): Call[] => [
  {
    to: d.registry,
    data: encodeFunctionData({
      abi: solversRegistryAbi,
      functionName: "updatePricing",
      args: [p.agentId, p.price, p.pricePerUse],
    }),
  },
];
export const updateMetadataUriCalls = (d: D, p: { agentId: Hex; metadataUri: string }): Call[] => [
  {
    to: d.registry,
    data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "updateMetadataUri", args: [p.agentId, p.metadataUri] }),
  },
];
/** Creator share of the transfer royalty; only before the first sale (D15). */
export const setRoyaltyBpsCalls = (d: D, p: { agentId: Hex; royaltyBps: number }): Call[] => [
  {
    to: d.registry,
    data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "setRoyaltyBps", args: [p.agentId, p.royaltyBps] }),
  },
];
/** License cap: from unlimited needs max >= max(1, totalSales); afterwards raise-only. */
export const setSupplyCapCalls = (d: D, p: { agentId: Hex; max: number }): Call[] => [
  {
    to: d.registry,
    data: encodeFunctionData({ abi: solversRegistryAbi, functionName: "setSupplyCap", args: [p.agentId, p.max] }),
  },
];

// ---- stake lifecycle (Staking; creator) ----

const stakingCall = (d: D, functionName: "requestStakeExit" | "cancelStakeExit" | "withdrawStake", agentId: Hex): Call[] => [
  { to: d.staking, data: encodeFunctionData({ abi: solversStakingAbi, functionName, args: [agentId] }) },
];
export const requestStakeExitCalls = (d: D, agentId: Hex) => stakingCall(d, "requestStakeExit", agentId);
export const cancelStakeExitCalls = (d: D, agentId: Hex) => stakingCall(d, "cancelStakeExit", agentId);
export const withdrawStakeCalls = (d: D, agentId: Hex) => stakingCall(d, "withdrawStake", agentId);
export const contestSlashCalls = (d: D, p: { agentId: Hex; contestHash: Hex }): Call[] => [
  {
    to: d.staking,
    data: encodeFunctionData({ abi: solversStakingAbi, functionName: "contestSlash", args: [p.agentId, p.contestHash] }),
  },
];

// ---- single-call permit variants (D3: external wallets that cannot sign 0x76 batches pay their own fee) ----

/** EIP-2612 signature over the payment token (`v` must be 27 or 28 on TIP-20). */
export type PermitSig = { deadline: bigint; v: number; r: Hex; s: Hex };

export const purchaseLicenseWithPermitCalls = (
  d: D,
  p: { agentId: Hex; price: bigint; purchaseId: Hex } & PermitSig,
): Call[] => [
  {
    to: d.license,
    data: encodeFunctionData({
      abi: solversLicenseAbi,
      functionName: "purchaseLicenseWithPermit",
      args: [p.agentId, p.price, p.purchaseId, p.deadline, p.v, p.r, p.s],
    }),
  },
];
export const buyCreditsWithPermitCalls = (
  d: D,
  p: { agentId: Hex; amount: number; maxTotal: bigint; purchaseId: Hex } & PermitSig,
): Call[] => [
  {
    to: d.credits,
    data: encodeFunctionData({
      abi: solversCreditsAbi,
      functionName: "buyCreditsWithPermit",
      args: [p.agentId, p.amount, p.maxTotal, p.purchaseId, p.deadline, p.v, p.r, p.s],
    }),
  },
];
export const createEscrowWithPermitCalls = (
  d: D,
  p: { agentId: Hex; milestones: MilestoneInput[]; reviewWindowSecs: number; deliveryDays: number; purchaseId: Hex } & PermitSig,
): Call[] => [
  {
    to: d.escrow,
    data: encodeFunctionData({
      abi: solversEscrowAbi,
      functionName: "createEscrowWithPermit",
      args: [p.agentId, p.milestones, p.reviewWindowSecs, p.deliveryDays, p.purchaseId, p.deadline, p.v, p.r, p.s],
    }),
  },
];
/** The owner signs the permit for `maxRoyalty` (X13). */
export const transferWithRoyaltyPermitCalls = (
  d: D,
  p: { to: Address; tokenId: bigint; maxRoyalty: bigint } & PermitSig,
): Call[] => [
  {
    to: d.license,
    data: encodeFunctionData({
      abi: solversLicenseAbi,
      functionName: "transferWithRoyaltyPermit",
      args: [p.to, p.tokenId, p.maxRoyalty, p.deadline, p.v, p.r, p.s],
    }),
  },
];
