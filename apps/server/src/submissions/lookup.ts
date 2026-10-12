import { and, eq, inArray, notInArray, or, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RESERVED_SLUGS } from "@solvers/shared";
import { PLATFORM_AGENT_IDS } from "../runtime/platform-agents.js";
import { getPackage, reloadPackages, type SolverPackage } from "../runtime/packages.js";
import { deploymentOrNull, registryConfig } from "../store/chain-reads.js";
import { DEFAULT_MIN_PRICE_UNITS } from "./rules.js";

// Database and on-disk catalog queries shared by the worker and the review: who owns the `id`/`slug`, which version is
// already published and whether the Solver is new (PACKAGE_SPEC.md 4.1, 13 and 14).

export type Ownership = {
  idOwner: Map<string, string>;
  slugOwner: Map<string, string>;
  /** `id` of the Solver THIS creator already has with the slug (catalog agent or previous submission). */
  ownAgentId?: string;
  /** Version of that Solver already published, with the manifest and folder when the on-disk catalog has them. */
  published?: { version: string; manifest?: Record<string, unknown>; dir?: string };
};

/** Owner marker for platform packages (agents/ folder): no creator is "platform". */
export const PLATFORM_OWNER = "platform";

/** States whose slug/id stays reserved for the creator (a rejected submission does not hold the name). */
const RELEASED_STATUSES = ["rejected_validation", "rejected"];

/**
 * Finds who owns the `id` and `slug` the manifest asks for. `creatorId` is `creators.id` of the signed-in creator.
 * The catalog (agents) wins; then submissions in progress; finally packages on disk (platform, still without a database row).
 */
export async function loadOwnership(args: { submissionId: string; creatorId: string; manifestId?: string; slug?: string }): Promise<Ownership> {
  const idOwner = new Map<string, string>();
  const slugOwner = new Map<string, string>();
  let ownAgentId: string | undefined;
  let publishedVersion: string | undefined;
  const { manifestId, slug } = args;

  const agentFilters = [manifestId ? eq(schema.agents.id, manifestId) : undefined, slug ? eq(schema.agents.slug, slug) : undefined].filter((f) => f !== undefined);
  if (agentFilters.length > 0) {
    const rows = await db.select().from(schema.agents).where(or(...agentFilters));
    for (const a of rows) {
      idOwner.set(a.id, a.creatorId);
      slugOwner.set(a.slug, a.creatorId);
      if (a.slug === slug && a.creatorId === args.creatorId) {
        ownAgentId = a.id;
        publishedVersion = a.version;
      }
    }
  }

  const subFilters = [manifestId ? eq(schema.packageSubmissions.agentId, manifestId) : undefined, slug ? eq(schema.packageSubmissions.slug, slug) : undefined].filter((f) => f !== undefined);
  if (subFilters.length > 0) {
    const subs = await db
      .select({ agentId: schema.packageSubmissions.agentId, slug: schema.packageSubmissions.slug, wallet: schema.packageSubmissions.creatorWallet })
      .from(schema.packageSubmissions)
      .where(and(or(...subFilters), ne(schema.packageSubmissions.id, args.submissionId), notInArray(schema.packageSubmissions.status, RELEASED_STATUSES)));
    const wallets = [...new Set(subs.map((s) => s.wallet))];
    const owners = wallets.length ? await db.select({ id: schema.creators.id, wallet: schema.creators.wallet }).from(schema.creators).where(inArray(schema.creators.wallet, wallets)) : [];
    const byWallet = new Map(owners.map((o) => [o.wallet, o.id]));
    for (const s of subs) {
      const owner = byWallet.get(s.wallet);
      if (!owner) continue;
      if (!idOwner.has(s.agentId)) idOwner.set(s.agentId, owner);
      if (s.slug && !slugOwner.has(s.slug)) slugOwner.set(s.slug, owner);
      if (s.slug === slug && owner === args.creatorId && !ownAgentId) ownAgentId = s.agentId;
    }
  }

  // Platform packages on disk without a database row yet (e.g. not published) also reserve id and slug.
  for (const key of [manifestId, slug]) {
    const pkg = key ? getPackage(key) : undefined;
    if (!pkg) continue;
    if (!idOwner.has(pkg.manifest.id)) idOwner.set(pkg.manifest.id, PLATFORM_OWNER);
    if (!slugOwner.has(pkg.manifest.slug)) slugOwner.set(pkg.manifest.slug, PLATFORM_OWNER);
  }

  let published: Ownership["published"];
  if (ownAgentId) {
    const pkg = getPackage(ownAgentId);
    if (pkg) published = { version: pkg.manifest.version, manifest: pkg.manifest as unknown as Record<string, unknown>, dir: pkg.dir };
    else if (publishedVersion) published = { version: publishedVersion };
  }
  return { idOwner, slugOwner, ownAgentId, published };
}

/**
 * Light columns of the lists (creator and admin queue): without the whole manifest (jsonb up to 10 MB), `scans` or `approved`.
 * The name comes truncated from the database and the validator counts are computed there.
 */
