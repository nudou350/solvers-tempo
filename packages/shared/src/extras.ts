import { z } from "zod";
import { Address, Bytes32, Call, TxHash, UnitsString } from "./evm.js";
import { MAX_BPS, MAX_FEE_BPS, MAX_TOTAL_ROYALTY_BPS } from "./money.js";
import { ChargeKind, ChargeStatus } from "./payments.js";
import { AgentSupply } from "./supply.js";
import { Agent, AgentStatus, Creator, Escrow, GuaranteeLevel, ImageRef, Review, UserReputation } from "./schemas.js";

// API response and request schemas for screens the core schemas do not cover. They never change the fields of
// Agent/Creator/...; they come as separate objects.

export const BeforeAfter = z.object({
  prompt: z.string(),
  withoutSolver: z.string(),
  withSolver: z.string(),
});

export const AgentVersion = z.object({
  version: z.string(),
  versionHash: z.string(),
  releasedAt: z.string(),
  notes: z.string(),
  /** Eval score measured for THIS version (null: not measured for it; decisions.md D6). */
  evalScore: z.number().nullable(),
});

export const MilestoneVerify = z.enum(["tests", "manual"]);

/** Guaranteed task offered by the creator: the buyer only describes what they want. */
export const GuaranteeOffer = z.object({
  priceUsdc: z.number(),
  priceBrl: z.number(),
  reviewWindowSecs: z.number(),
  milestones: z.array(
    z.object({
      title: z.string(),
      criteria: z.array(z.string()),
      amountUsdc: z.number(),
      /** "tests": the server verifies with tests; "manual": the buyer reviews the deliverable (e.g. a plan). */
      verify: MilestoneVerify,
    }),
  ),
});

/** Free trial of a Solver: what it unlocks, with limits enforced by the server. */
export const TrialInfo = z.object({
  /** Free activations per wallet. */
  uses: z.number(),
  /** Initial steps unlocked (1..steps). */
  steps: z.number(),
  totalSteps: z.number(),
  /** Knowledge-base searches (search_knowledge) for the whole trial. */
  searches: z.number(),
  /** Runs per tool for the whole trial; a tool outside the list is blocked. */
  tools: z.array(z.object({ name: z.string(), limit: z.number() })),
  /** Agreed request size during the trial (e.g. "1 component per use"). */
  scope: z.string().nullable(),
  summary: z.string(),
  lockedSummary: z.string(),
});

/** GET /api/agents/:slug */
export const AgentDetail = z.object({
  agent: Agent,
  creator: Creator,
  reviews: z.array(Review),
  /** Creator gallery (up to MAX_AGENT_IMAGES), already reviewed. */
  images: z.array(ImageRef).default([]),
  beforeAfter: z.array(BeforeAfter),
  versions: z.array(AgentVersion),
  /** null: no free trial. */
  trial: TrialInfo.nullable(),
  priceBrl: z.number().nullable(),
  /** Review count per rating, from 5 down to 1 star. */
  ratingDistribution: z.array(z.number()).length(5),
  /** On-chain references for the "verify on the explorer" links. */
  onchain: z.object({
    /** `agentIdToBytes32(agent.id)`; null while the Solver is not registered on-chain. */
    agentId: Bytes32.nullable(),
    registry: Address.nullable(),
    /** License NFT contract (ERC-721). */
    licenseContract: Address.nullable(),
    creatorWallet: Address.nullable(),
  }),
  /** null when the Solver offers no guarantee (or has not reached the minimum sales and rating yet). */
  guarantee: GuaranteeOffer.nullable(),
});

/** GET /api/creators/:id */
export const CreatorProfile = z.object({
  creator: Creator,
  agents: z.array(Agent),
});

/** Pending stake exit of a Solver (`SolversStaking.stakeExitOf`): withdrawable from `exitAt`. */
export const CreatorStakeExit = z.object({
  /** ISO date from which `withdrawStake` passes. */
  exitAt: z.string(),
  /** Admin extensions (30 days each, at most 2); after one the creator can no longer cancel the exit. */
  extensions: z.number().int(),
});

