import { z } from "zod";
import { Address } from "./evm.js";
import { AgentSupply } from "./supply.js";

// Core data contract shared by server, api-client and web. Field names are part of the API: the web uses the same
// names. Prices in these display schemas are numbers of whole stablecoin units (formatting edge); amounts that are
// computed with or sent on-chain travel as bigint base units (`UnitsString` in evm.ts).

export const Requirement = z.object({
  type: z.enum(["client", "connector", "plan"]),
  label: z.string(),
  key: z.string().optional(),
  /** Optional: when missing, the preflight warns without blocking (e.g. Figma with a path that needs no connector). */
  optional: z.boolean().optional(),
  /** Connector: how to connect, in 1-3 sentences (the creator writes it for connectors outside the catalog). */
  howTo: z.string().max(600).optional(),
  /** Connector: official help link, the fallback when the AI client's menu changes. */
  helpUrl: z.string().url().optional(),
});

/** Agent status names (on-chain codes in onchain.ts `AGENT_STATUS`). */
export const AgentStatus = z.enum(["pending", "active", "suspended", "retired"]);

export const Agent = z.object({
  /** Package id: 32 hex characters (on-chain `agentId = agentIdToBytes32(id)`). */
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  category: z.string(),
  creatorId: z.string(),
  version: z.string(),
  versionHash: z.string(),
  priceUsdc: z.number(),
  /** Has a free trial (limits in AgentDetail.trial). */
  trialAvailable: z.boolean(),
  userRating: z.number(),
  reviewsCount: z.number(),
  verifiedUses: z.number(),
  evalScore: z.number(),
  requirements: z.array(Requirement),
  packageContents: z.array(z.string()),
  guaranteeAvailable: z.boolean(),
  /**
   * Creator share of the transfer royalty, in bps of the license's original price (fixed at registration, editable only
   * before the first sale). The platform share is `PublicConfig.royalty.platformBps`.
   */
  royaltyBps: z.number().default(0),
  /** License cap. The default keeps older clients and data parsing: unlimited. */
  supply: AgentSupply.default({ max: null, sold: 0, left: null }),
  /** Platform Solver (e.g. the Solver creator): free, no license or purchase, DB only. */
  platform: z.boolean().default(false),
  /** Proven differentiators (PACKAGE_SPEC.md 4.2): tool, verifier, liveData, memory, escalation. Empty for v0 packages. */
  differentiators: z.array(z.string()).default([]),
  trend7d: z.number(),
  /** Date of the first published version (ISO). */
  publishedAt: z.string(),
});

export const Creator = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string(),
  reputationScore: z.number(),
  disputesLost: z.number(),
  agentsPublished: z.number(),
});

export const License = z.object({
  /** ERC-721 token id of the license, as a decimal string. */
  id: z.string(),
  agentId: z.string(),
  ownerWallet: Address,
  acquiredAt: z.string(),
  /** Only lifetime licenses exist (pay-per-use ended). */
  type: z.literal("permanent"),
});

/** Image hosted on the CDN: `url` is the large version, `thumbUrl` the thumbnail. */
export const ImageRef = z.object({
  id: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const Review = z.object({
  id: z.string(),
  agentId: z.string(),
  authorWallet: Address,
  rating: z.number().int().min(1).max(5),
  text: z.string(),
  createdAt: z.string(),
  verifiedPurchase: z.literal(true),
  /** Reviewer's profile name (null: the storefront shows the shortened wallet). */
  authorName: z.string().nullable(),
  /** Photos the buyer attached (up to MAX_REVIEW_IMAGES). */
  images: z.array(ImageRef).default([]),
});

/** `submitted` is a DB-only state (deliverable received, not yet verified); the rest mirror `MILESTONE_STATUS`. */
export const MilestoneStatus = z.enum(["pending", "submitted", "passed", "approved", "disputed", "refunded"]);

export const Milestone = z.object({
  title: z.string(),
  criteria: z.string(),
  status: MilestoneStatus,
});

/** Mirrors the derived `ESCROW_STATUS` (`Completed` is shown as "approved"). */
export const EscrowStatus = z.enum(["active", "approved", "disputed", "refunded"]);

export const Escrow = z.object({
  /** On-chain escrow id. */
  id: z.string(),
  /** Task title, written by the buyer. */
  title: z.string(),
  agentId: z.string(),
  buyerWallet: Address,
  amountUsdc: z.number(),
  status: EscrowStatus,
  milestones: z.array(Milestone),
  autoReleaseAt: z.string(),
  /** Delivery deadline (ISO). */
  deliveryDeadline: z.string().nullable(),
  /** Platform fee frozen at creation (bps). */
  feeBps: z.number().nullable(),
});

/** Note in the Solver's memory (saved at the user's request). */
export const MemoryNote = z.object({ id: z.string(), text: z.string(), at: z.string() });

/** Solver memory: encrypted on the server (never on-chain). `summary` may be empty; profile and notes are optional (PACKAGE_SPEC.md 11). */
export const Memory = z.object({
  id: z.string(),
  agentId: z.string(),
  summary: z.string(),
  /** Calibration answers (or { skipped: true }). */
  profile: z.record(z.unknown()).nullable().default(null),
  notes: z.array(MemoryNote).default([]),
  updatedAt: z.string(),
});

export const GuaranteeLevel = z.enum(["limited", "full", "none"]);

export const UserReputation = z.object({
  wallet: Address,
  score: z.number(),
  purchases: z.number(),
  disputesLost: z.number(),
  guaranteeLevel: GuaranteeLevel,
});

export type Requirement = z.infer<typeof Requirement>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type Agent = z.infer<typeof Agent>;
export type Creator = z.infer<typeof Creator>;
export type License = z.infer<typeof License>;
export type ImageRef = z.infer<typeof ImageRef>;
export type Review = z.infer<typeof Review>;
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;
export type Milestone = z.infer<typeof Milestone>;
export type EscrowStatus = z.infer<typeof EscrowStatus>;
export type Escrow = z.infer<typeof Escrow>;
export type Memory = z.infer<typeof Memory>;
export type GuaranteeLevel = z.infer<typeof GuaranteeLevel>;
export type UserReputation = z.infer<typeof UserReputation>;
