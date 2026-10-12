import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Agent, AgentDetail, AgentTranslations, CatalogLang, Creator, CreatorProfile, GuaranteeOffer } from "@solvers/shared";
import { agentIdToBytes32, averageRating, bpsToScore, creatorBioFor, splitGuaranteeAmounts } from "@solvers/shared";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { toImageRefs } from "../images/refs.js";
import { notFound } from "../lib/http.js";
import { displayUnits } from "../lib/money.js";
import { isAgentId } from "../runtime/agent-ids.js";
import { getPackage } from "../runtime/packages.js";
import { trialInfo } from "../runtime/trial.js";
import { deploymentOrNull } from "./chain-reads.js";
import { brlPerUsd } from "./fx.js";
import { textMatchesHash } from "./review-rules.js";
import { currentEvalBps, guaranteeOffered, toAgent, toCreator, toReview, type AgentExtras, type CreatorStats } from "./mappers.js";

type AgentRow = typeof schema.agents.$inferSelect;

/** Usage trend: % change of the uses of the last 7 days against the 7 before. */
export async function agentExtras(ids: string[]): Promise<Map<string, AgentExtras>> {
  const out = new Map<string, AgentExtras>(ids.map((id) => [id, { trend7d: 0 }]));
  if (ids.length === 0) return out;
  const usage = await db
    .select({
      agentId: schema.usageEvents.agentId,
      recent: sql<number>`count(*) filter (where ${schema.usageEvents.createdAt} > now() - interval '7 days')`.mapWith(Number),
      previous: sql<number>`count(*) filter (where ${schema.usageEvents.createdAt} <= now() - interval '7 days' and ${schema.usageEvents.createdAt} > now() - interval '14 days')`.mapWith(Number),
    })
    .from(schema.usageEvents)
    .where(and(inArray(schema.usageEvents.agentId, ids), sql`${schema.usageEvents.tool} = 'activate_solver'`))
    .groupBy(schema.usageEvents.agentId);
  for (const u of usage) {
    if (!u.agentId) continue;
    const trend = u.previous === 0 ? (u.recent > 0 ? 100 : 0) : ((u.recent - u.previous) / u.previous) * 100;
    out.get(u.agentId)!.trend7d = Math.round(trend * 10) / 10;
  }
  return out;
}

/** `lang`: language of the catalog texts (pt overlays the package translation; en, the default, is the manifest's). */
export async function mapAgents(rows: AgentRow[], lang: CatalogLang = "en"): Promise<Agent[]> {
  const extras = await agentExtras(rows.map((r) => r.id));
  return rows.map((r) => toAgent(r, extras.get(r.id)!, lang));
}

export type ListQuery = { q?: string; category?: string; sort?: "rating" | "uses" | "trend" | "new"; limit?: number; lang?: CatalogLang };

/** Uses (activations) of the last 7 days against the 7 before, computed in the database for sorting. */
const trendSql = sql`(
  select case when prev = 0 then (case when recent > 0 then 100 else 0 end) else (recent - prev)::float / prev * 100 end
  from (
    select
      count(*) filter (where u.created_at > now() - interval '7 days') as recent,
      count(*) filter (where u.created_at <= now() - interval '7 days' and u.created_at > now() - interval '14 days') as prev
    from usage_events u
    where u.agent_id = ${schema.agents.id} and u.tool = 'activate_solver'
  ) t
)`;

/** Date of the manifest's first version (the same as Agent.publishedAt), or of the database row. */
const publishedAtSql = sql`coalesce(
  (select min((v->>'releasedAt')::timestamptz) from jsonb_array_elements(coalesce(${schema.agents.details}->'versions', '[]'::jsonb)) v),
  ${schema.agents.createdAt}
)`;

export async function listAgents(query: ListQuery): Promise<Agent[]> {
  const conds = [eq(schema.agents.status, "active"), eq(schema.agents.platformStatus, "active"), eq(schema.agents.listed, true)];
  if (query.category) conds.push(eq(schema.agents.category, query.category));
  if (query.q) {
    const like = `%${query.q}%`;
    conds.push(
      or(
        sql`to_tsvector('portuguese', ${schema.agents.searchText}) @@ plainto_tsquery('portuguese', ${query.q})`,
        sql`${schema.agents.name} ilike ${like}`,
        sql`${schema.agents.tagline} ilike ${like}`,
        // Portuguese translation (locales/pt.json): searching by the Portuguese name or tagline also finds it.
        sql`${schema.agents.translations} -> 'pt' ->> 'name' ilike ${like}`,
        sql`${schema.agents.translations} -> 'pt' ->> 'tagline' ilike ${like}`,
      )!,
    );
  }
  const order =
    query.sort === "uses"
      ? [desc(schema.agents.verifiedUses)]
      : query.sort === "new"
        ? [desc(publishedAtSql)]
        : query.sort === "trend"
          ? [desc(trendSql), desc(schema.agents.verifiedUses)]
          : [desc(sql`case when ${schema.agents.ratingCount} = 0 then 0 else ${schema.agents.ratingSum}::float / ${schema.agents.ratingCount} end`), desc(schema.agents.ratingCount)];
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(...conds))
    .orderBy(...order)
    .limit(query.limit ?? 100);
  return mapAgents(rows, query.lang);
}