/** Proposed stake penalty (`SolversStaking.slashOf`). */
export const CreatorSlash = z.object({
  amountUnits: UnitsString,
  /** ISO date from which the admin may execute it (proposal + 72 h). */
  executableAt: z.string(),
  /** ISO date after which it can no longer be executed (and the creator may cancel it). */
  expiresAt: z.string(),
  /** The creator already contested it (once per proposal). */
  contested: z.boolean(),
});

/**
 * GET /api/creator/dashboard. Every money field is a base-unit decimal string of the payment token (`*Units`, summed
 * with bigint on the server); format it with the token decimals and symbol from `PublicConfig.paymentToken`.
 */
export const CreatorDashboard = z.object({
  creator: Creator.nullable(),
  totals: z.object({
    sales: z.number(),
    uses: z.number(),
    /** Creator share of every license and credit-pack sale (net of the platform fee), all time. */
    salesRevenueUnits: UnitsString,
    /** Creator share of transfer royalties received. */
    royaltiesUnits: UnitsString,
    disputesOpened: z.number(),
    disputesOpen: z.number(),
    disputesLost: z.number(),
  }),
  /** Last 30 days. */
  last30: z.object({ sales: z.number(), uses: z.number(), revenueUnits: UnitsString }),
  /** Creator share of each sale (1 - platform fee), in percent (display only). */
  creatorSharePct: z.number(),
  agents: z.array(
    z.object({
      agentId: z.string(),
      slug: z.string(),
      name: z.string(),
      category: z.string(),
      version: z.string(),
      status: AgentStatus,
      listed: z.boolean(),
      userRating: z.number(),
      evalScore: z.number(),
      sales: z.number(),
      uses: z.number(),
      revenueUnits: UnitsString,
      disputes: z.number(),
      /** License cap of this Solver (sold / max). */
      supply: AgentSupply.default({ max: null, sold: 0, left: null }),
      /** Current on-chain terms (indexer mirror): license price and price per use (0 = credits off). */
      priceUnits: UnitsString,
      pricePerUseUnits: UnitsString,
      /** Creator share of the transfer royalty, in bps of the original price (D15). */
      royaltyBps: z.number().int(),
      /** Stake deposited for this Solver (indexer mirror). */
      stakeUnits: UnitsString,
      /**
       * Live reads of the Staking and Registry contracts. `chainRead` false = the RPC failed: `stakeExit`, `slash` and
       * `metadataUri` are then unknown (null), not "none".
       */
      chainRead: z.boolean(),
      stakeExit: CreatorStakeExit.nullable(),
      slash: CreatorSlash.nullable(),
      /** On-chain metadata link (null when unknown or not registered). */
      metadataUri: z.string().nullable(),
    }),
  ),
  daily: z.array(z.object({ date: z.string(), sales: z.number(), uses: z.number(), revenueUnits: UnitsString })),
  /** Earnings from guaranteed tasks (milestones released to the creator, net of the fee), separate from sales. */
  guarantee: z
    .object({
      earnedUnits: UnitsString,
      last30Units: UnitsString,
      releases: z.number(),
      recent: z.array(z.object({ txHash: TxHash, agentId: z.string().nullable(), amountUnits: UnitsString, at: z.string() })),
    })
    .optional(),
  disputes: z.array(
    z.object({
      escrowId: z.string(),
      index: z.number(),
      agentId: z.string(),
      taskTitle: z.string(),
      milestoneTitle: z.string(),
      criterion: z.string().nullable(),
      reason: z.string().nullable(),
      amountUnits: UnitsString,
      openedAt: z.string().nullable(),
      result: z.enum(["open", "buyer", "creator"]),
    }),
  ),
});

/** GET /api/connector */
export const ConnectorStatus = z.object({
  url: z.string(),
  authorizedClients: z.array(z.object({ clientName: z.string(), authorizedAt: z.string() })),
});

/** GET /api/me/profile */
export const Profile = z.object({
  wallet: Address,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  memberSince: z.string(),
  reputation: UserReputation,
  creator: Creator.nullable(),
  explorerUrl: z.string(),
  history: z.array(z.object({ kind: z.string(), label: z.string(), at: z.string(), txHash: TxHash.nullable() })),
});

