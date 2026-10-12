import { eq, sql } from "drizzle-orm";
import { DELIST_MAX_RATING, DELIST_MIN_REVIEWS, numberToUnits } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { embed } from "../knowledge/embeddings.js";
import type { SolverPackage } from "../runtime/packages.js";
import { fullSearchText, manifestSearchText, searchPhrasesOf } from "./catalog-rules.js";

// Catalog (`agents` table and search vectors) from a package. Shared by `cli:publish` and the site's finalization
// (publish/finalize.ts): both build the SAME row, and the platform packages (agents/) behave as before. Two phases:
// `prepareCatalog` does what is slow and may fail (search vectors, without touching the database) and `writeCatalog`
// writes, accepting a transaction so the caller swaps everything at once.

/** `agents.search_text`: the manifest's English plus the Portuguese of locales/pt.json (see catalog-rules.ts). */
export function searchText(pkg: SolverPackage): string {
  return fullSearchText(pkg.manifest, pkg.translations);
}

type Exec = Pick<typeof db, "insert" | "update" | "delete">;

export type CatalogOptions = {
  /** Values the row uses instead of the package/manifest (e.g. the server's `id`). */
  agentId?: string;
  /** Creator profile id (`creators.id`) instead of the manifest's `creator.id` (on submissions, the server decides). */
  creatorId?: string;
  /** Writes (or updates) the creator row from the manifest. False for third parties: the profile comes from sign-up. */
  upsertCreator?: boolean;
  /** Price in token base units instead of the manifest's (platform Solver: 0). */
  priceUnits?: bigint;
  /** Also writes `status` on insert AND update (platform Solver without an on-chain agent: `active`). With a chain, the mirror writes it. */
  status?: string;
  /** `status` of a brand-new row only (finalization: the chain was just read as Active); an existing row keeps its status. */
  insertStatus?: string;
};

export type PreparedCatalog = {
  pkg: SolverPackage;
  text: string;
  phrases: string[];
  vec: number[] | null;
  phraseVecs: number[][];
};

/** Search vectors: one for the whole text and one per short phrase (a vague request matches the phrase, not lost in the description). */
export async function prepareCatalog(pkg: SolverPackage): Promise<PreparedCatalog> {
  const m = pkg.manifest;
  const text = searchText(pkg);
  // Main vector from the English only; the Portuguese enters as extra vectors (phrases + whole text).
  const phrases = searchPhrasesOf(m, pkg.translations);
  const [vec = null, ...phraseVecs] = (await embed([manifestSearchText(m), ...phrases], "passage")) ?? [];
  return { pkg, text, phrases, vec, phraseVecs };
}

export function agentDetails(pkg: SolverPackage) {
  const m = pkg.manifest;
  return {
    beforeAfter: m.beforeAfter,
    versions: (m.versions.length ? m.versions : [{ version: m.version, releasedAt: new Date().toISOString(), notes: "First release" }]).map((v) => ({
      version: v.version,
      versionHash: v.version === m.version ? pkg.versionHash : "",
      releasedAt: v.releasedAt,
      notes: v.notes,
      evalScore: v.version === m.version && pkg.evalReport ? pkg.evalReport.scoreBps / 100 : null,
    })),
    tools: m.tools,
    guaranteeCriteria: m.guarantee.defaultCriteria,
    guaranteeTemplate: m.guarantee.available
      ? {
          priceUsdc: m.guarantee.priceUsdc ?? m.pricing.priceUsdc,
          milestones: m.guarantee.milestones ?? [{ title: "Delivery", criteria: m.guarantee.defaultCriteria, sharePct: 100, verify: "tests" as const }],
        }
      : undefined,
    catalogOnly: m.catalogOnly ?? false,
  };
}

/** Writes the agent row and the search vectors. `exec` may be a transaction (`db.transaction`). */
export async function writeCatalog(prepared: PreparedCatalog, creatorWallet: string, opts: CatalogOptions = {}, exec: Exec = db): Promise<void> {
  const { pkg, text, phrases, vec, phraseVecs } = prepared;
  const m = pkg.manifest;
  const agentId = opts.agentId ?? m.id;
  if (opts.upsertCreator !== false) {
    await exec
      .insert(schema.creators)
      .values({ id: m.creator.id, wallet: creatorWallet.toLowerCase(), name: m.creator.name, bio: m.creator.bio, avatarUrl: m.creator.avatarUrl ?? null })
      .onConflictDoUpdate({ target: schema.creators.id, set: { name: m.creator.name, bio: m.creator.bio, avatarUrl: m.creator.avatarUrl ?? null } });
  }
  const values = {
    slug: m.slug,
    name: m.name,
    tagline: m.tagline,
    description: m.description,
    category: m.category,
    creatorId: opts.creatorId ?? m.creator.id,
    version: m.version,
    versionHash: pkg.versionHash,
    price: opts.priceUnits ?? numberToUnits(m.pricing.priceUsdc, env.PAYMENT_TOKEN_DECIMALS),
    // Lifetime licenses only: pay-per-use is off (the contract keeps the field, always 0 here).
    pricePerUse: 0n,
    royaltyBps: m.pricing.royaltyBps,
    requirements: m.requirements,
    packageContents: m.packageContents,
    translations: pkg.translations,
    guaranteeAvailable: m.guarantee.available,
    details: agentDetails(pkg),
    searchText: text,
    embedding: vec,
    ...(opts.status ? { status: opts.status } : {}),
    updatedAt: new Date(),
  };
  const insertStatus = opts.status ?? opts.insertStatus;
  await exec
    .insert(schema.agents)
    .values({ id: agentId, ...values, ...(insertStatus ? { status: insertStatus } : {}) })
    .onConflictDoUpdate({ target: schema.agents.id, set: values });
  await exec.delete(schema.agentSearchVectors).where(eq(schema.agentSearchVectors.agentId, agentId));
  if (phraseVecs.length > 0) {
    await exec.insert(schema.agentSearchVectors).values(phraseVecs.map((embedding, i) => ({ agentId, content: phrases[i]!, embedding })));
  }
}

/** Prepare and write at once (`cli:publish`). */
export async function upsertCatalog(pkg: SolverPackage, creatorWallet: string, opts: CatalogOptions = {}): Promise<void> {
  await writeCatalog(await prepareCatalog(pkg), creatorWallet, opts);
}

/** Back in the store unless the rating is still below the minimum (the job would delist it again). Only after the full catalog. */
export async function relist(agentId: string, exec: Pick<typeof db, "update"> = db): Promise<void> {
  await exec
    .update(schema.agents)
    .set({ listed: sql`not (${schema.agents.ratingCount} >= ${DELIST_MIN_REVIEWS} and ${schema.agents.ratingSum}::float / nullif(${schema.agents.ratingCount}, 0) < ${DELIST_MAX_RATING})` })
    .where(eq(schema.agents.id, agentId));
}