/**
 * Looks up by `id` (32 hex) or `slug`, never both: the format decides the column. A slug can never look like an id
 * (validated in the manifest), so one Solver cannot "steal" another's lookup.
 */
export async function findAgentRow(idOrSlug: string): Promise<AgentRow> {
  const [row] = await db
    .select()
    .from(schema.agents)
    .where(isAgentId(idOrSlug) ? eq(schema.agents.id, idOrSlug) : eq(schema.agents.slug, idOrSlug))
    .limit(1);
  if (!row) throw notFound("Specialist not found");
  return row;
}

export async function creatorStats(creatorId: string): Promise<CreatorStats> {
  const [s] = await db
    .select({
      totalSales: sql<number>`coalesce(sum(${schema.agents.totalSales}), 0)`.mapWith(Number),
      ratingSum: sql<number>`coalesce(sum(${schema.agents.ratingSum}), 0)`.mapWith(Number),
      ratingCount: sql<number>`coalesce(sum(${schema.agents.ratingCount}), 0)`.mapWith(Number),
      disputesLost: sql<number>`coalesce(sum(${schema.agents.disputesLost}), 0)`.mapWith(Number),
      agentsPublished: sql<number>`count(*) filter (where ${schema.agents.status} = 'active' and ${schema.agents.platformStatus} = 'active')`.mapWith(Number),
    })
    .from(schema.agents)
    .where(eq(schema.agents.creatorId, creatorId));
  return {
    totalSales: s?.totalSales ?? 0,
    avgRating: averageRating(s?.ratingSum ?? 0, s?.ratingCount ?? 0),
    disputesLost: s?.disputesLost ?? 0,
    agentsPublished: s?.agentsPublished ?? 0,
  };
}

/** Translations (oldest first) of each creator's Solvers: only fetched when the language is not the default. */
async function creatorTranslations(creatorIds: string[], lang: CatalogLang): Promise<Map<string, AgentTranslations[]>> {
  const out = new Map<string, AgentTranslations[]>();
  if (lang === "en" || creatorIds.length === 0) return out;
  const rows = await db
    .select({ creatorId: schema.agents.creatorId, translations: schema.agents.translations })
    .from(schema.agents)
    .where(and(inArray(schema.agents.creatorId, creatorIds), sql`${schema.agents.translations} -> 'pt' ->> 'creatorBio' is not null`))
    .orderBy(asc(schema.agents.createdAt));
  for (const r of rows) out.set(r.creatorId, [...(out.get(r.creatorId) ?? []), r.translations]);
  return out;
}

export async function getCreator(creatorId: string, lang: CatalogLang = "en") {
  const [row] = await db.select().from(schema.creators).where(eq(schema.creators.id, creatorId));
  if (!row) return null;
  const bio = creatorBioFor(row.bio, (await creatorTranslations([creatorId], lang)).get(creatorId) ?? [], lang);
  return toCreator(row, await creatorStats(creatorId), bio);
}

/** Every creator with a Solver in the storefront (for the cards to show name and reputation). */
export async function listCreators(lang: CatalogLang = "en"): Promise<Creator[]> {
  const rows = await db
    .select()
    .from(schema.creators)
    .where(
      sql`exists (select 1 from ${schema.agents} a where a.creator_id = ${schema.creators.id} and a.status = 'active' and a.platform_status = 'active' and a.listed)`,
    )
    .orderBy(schema.creators.name);
  const translations = await creatorTranslations(rows.map((r) => r.id), lang);
  return Promise.all(rows.map(async (r) => toCreator(r, await creatorStats(r.id), creatorBioFor(r.bio, translations.get(r.id) ?? [], lang))));
}

export async function getCreatorProfile(creatorId: string, lang: CatalogLang = "en"): Promise<CreatorProfile> {
  const creator = await getCreator(creatorId, lang);
  if (!creator) throw notFound("Creator not found");
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.creatorId, creatorId), eq(schema.agents.status, "active"), eq(schema.agents.platformStatus, "active"), eq(schema.agents.listed, true)));
  return { creator, agents: await mapAgents(rows, lang) };
}