/** GET /api/me/escrows/:id */
export const EscrowDetail = z.object({
  escrow: Escrow,
  description: z.string(),
  createdAt: z.string(),
  agent: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  milestones: z.array(
    z.object({
      index: z.number(),
      amountUsdc: z.number(),
      passedAt: z.string().nullable(),
      autoReleaseAt: z.string().nullable(),
      previewUrl: z.string().nullable(),
      tests: z.object({ passed: z.number(), total: z.number(), mode: z.string() }).nullable(),
      criteria: z.array(z.string()),
      verify: MilestoneVerify,
      hasAcceptanceTests: z.boolean(),
      disputeCriterion: z.string().nullable(),
      downloadable: z.boolean(),
      /** When the buyer disputed (ISO), or null. */
      disputedAt: z.string().nullable(),
      /**
       * Only for a milestone that was never delivered: the date from which the buyer is refunded without a judgment
       * (ISO). Null when there is no dispute or when the milestone already passed its tests (then only an admin judges).
       */
      disputeDeadline: z.string().nullable(),
      /** Pending milestone past its delivery deadline: the buyer can cancel it and get the amount back. */
      canCancelUndelivered: z.boolean(),
    }),
  ),
  explorerUrl: z.string(),
});

/** GET /api/me/guarantee: how much the wallet can still put into open guarantees. */
export const GuaranteeStatus = z.object({
  level: GuaranteeLevel,
  limitUsdc: z.number(),
  openUsdc: z.number(),
  availableUsdc: z.number(),
  purchases: z.number(),
  /** Purchases left for the full level (0 when already there). */
  purchasesToFull: z.number(),
  disputesLost: z.number(),
  maxDisputesLost: z.number(),
  /** Above this value, accounts at the limited level need at least 2 milestones. */
  singleMilestoneMaxUsdc: z.number(),
});

/** GET /api/me/usage */
export const UsageSummary = z.object({
  agentId: z.string(),
  activations: z.number(),
  calls: z.number(),
  lastUsedAt: z.string().nullable(),
  usesThisMonth: z.number(),
  /** Activations per week, last 8 weeks (the last one is the current week). */
  weekly: z.array(z.number()).length(8),
});

/** GET /api/me/access/:idOrSlug: how the wallet can access the Solver right now. */
export const AgentAccess = z.object({
  agentId: z.string(),
  /** License token id, or null. */
  license: z.string().nullable(),
  /** 0 when the Solver has no free trial. */
  trialUsesLeft: z.number(),
  /** Balance of the whole trial (null: no free trial). */
  trial: z.object({ searchesLeft: z.number(), toolsLeft: z.record(z.number()) }).nullable(),
});

/**
 * GET /api/me/trials: the wallet's free trials in progress (one per Solver already activated without a license).
 * `usesLeft` 0 = trial used up.
 */
export const MyTrial = z.object({
  agentId: z.string(),
  uses: z.number(),
  usesLeft: z.number(),
  searches: z.number(),
  searchesLeft: z.number(),
  tools: z.array(z.object({ name: z.string(), limit: z.number(), left: z.number() })),
  lastUsedAt: z.string(),
});

// ----- Config (GET /api/config) -----

const Bps = z.number().int().min(0).max(MAX_BPS);

/** Pix: the buyer pays in BRL and the platform completes the purchase on-chain from its float (decisions.md D10). */
export const PixConfig = z.object({
  /** false without a configured provider. */
  enabled: z.boolean(),
  /** Shows the "simulate payment" button (never on mainnet). */
  simulate: z.boolean(),
  provider: z.enum(["mercadopago", "simulated"]).nullable(),
  minBrl: z.number(),
  maxBrl: z.number(),
});

/** Solana networks a Solana Pay charge can be paid on (devnet pairs with the Tempo testnet, mainnet-beta with mainnet). */
export const SolanaCluster = z.enum(["devnet", "mainnet-beta"]);

