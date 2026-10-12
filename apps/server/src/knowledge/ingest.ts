import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { embed } from "./embeddings.js";
import { isKnowledgeFile, metaJsonPathFor, parseKnowledgeFile } from "./file-rules.js";
import { searchKnowledge } from "./search.js";
import type { SolverPackage } from "../runtime/packages.js";

// Knowledge base ingestion (INSTRUCTIONS.md 5.5 and PACKAGE_SPEC.md 6): `.md` (with optional front
// matter) and `.txt` (with optional `name.txt.meta.json`) into chunks. The splitting lives in chunk.ts, pure, and is
// the same one the validator uses. v0 packages (no front matter) keep storing exactly what they used to.

type KnowledgeRow = typeof schema.knowledgeChunks.$inferInsert;

type DiscoveredFile = { abs: string; /** `knowledge/<path inside the folder>`: what goes into knowledge_chunks.source. */ source: string };

/**
 * Knowledge files in a stable order (resuming relies on the position). `dir` may be the package root
 * (with `knowledge/`) or the knowledge folder itself; the stored `source` is always `knowledge/<relative>`.
 * Skips hidden files, node_modules and symbolic links.
 */
function discover(dir: string, packageRoot = false): DiscoveredFile[] {
  const sub = join(dir, "knowledge");
  const hasSub = existsSync(sub) && lstatSync(sub).isDirectory();
  // Package root (has manifest.json or was flagged as such) without knowledge/: there is no knowledge (never reads steps/ as the base).
  if (!hasSub && (packageRoot || existsSync(join(dir, "manifest.json")))) return [];
  const root = hasSub ? sub : dir;
  if (!existsSync(root)) return [];
  const out: DiscoveredFile[] = [];
  const walk = (cur: string, rel: string[]) => {
    for (const name of readdirSync(cur)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = join(cur, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, [...rel, name]);
      else if (isKnowledgeFile(name)) out.push({ abs, source: ["knowledge", ...rel, name].join("/").split(sep).join("/") });
    }
  };
  walk(root, []);
  return out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** Reads the file, splits it into chunks and computes the vectors (null when the embeddings model is unavailable). */
async function prepareFile(agentId: string, version: string, f: DiscoveredFile): Promise<KnowledgeRow[]> {
  const raw = readFileSync(f.abs, "utf8");
  const metaPath = metaJsonPathFor(f.abs);
  const metaJson = /\.txt$/i.test(f.abs) && existsSync(metaPath) ? readFileSync(metaPath, "utf8") : null;
  const parsed = parseKnowledgeFile(f.abs, raw, metaJson);
  const vectors = await embed(parsed.chunks, "passage");
  return parsed.chunks.map((content, i) => ({
    agentId,
    version,
    source: f.source,
    content,
    meta: parsed.meta ? { ...parsed.meta } : null,
    validUntil: parsed.validUntil,
    embedding: vectors?.[i] ?? null,
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Inserts in batches (Postgres parameter limit). */
async function insertRows(tx: Tx, rows: KnowledgeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) await tx.insert(schema.knowledgeChunks).values(rows.slice(i, i + 200));
}

const versionOf = (agentId: string, version: string) => and(eq(schema.knowledgeChunks.agentId, agentId), eq(schema.knowledgeChunks.version, version));

async function countChunks(agentId: string, version: string, sources?: string[]): Promise<number> {
  if (sources && sources.length === 0) return 0;
  const [r] = await db
    .select({ n: count() })
    .from(schema.knowledgeChunks)
    .where(and(versionOf(agentId, version), sources ? inArray(schema.knowledgeChunks.source, sources) : undefined));
  return Number(r?.n ?? 0);
}

export type IngestKnowledgeOpts = {
  agentId: string;
  /** Package version; may be `staging:<id>` (review test ingestion). */
  version: string;
  dir: string;
  /** How many files (in the stable order) were already ingested: resuming skips them. */
  resumeFromFile?: number;
  /** Called after each file: files done, total and chunks stored so far. */
  onFile?: (done: number, total: number, chunks: number) => void | Promise<void>;
};

/**
 * Ingests a knowledge folder into the given version, file by file. Idempotent per file: each one
 * deletes its own chunks before rewriting them (resuming or repeating doesn't duplicate). At the end, chunks of
 * files no longer in the folder are removed from the version. Returns the version's total files and chunks.
 */
export async function ingestKnowledgeDir(opts: IngestKnowledgeOpts): Promise<{ files: number; chunks: number }> {
  const { agentId, version } = opts;
  const files = discover(opts.dir);
  const start = Math.min(Math.max(0, Math.trunc(opts.resumeFromFile ?? 0)), files.length);
  let chunks = await countChunks(agentId, version, files.slice(0, start).map((f) => f.source));
  for (const [i, f] of files.entries()) {
    if (i < start) continue;
    const rows = await prepareFile(agentId, version, f);
    await db.transaction(async (tx) => {
      await tx.delete(schema.knowledgeChunks).where(and(versionOf(agentId, version), eq(schema.knowledgeChunks.source, f.source)));
      await insertRows(tx, rows);
    });
    chunks += rows.length;
    await opts.onFile?.(i + 1, files.length, chunks);
  }
  // A file removed from the folder must no longer be served.
  const sources = files.map((f) => f.source);
  await db.delete(schema.knowledgeChunks).where(and(versionOf(agentId, version), sources.length ? notInArray(schema.knowledgeChunks.source, sources) : undefined));
  return { files: files.length, chunks: await countChunks(agentId, version) };
}

/**
 * Package publication (cli:publish and seed): swaps the whole version in a single transaction, so searchers
 * never see a half-written base. Returns the number of chunks.
 */
export async function ingestPackage(pkg: SolverPackage): Promise<number> {
  const { id, version } = pkg.manifest;
  const rows: KnowledgeRow[] = [];
  for (const f of discover(pkg.dir, true)) rows.push(...(await prepareFile(id, version, f)));
  await db.transaction(async (tx) => {
    await tx.delete(schema.knowledgeChunks).where(versionOf(id, version));
    await insertRows(tx, rows);
  });
  return rows.length;
}

/**
 * Review approval: the test version's chunks become the real version's, WITHOUT recomputing
 * vectors. If `to` already had chunks (republishing the same version), they are removed in the same transaction.
 * Returns how many chunks changed version (0: `from` was empty and nothing was touched).
 */
export async function renameKnowledgeVersion(agentId: string, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  return db.transaction(async (tx) => {
    const [has] = await tx.select({ n: count() }).from(schema.knowledgeChunks).where(versionOf(agentId, from));
    if (!Number(has?.n ?? 0)) return 0;
    await tx.delete(schema.knowledgeChunks).where(versionOf(agentId, to));
    const moved = await tx.update(schema.knowledgeChunks).set({ version: to }).where(versionOf(agentId, from)).returning({ id: schema.knowledgeChunks.id });
    return moved.length;
  });
}

/** Deletes all chunks of a version (discarded staging, old version). Returns how many. */
export async function deleteKnowledgeVersion(agentId: string, version: string): Promise<number> {
  const gone = await db.delete(schema.knowledgeChunks).where(versionOf(agentId, version)).returning({ id: schema.knowledgeChunks.id });
  return gone.length;
}

/** Reviewer search in a test version (`staging:<id>`): same ranking as the real search, with no quota or free trial. */
export async function searchKnowledgeInVersion(agentId: string, version: string, query: string, k = 5): Promise<{ source: string; content: string; score: number }[]> {
  const hits = await searchKnowledge(agentId, version, query, k);
  return hits.map((h) => ({ source: h.source, content: h.content, score: h.score }));
}
