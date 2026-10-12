import type { Agent, CatalogLang, Creator, Escrow, ImageRef, License, Milestone, Review, UserReputation } from "@solvers/shared";
import { averageRating, bpsToScore, creatorReputationScore, guaranteeLevel, overlayCatalogTexts, reputationScore } from "@solvers/shared";
import type { schema } from "../db/index.js";
import { env } from "../env.js";
import { displayUnits } from "../lib/money.js";
import { provenDifferentiators } from "../runtime/differentiators.js";
import { isPlatformAgentRow } from "../runtime/platform-agents.js";
import { getPackage } from "../runtime/packages.js";
import { trialLimits } from "../runtime/trial.js";
import { supplyOfRow } from "./supply-rules.js";

type AgentRow = typeof schema.agents.$inferSelect;
type CreatorRow = typeof schema.creators.$inferSelect;
type LicenseRow = typeof schema.licenses.$inferSelect;
type ReviewRow = typeof schema.reviews.$inferSelect;
type EscrowRow = typeof schema.escrows.$inferSelect;
type MilestoneRow = typeof schema.milestones.$inferSelect;
type RepRow = typeof schema.userReputation.$inferSelect;

export type AgentExtras = { trend7d: number };

/** Guarantees only for Solvers that proved themselves: minimum sales and rating (GUARANTEE_MIN_SALES / GUARANTEE_MIN_RATING). */
export function guaranteeOffered(row: AgentRow): boolean {
  if (!row.guaranteeAvailable || !row.details.guaranteeTemplate) return false;
  if (Number(row.totalSales) < env.GUARANTEE_MIN_SALES) return false;
  // Raw average (no rounding): 3.95 does not count as 4.
  if (env.GUARANTEE_MIN_RATING > 0 && (row.ratingCount === 0 || Number(row.ratingSum) / row.ratingCount < env.GUARANTEE_MIN_RATING)) return false;
  return true;
}

/** Date of the first known version (manifest), or of the database row. */
export function publishedAt(row: AgentRow): string {
  const dates = (row.details.versions ?? []).map((v) => Date.parse(v.releasedAt)).filter((t) => !Number.isNaN(t));
  return new Date(dates.length ? Math.min(...dates) : row.createdAt.getTime()).toISOString();
}

export function hasTrial(agentId: string): boolean {
  const pkg = getPackage(agentId);
  return !!pkg && trialLimits(pkg.manifest) !== null;
}

/**
 * Eval score shown for the CURRENT version only (D6): an eval measured for another version hash reads as "not measured"
 * (0) instead of being zeroed on-chain.
 */
export function currentEvalBps(row: Pick<AgentRow, "evalScoreBps" | "evalVersionHash" | "versionHash">): number {
  // No measured version on record = not measured (D6): never show a score of unknown provenance.
  if (!row.evalVersionHash) return 0;
  return row.evalVersionHash.toLowerCase().replace(/^0x/, "") === row.versionHash.toLowerCase().replace(/^0x/, "") ? row.evalScoreBps : 0;
}

/** `lang` pt overlays the translated catalog texts (`agents.translations`); en (default) is the manifest's. */
export function toAgent(row: AgentRow, extras: AgentExtras, lang: CatalogLang = "en"): Agent {
  const texts = overlayCatalogTexts(
    { name: row.name, tagline: row.tagline, description: row.description, packageContents: row.packageContents, requirements: row.requirements },
    row.translations,
    lang,
  );
  return {
    id: row.id,
    slug: row.slug,
    name: texts.name,
    tagline: texts.tagline,
    description: texts.description,
    category: row.category,
    creatorId: row.creatorId,
    version: row.version,
    versionHash: row.versionHash,
    priceUsdc: displayUnits(row.price),
    // The free trial comes from the manifest on disk, the same source the connector uses to enforce its limits.
    trialAvailable: hasTrial(row.id),
    userRating: averageRating(row.ratingSum, row.ratingCount),
    reviewsCount: row.ratingCount,
    verifiedUses: Number(row.verifiedUses),
    evalScore: bpsToScore(currentEvalBps(row)),
    requirements: texts.requirements,
    packageContents: texts.packageContents,
    guaranteeAvailable: guaranteeOffered(row),
    royaltyBps: row.royaltyBps,
    // License cap: database mirror (total_sales / max_licenses), no extra query.
    supply: supplyOfRow(row),
    // Platform Solver (free, database only): the server's PLATFORM_AGENTS list decides, not the manifest. The storefront
    // hides price and purchase by this field. Differentiators: only those proven by the validator (v1 packages); v0 = [].
    platform: isPlatformAgentRow(row),
    differentiators: provenDifferentiators(getPackage(row.id)),
    trend7d: extras.trend7d,
    publishedAt: publishedAt(row),
  };
}

export type CreatorStats = { totalSales: number; avgRating: number; disputesLost: number; agentsPublished: number };

/** `bio`: the bio already in the requested language (catalog.ts picks the translated one); defaults to the stored bio. */
export function toCreator(row: CreatorRow, stats: CreatorStats, bio: string = row.bio): Creator {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatarUrl,
    bio,
    reputationScore: creatorReputationScore(stats.totalSales, stats.avgRating, stats.disputesLost),
    disputesLost: stats.disputesLost,
    agentsPublished: stats.agentsPublished,
  };
}

export function toLicense(row: LicenseRow): License {
  return {
    id: row.id,
    agentId: row.agentId,
    ownerWallet: row.ownerWallet as License["ownerWallet"],
    acquiredAt: row.acquiredAt.toISOString(),
    type: "permanent",
  };
}

export function toReview(row: ReviewRow, authorName: string | null = null, images: ImageRef[] = []): Review {
  return {
    id: row.id,
    agentId: row.agentId,
    authorWallet: row.authorWallet as Review["authorWallet"],
    rating: row.rating,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    verifiedPurchase: true,
    authorName,
    images,
  };
}

const MILESTONE_STATUS = new Set(["pending", "submitted", "passed", "approved", "disputed", "refunded"]);

export function toEscrow(row: EscrowRow, ms: MilestoneRow[]): Escrow {
  const milestones: Milestone[] = ms
    .sort((a, b) => a.idx - b.idx)
    .map((m) => ({
      title: m.title,
      criteria: m.criteria,
      status: (MILESTONE_STATUS.has(m.status) ? m.status : "pending") as Milestone["status"],
    }));
  const status = (["active", "approved", "disputed", "refunded"].includes(row.status) ? row.status : "active") as Escrow["status"];
  return {
    id: row.id,
    title: row.title,
    agentId: row.agentId,
    buyerWallet: row.buyerWallet as Escrow["buyerWallet"],
    amountUsdc: displayUnits(row.total),
    status,
    milestones,
    // No milestone passed its tests yet: there is no auto-release date (empty string).
    autoReleaseAt: row.autoReleaseAt ? row.autoReleaseAt.toISOString() : "",
    deliveryDeadline: row.deliveryDeadline ? row.deliveryDeadline.toISOString() : null,
    feeBps: row.feeBps ?? null,
  };
}

export function toReputation(wallet: string, row: RepRow | undefined): UserReputation {
  const purchases = row?.purchases ?? 0;
  const disputesLost = row?.disputesLost ?? 0;
  return {
    wallet: wallet as UserReputation["wallet"],
    score: reputationScore(purchases, disputesLost),
    purchases,
    disputesLost,
    guaranteeLevel: guaranteeLevel(purchases, disputesLost),
  };
}