/** Solana Pay: the buyer pays in USDC on Solana and the platform completes the purchase on Tempo from its float. */
export const SolanaPayConfig = z.object({
  enabled: z.boolean(),
  cluster: SolanaCluster,
  /** SPL mint accepted (base58). */
  mint: z.string(),
  /** Wallet that receives the payments (base58); null when disabled. */
  recipient: z.string().nullable(),
  tokenSymbol: z.string(),
});

/** Agent purchases over HTTP 402 (MPP, decisions.md D4). */
export const AgentPayConfig = z.object({
  enabled: z.boolean(),
  protocol: z.literal("mpp"),
  /** Bounds accepted for one agent purchase, in token base units (null: no bound). */
  minPriceUnits: UnitsString.nullable(),
  maxPriceUnits: UnitsString.nullable(),
});

export const PublicConfig = z.object({
  chainId: z.number().int().positive(),
  rpcUrl: z.string(),
  /** Explorer base URL (e.g. https://explore.testnet.tempo.xyz). */
  explorerUrl: z.string(),
  contracts: z.object({
    registry: Address,
    license: Address,
    credits: Address,
    reviews: Address,
    escrow: Address,
    staking: Address,
  }),
  /** The TIP-20 stablecoin every price is paid in (also the fee token the relay pays fees with). */
  paymentToken: z.object({ address: Address, symbol: z.string(), decimals: z.number().int().min(0).max(36) }),
  /** Primary-sale platform fee (Registry config). null: the on-chain config could not be read. */
  feeBps: z.number().int().min(0).max(MAX_FEE_BPS).nullable(),
  /** Transfer royalty, bps of the original price (decisions.md D15). */
  royalty: z.object({
    /** Default creator share for NEW Solvers (each Solver's own share is `Agent.royaltyBps`). */
    creatorBps: z.number().int().min(0).max(MAX_TOTAL_ROYALTY_BPS),
    /** Platform share (Registry config). null: the on-chain config could not be read. */
    platformBps: Bps.nullable(),
  }),
  /** Minimum purchase (license, credits, guarantee) in token base units. */
  minPriceUnits: UnitsString,
  faucetEnabled: z.boolean(),
  brlPerUsd: z.number(),
  connectorUrl: z.string(),
  freeTrialUses: z.number(),
  reviewWindowSecs: z.number(),
  guaranteeLimitsUsdc: z.object({ none: z.number(), limited: z.number(), full: z.number() }),
  guaranteeMinSales: z.number(),
  guaranteeMinRating: z.number(),
  pix: PixConfig,
  solanaPay: SolanaPayConfig,
  agentPay: AgentPayConfig,
  /**
   * Server clock when the response was built (unix seconds). Clients derive `validBefore` of sponsored transactions from
   * it (offset against their own clock), because the relay checks `validBefore` against the server's clock.
   */
  serverTime: z.number().int().positive(),
});

// ----- Purchases and transactions -----

/** Buyer's description of a guaranteed task (milestones and criteria come from the creator's offer). */
export const EscrowTaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  /** Optional acceptance tests per milestone (null = none for that milestone). */
  acceptanceTests: z.array(z.record(z.string()).nullable()).optional(),
  /** Delivery deadline in days (0 or missing = 14, max 60). */
  deliveryDays: z.number().int().min(0).max(60).optional(),
});

/**
 * What to buy: body of POST /api/purchases/intent and POST /api/pix/charges. The buyer is always the session wallet.
 * `expectedPriceUnits` (license) makes the server answer 409 `price_changed` when the price moved since it was shown.
 */
export const PurchaseIntentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("license"), agentId: z.string(), expectedPriceUnits: UnitsString.optional() }),
  z.object({ kind: z.literal("credits"), agentId: z.string(), amount: z.number().int().min(1).max(0xffff_ffff) }),
  z.object({ kind: z.literal("escrow"), agentId: z.string(), task: EscrowTaskInput }),
]);

/**
 * Response of the /api/tx/* builders: the calls the wallet sends as ONE Tempo 0x76 batch with `feePayer: true` (the
 * platform relay pays the network fee). The server never builds or signs the transaction itself.
 */
