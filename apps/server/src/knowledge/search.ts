import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { embed, embeddingsLoaded, toVectorLiteral } from "./embeddings.js";

type AgentRow = typeof schema.agents.$inferSelect;

/** Maximum cosine distance above the best result for a result to still appear as a suggestion. */
const RELEVANCE_MARGIN = 0.01;

/** Natural-language search for the storefront and find_solver: top N active solvers for the need. */
export async function searchAgentRows(need: string, limit = 3): Promise<AgentRow[]> {
  const listed = and(eq(schema.agents.status, "active"), eq(schema.agents.platformStatus, "active"), eq(schema.agents.listed, true));
  // While the model loads (first boot), use full text so the request doesn't hang.
  const vec = embeddingsLoaded() ? (await embed([need], "query"))?.[0] : undefined;
  if (vec) {
    // A solver's distance = that of its best-matching vector (full text, tagline or one of the searchPhrases).
    const q = sql`${toVectorLiteral(vec)}::vector`;
    // Columns qualified by hand: in a select drizzle writes just "id", which inside the subquery would be v's.
    const dist = sql<number>`least(${schema.agents}.embedding <=> ${q}, (select min(v.embedding <=> ${q}) from ${schema.agentSearchVectors} v where v.agent_id = ${schema.agents}.id))`;
    const rows = await db
      .select({ agent: schema.agents, dist })
      .from(schema.agents)
      .where(and(listed, sql`${schema.agents.embedding} is not null`))
      .orderBy(dist)
      .limit(limit);
    // e5 distances all fall in a narrow band: only results right next to the best one get in,
    // otherwise a clear request ("a nice website") comes with travel and copywriting just to fill 3 slots.
    if (rows.length > 0) return rows.filter((r) => Number(r.dist) - Number(rows[0]!.dist) <= RELEVANCE_MARGIN).map((r) => r.agent);
  }
  const rank = sql`ts_rank(to_tsvector('portuguese', ${schema.agents.searchText}), websearch_to_tsquery('portuguese', ${need}))`;
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(listed, sql`to_tsvector('portuguese', ${schema.agents.searchText}) @@ websearch_to_tsquery('portuguese', ${need})`))
    .orderBy(desc(rank))
    .limit(limit);
  if (rows.length > 0) return rows;
  // No term in common at all: search for any word (OR) before giving up.
  const words = need
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3)
    .slice(0, 8);
  if (words.length > 0) {
    const orQuery = words.join(" | ");
    const anyRows = await db
      .select()
      .from(schema.agents)
      .where(
        and(listed, sql`to_tsvector('portuguese', ${schema.agents.searchText}) @@ to_tsquery('portuguese', ${orQuery})`),
      )
      .orderBy(desc(sql`ts_rank(to_tsvector('portuguese', ${schema.agents.searchText}), to_tsquery('portuguese', ${orQuery}))`))
      .limit(limit);
    if (anyRows.length > 0) return anyRows;
  }
  return [];
}

export type KnowledgeHit = { source: string; content: string; score: number; meta: Record<string, unknown> | null; validUntil: string | null };

/**
 * Up to N chunks from the solver's knowledge base (current version) most relevant to the question.
 * `trialOnly`: only chunks from files with `trial: true` in the front matter (free trial of a v1 package).
 */
export async function searchKnowledge(agentId: string, version: string, query: string, limit = 5, opts: { trialOnly?: boolean } = {}): Promise<KnowledgeHit[]> {
  const kc = schema.knowledgeChunks;
  const base = and(eq(kc.agentId, agentId), eq(kc.version, version), opts.trialOnly ? sql`${kc.meta} ->> 'trial' = 'true'` : undefined);
  const cols = { source: kc.source, content: kc.content, meta: kc.meta, validUntil: kc.validUntil };
  const hit = (r: { source: string; content: string; meta: Record<string, unknown> | null; validUntil: string | null }, score: number): KnowledgeHit => ({
    source: r.source,
    content: r.content,
    score,
    meta: r.meta ?? null,
    validUntil: r.validUntil ?? null,
  });
  const vec = embeddingsLoaded() ? (await embed([query], "query"))?.[0] : undefined;
  if (vec) {
    const dist = sql<number>`${kc.embedding} <=> ${toVectorLiteral(vec)}::vector`;
    const rows = await db
      .select({ ...cols, dist })
      .from(kc)
      .where(and(base, sql`${kc.embedding} is not null`))
      .orderBy(dist)
      .limit(limit);
    if (rows.length > 0) return rows.map((r) => hit(r, 1 - Number(r.dist)));
  }
  const rank = sql<number>`ts_rank(to_tsvector('portuguese', ${kc.content}), websearch_to_tsquery('portuguese', ${query}))`;
  const rows = await db
    .select({ ...cols, rank })
    .from(kc)
    .where(and(base, sql`to_tsvector('portuguese', ${kc.content}) @@ websearch_to_tsquery('portuguese', ${query})`))
    .orderBy(desc(rank))
    .limit(limit);
  if (rows.length > 0) return rows.map((r) => hit(r, Number(r.rank)));
  // Nothing matched: return the first chunks (overview) so the AI isn't left without context.
  const first = await db.select(cols).from(kc).where(base).orderBy(kc.id).limit(Math.min(limit, 2));
  return first.map((r) => hit(r, 0));
}