export async function listReviews(agentId: string, limit = 50) {
  const rows = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.agentId, agentId), eq(schema.reviews.onchain, true)))
    .orderBy(desc(schema.reviews.createdAt))
    .limit(limit);
  const wallets = [...new Set(rows.map((r) => r.authorWallet))];
  const names = wallets.length
    ? await db
        .select({ wallet: schema.userProfiles.wallet, name: schema.userProfiles.displayName })
        .from(schema.userProfiles)
        .where(inArray(schema.userProfiles.wallet, wallets))
    : [];
  const nameOf = new Map(names.map((n) => [n.wallet, n.name]));
  const imgRows = rows.length
    ? await db
        .select()
        .from(schema.reviewImages)
        .where(inArray(schema.reviewImages.reviewId, rows.map((r) => r.id)))
        .orderBy(asc(schema.reviewImages.position))
    : [];
  const imagesOf = (reviewId: string) => toImageRefs(imgRows.filter((i) => i.reviewId === reviewId));
  // The text is off-chain: it only shows when its sha256 matches the hash confirmed on-chain.
  return rows.map((r) => toReview(textMatchesHash(r.text, r.contentHash) ? r : { ...r, text: "" }, nameOf.get(r.authorWallet) ?? null, imagesOf(r.id)));
}

export async function getAgentDetail(idOrSlug: string, lang: CatalogLang = "en"): Promise<AgentDetail> {
  const row = await findAgentRow(idOrSlug);
  const extras = (await agentExtras([row.id])).get(row.id)!;
  const agent = toAgent(row, extras, lang);
  const creator =
    (await getCreator(row.creatorId, lang)) ?? {
      id: row.creatorId,
      name: "Creator",
      avatarUrl: null,
      bio: "",
      reputationScore: 50,
      disputesLost: 0,
      agentsPublished: 1,
    };
  const rate = await brlPerUsd();
  const dist = await db
    .select({ rating: schema.reviews.rating, n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.reviews)
    .where(and(eq(schema.reviews.agentId, row.id), eq(schema.reviews.onchain, true)))
    .groupBy(schema.reviews.rating);
  const d = deploymentOrNull();
  const [creatorRow] = await db.select({ wallet: schema.creators.wallet }).from(schema.creators).where(eq(schema.creators.id, row.creatorId));
  return {
    agent,
    creator,
    reviews: await listReviews(row.id, 10),
    images: toImageRefs(await db.select().from(schema.agentImages).where(eq(schema.agentImages.agentId, row.id)).orderBy(asc(schema.agentImages.position))),
    beforeAfter: row.details.beforeAfter ?? [],
    versions: row.details.versions ?? [
      {
        version: row.version,
        versionHash: row.versionHash,
        releasedAt: row.createdAt.toISOString(),
        notes: "Current version",
        evalScore: row.evalVersionHash ? bpsToScore(currentEvalBps(row)) : null,
      },
    ],
    trial: agentTrial(row.id),
    priceBrl: Math.round(displayUnits(row.price) * rate * 100) / 100,
    ratingDistribution: [5, 4, 3, 2, 1].map((star) => dist.find((x) => x.rating === star)?.n ?? 0),
    onchain: {
      agentId: row.chainIndex !== null ? agentIdToBytes32(row.id) : null,
      registry: d ? (d.registry.toLowerCase() as `0x${string}`) : null,
      licenseContract: d ? (d.license.toLowerCase() as `0x${string}`) : null,
      creatorWallet: (creatorRow?.wallet as `0x${string}` | undefined) ?? null,
    },
    guarantee: guaranteeOffer(row, rate),
  };
}

/** Free trial from the manifest on disk (the one the connector enforces); null when there is none. */
function agentTrial(agentId: string) {
  const pkg = getPackage(agentId);
  return pkg ? trialInfo(pkg) : null;
}

/** The creator's guaranteed-task template, with the amount of each milestone already computed. */
export function guaranteeOffer(row: AgentRow, brlRate: number): GuaranteeOffer | null {
  const t = row.details.guaranteeTemplate;
  if (!t || !guaranteeOffered(row)) return null;
  const amounts = splitGuaranteeAmounts(t.priceUsdc, t.milestones.map((m) => m.sharePct), env.PAYMENT_TOKEN_DECIMALS);
  return {
    priceUsdc: t.priceUsdc,
    priceBrl: Math.round(t.priceUsdc * brlRate * 100) / 100,
    reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
    milestones: t.milestones.map((m, i) => ({ title: m.title, criteria: m.criteria, amountUsdc: amounts[i]!, verify: m.verify ?? "tests" })),
  };
}

export async function listCategories(): Promise<{ category: string; count: number }[]> {
  return db
    .select({ category: schema.agents.category, count: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.agents)
    .where(and(eq(schema.agents.status, "active"), eq(schema.agents.platformStatus, "active"), eq(schema.agents.listed, true)))
    .groupBy(schema.agents.category)
    .orderBy(schema.agents.category);
}