export const TxResponse = z.object({
  calls: z.array(Call).min(1),
  feePayer: z.literal(true),
  chainId: z.number().int().positive(),
  /** Present when the batch is a purchase (`purchaseIdFor(chargeId)`). */
  purchaseId: Bytes32.optional(),
});

/** POST /api/purchases/intent: ledger row first, then the `[approve, purchase]` batch for the buyer's wallet. */
export const PurchaseIntent = TxResponse.extend({
  purchaseId: Bytes32,
  chargeId: z.string(),
  kind: ChargeKind,
  agentId: z.string(),
  /** Total the wallet pays, in token base units. */
  amountUnits: UnitsString,
});

/** POST /api/tx/confirm: the server waits for the receipt and indexes it right away. */
export const ConfirmResponse = z.object({
  txHash: TxHash,
  status: z.enum(["confirmed", "failed"]),
  error: z.string().optional(),
});

/** GET /api/me/licenses/:id/transfer-quote: royalty the current owner pays to transfer the license (D15). */
export const RoyaltyQuote = z.object({
  licenseId: z.string(),
  agentId: z.string(),
  token: Address,
  decimals: z.number().int(),
  originalPriceUnits: UnitsString,
  creatorBps: Bps,
  /** Effective platform share (clamped so the total never exceeds MAX_TOTAL_ROYALTY_BPS). */
  platformBps: Bps,
  creatorAmountUnits: UnitsString,
  platformAmountUnits: UnitsString,
  totalUnits: UnitsString,
});

/** GET /api/license/:id: ERC-721 metadata JSON (`tokenURI`). */
export const LicenseMetadata = z
  .object({
    name: z.string(),
    description: z.string(),
    image: z.string().optional(),
    external_url: z.string().optional(),
    attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })).default([]),
  })
  .passthrough();

/** GET /api/me/balance */
export const TokenBalance = z.object({
  token: Address,
  symbol: z.string(),
  decimals: z.number().int(),
  units: UnitsString,
});

/** GET /api/me/payouts: amounts credited to the wallet when a direct payout was blocked (decisions.md D5), per contract. */
export const DeferredPayouts = z.object({
  totalUnits: UnitsString,
  contracts: z.array(z.object({ contract: Address, units: UnitsString })),
});

/** POST /api/faucet (testnet only). */
export const FaucetResponse = z
  .object({
    txHash: TxHash.nullable(),
    amountUnits: UnitsString.nullable(),
  })
  .passthrough();

// ----- Pix -----

/** POST /api/pix/charges and GET /api/pix/charges/:id. One charge buys one thing for the session wallet. */
export const PixCharge = z.object({
  /** Charge id (`purchaseId = purchaseIdFor(id)`). */
  id: z.string(),
  provider: z.enum(["mercadopago", "simulated"]),
  status: ChargeStatus,
  kind: ChargeKind,
  agentId: z.string(),
  purchaseId: Bytes32,
  amountBrl: z.number(),
  /** Token amount the platform pays on-chain for this purchase, in base units. */
  amountUnits: UnitsString,
  /** Pix copy-and-paste code. In simulated mode it is a placeholder that cannot be paid. */
  qrCode: z.string().nullable(),
  /** PNG in base64 (without the data: prefix). null in simulated mode. */
  qrCodeBase64: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  expiresAt: z.string(),
  /** Fulfilment transaction (the platform's `*For` purchase), once sent. */
  txHash: TxHash.nullable(),
  explorerUrl: z.string().nullable(),
  simulated: z.boolean(),
  createdAt: z.string(),
});