export const listColumns = {
  id: schema.packageSubmissions.id,
  creatorWallet: schema.packageSubmissions.creatorWallet,
  agentId: schema.packageSubmissions.agentId,
  slug: schema.packageSubmissions.slug,
  version: schema.packageSubmissions.version,
  status: schema.packageSubmissions.status,
  sizeBytes: schema.packageSubmissions.sizeBytes,
  reviewerNotes: schema.packageSubmissions.reviewerNotes,
  error: schema.packageSubmissions.error,
  createdAt: schema.packageSubmissions.createdAt,
  updatedAt: schema.packageSubmissions.updatedAt,
  name: sql<string | null>`left(${schema.packageSubmissions.manifest}->>'name', 80)`,
  errorCount: sql<number>`case when jsonb_typeof(${schema.packageSubmissions.validation}->'errors') = 'array' then jsonb_array_length(${schema.packageSubmissions.validation}->'errors') else 0 end`,
  warningCount: sql<number>`case when jsonb_typeof(${schema.packageSubmissions.validation}->'warnings') = 'array' then jsonb_array_length(${schema.packageSubmissions.validation}->'warnings') else 0 end`,
};

/** The Solver does not exist in the catalog yet (the on-chain step will be `registerAgent`, not `updateVersion`). */
export async function isNewAgent(agentId: string): Promise<boolean> {
  const [a] = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, agentId));
  return !a;
}

export async function newAgentSet(agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db.select({ id: schema.agents.id }).from(schema.agents).where(inArray(schema.agents.id, agentIds));
  const existing = new Set(rows.map((r) => r.id));
  return new Set(agentIds.filter((id) => !existing.has(id)));
}

/** Another live submission (in progress or published) of the same creator, for the same Solver and version. */
export async function duplicateVersion(args: { submissionId: string; wallet: string; agentId: string; version: string }): Promise<boolean> {
  const rows = await db
    .select({ id: schema.packageSubmissions.id })
    .from(schema.packageSubmissions)
    .where(
      and(
        eq(schema.packageSubmissions.creatorWallet, args.wallet),
        eq(schema.packageSubmissions.agentId, args.agentId),
        eq(schema.packageSubmissions.version, args.version),
        ne(schema.packageSubmissions.id, args.submissionId),
        notInArray(schema.packageSubmissions.status, [...RELEASED_STATUSES, "superseded", "withdrawn"]),
      ),
    );
  return rows.length > 0;
}

/** States in which another submission already "holds" the slug and id (approved, publishing or live): they block approving another creator. */
const HOLDING_STATUSES = ["awaiting_creator_signature", "awaiting_onchain_approval", "publishing", "publish_failed", "published", "suspended", "withdrawn"];

/**
 * Approval check (runs inside the reviewer's transaction): do the submission's id and slug still belong to its creator?
 * Returns the reason in English or null. The catalog, platform Solvers, reserved slugs and ANOTHER creator's approved
 * submissions count; another creator's merely pending submissions do not (the first to be approved wins).
 */
export async function ownershipConflict(args: { submissionId: string; wallet: string; agentId: string; slug: string }): Promise<string | null> {
  const { agentId, slug } = args;
  if (RESERVED_SLUGS.includes(slug)) return `The slug ${slug} is reserved.`;
  if (PLATFORM_AGENT_IDS.includes(agentId)) return "This Solver's id is reserved for the platform.";
  const [creator] = await db.select({ id: schema.creators.id }).from(schema.creators).where(eq(schema.creators.wallet, args.wallet));
  if (!creator) return "The creator profile for this submission no longer exists.";

  const agents = await db.select({ id: schema.agents.id, slug: schema.agents.slug, creatorId: schema.agents.creatorId }).from(schema.agents).where(or(eq(schema.agents.id, agentId), eq(schema.agents.slug, slug)));
  for (const a of agents) {
    if (a.id !== agentId) return `The slug ${slug} already belongs to another Solver in the catalog (${a.id}).`;
    // The indexer's minimal row (agent registered before the catalog) keeps the wallet as owner and the id as slug.
    if (a.creatorId !== creator.id && a.creatorId !== args.wallet) return "This Solver's id already belongs to another creator in the catalog.";
    if (a.slug !== slug && a.slug !== a.id) return `This Solver already exists in the catalog with a different slug (${a.slug}).`;
  }

  // Packages on disk: the platform's (agents/ folder) never belong to a creator.
  for (const key of [agentId, slug]) {
    const pkg = getPackage(key);
    if (pkg && (pkg.platform || pkg.source === "agents")) return "The id or slug belongs to a platform Solver.";
  }

  const holders = await db
    .select({ wallet: schema.packageSubmissions.creatorWallet })
    .from(schema.packageSubmissions)
    .where(and(ne(schema.packageSubmissions.id, args.submissionId), ne(schema.packageSubmissions.creatorWallet, args.wallet), or(eq(schema.packageSubmissions.agentId, agentId), eq(schema.packageSubmissions.slug, slug)), inArray(schema.packageSubmissions.status, HOLDING_STATUSES)))
    .limit(1);
  if (holders.length > 0) return "Another creator already has an approved version with this id or slug.";
  return null;
}

/** Packages on disk (platform + published), one per id, re-read from disk: the worker is another process and does not see the API's swaps. */
export function currentPackages(): SolverPackage[] {
  return [...new Map([...reloadPackages().values()].map((p) => [p.manifest.id, p])).values()];
}


/** Minimum price in base units: the Registry's `minPrice` when the chain context is initialized (API), never below the default (worker: the default). */
export async function minPriceUnits(): Promise<bigint> {
  if (!deploymentOrNull()) return DEFAULT_MIN_PRICE_UNITS;
  const onchain = (await registryConfig())?.minPrice ?? 0n;
  return onchain > DEFAULT_MIN_PRICE_UNITS ? onchain : DEFAULT_MIN_PRICE_UNITS;
}