/** A Solana Pay charge (POST/GET /api/solana-pay/charges): one purchase paid in USDC on Solana. */
export const SolanaPayCharge = z.object({
  /** Charge id (`purchaseId = purchaseIdFor(id)`). */
  id: z.string(),
  status: ChargeStatus,
  kind: ChargeKind,
  agentId: z.string(),
  purchaseId: Bytes32,
  /** Amount in base units (6 decimals on both chains). */
  amountUnits: UnitsString,
  /** Same amount as a decimal string ("19", "5.7"). */
  amount: z.string(),
  tokenSymbol: z.string(),
  cluster: SolanaCluster,
  /** Solana Pay transfer request (`solana:<recipient>?amount=…&spl-token=…&reference=…`). */
  url: z.string(),
  /** QR of `url`, PNG in base64 (without the data: prefix). */
  qrCodeBase64: z.string(),
  recipient: z.string(),
  mint: z.string(),
  /** Per-charge reference key the payment is found by. */
  reference: z.string(),
  expiresAt: z.string(),
  /** Payment transaction on Solana, once seen. */
  solanaSignature: z.string().nullable(),
  solanaExplorerUrl: z.string().nullable(),
  /** Refund transaction on Solana, when the purchase could not be completed. */
  refundSignature: z.string().nullable(),
  /** Fulfilment transaction on Tempo (the platform's `*For` purchase), once sent. */
  txHash: TxHash.nullable(),
  explorerUrl: z.string().nullable(),
  createdAt: z.string(),
});

// ----- Auth -----

/** GET /api/auth/nonce?address=0x...: the server's half of a SIWE (EIP-4361) message; the client builds the rest. */
export const SiweNonce = z.object({
  nonce: z.string().regex(/^[a-zA-Z0-9]{8,}$/),
  chainId: z.number().int().positive(),
  statement: z.string(),
  /** Nonce expiry (ISO); used as the message's expiration time. */
  expiresAt: z.string(),
  /** When the server issued the nonce (ISO); used as the message's issued-at time, so the client clock never matters. */
  issuedAt: z.string().datetime({ offset: true }).optional(),
});

/** Constant message signed (EIP-191) to derive the memory key (decisions.md D8). */
export const MEMORY_KEY_MESSAGE = "Solvers memory key v1";

export type BeforeAfter = z.infer<typeof BeforeAfter>;
export type AgentVersion = z.infer<typeof AgentVersion>;
export type AgentDetail = z.infer<typeof AgentDetail>;
export type TrialInfo = z.infer<typeof TrialInfo>;
export type AgentAccess = z.infer<typeof AgentAccess>;
export type MyTrial = z.infer<typeof MyTrial>;
export type CreatorProfile = z.infer<typeof CreatorProfile>;
export type CreatorDashboard = z.infer<typeof CreatorDashboard>;
export type CreatorStakeExit = z.infer<typeof CreatorStakeExit>;
export type CreatorSlash = z.infer<typeof CreatorSlash>;
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;
export type Profile = z.infer<typeof Profile>;
export type EscrowDetail = z.infer<typeof EscrowDetail>;
export type GuaranteeOffer = z.infer<typeof GuaranteeOffer>;
export type MilestoneVerify = z.infer<typeof MilestoneVerify>;
export type GuaranteeStatus = z.infer<typeof GuaranteeStatus>;
export type UsageSummary = z.infer<typeof UsageSummary>;
export type PixConfig = z.infer<typeof PixConfig>;
export type AgentPayConfig = z.infer<typeof AgentPayConfig>;
export type PublicConfig = z.infer<typeof PublicConfig>;
export type EscrowTaskInput = z.infer<typeof EscrowTaskInput>;
export type PurchaseIntentInput = z.infer<typeof PurchaseIntentInput>;
export type TxResponse = z.infer<typeof TxResponse>;
export type PurchaseIntent = z.infer<typeof PurchaseIntent>;
export type ConfirmResponse = z.infer<typeof ConfirmResponse>;
export type RoyaltyQuote = z.infer<typeof RoyaltyQuote>;
export type LicenseMetadata = z.infer<typeof LicenseMetadata>;
export type TokenBalance = z.infer<typeof TokenBalance>;
export type DeferredPayouts = z.infer<typeof DeferredPayouts>;
export type FaucetResponse = z.infer<typeof FaucetResponse>;
export type PixCharge = z.infer<typeof PixCharge>;
export type SolanaCluster = z.infer<typeof SolanaCluster>;
export type SolanaPayConfig = z.infer<typeof SolanaPayConfig>;
export type SolanaPayCharge = z.infer<typeof SolanaPayCharge>;
export type SiweNonce = z.infer<typeof SiweNonce>;
