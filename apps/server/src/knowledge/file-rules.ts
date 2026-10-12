import { isIsoDate, parseFrontMatter } from "../runtime/validate/frontmatter.js";
import { chunkMarkdown, chunkPlainText } from "./chunk.js";

// Reading ONE knowledge file (PACKAGE_SPEC.md 6.1 and 6.2): `.md` with YAML front matter or `.txt`
// (single section) with metadata in `name.txt.meta.json`. Pure (no env, DB or disk): tested in
// test/knowledge-ingest.test.ts. v0 packages have no front matter and come out exactly as before.

/** Metadata stored in `knowledge_chunks.meta` (known fields only; the rest is discarded). */
export type KnowledgeMeta = {
  title?: string;
  source?: string;
  source_url?: string;
  source_date?: string;
  valid_until?: string;
  tags?: string[];
  /** File available in the free trial of v1 packages. */
  trial?: boolean;
};

export type ParsedKnowledgeFile = {
  chunks: string[];
  /** null: file without front matter (nor .meta.json). */
  meta: KnowledgeMeta | null;
  /** Valid `valid_until` (YYYY-MM-DD) or null. */
  validUntil: string | null;
};

/** `.md` and `.txt` go into the knowledge base; `.txt.meta.json` and everything else don't. */
export const isKnowledgeFile = (name: string): boolean => /\.(md|txt)$/i.test(name);

/** Path of a `.txt` file's metadata file: `name.txt.meta.json`. */
export const metaJsonPathFor = (txtPath: string): string => `${txtPath}.meta.json`;

const MAX_TAGS = 10;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Keeps only the known fields, with the right type. An invalid date is dropped (the validator is the one that complains). */
export function normalizeMeta(data: Record<string, unknown>): KnowledgeMeta | null {
  const meta: KnowledgeMeta = {};
  for (const k of ["title", "source", "source_url"] as const) {
    const v = str(data[k]);
    if (v) meta[k] = v;
  }
  for (const k of ["source_date", "valid_until"] as const) {
    const v = str(data[k]);
    if (v && isIsoDate(v)) meta[k] = v;
  }
  if (Array.isArray(data.tags)) {
    const tags = data.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()).slice(0, MAX_TAGS);
    if (tags.length) meta.tags = tags;
  } else if (typeof data.tags === "string" && data.tags.trim()) {
    meta.tags = [data.tags.trim()];
  }
  if (data.trial === true || (typeof data.trial === "string" && data.trial.trim().toLowerCase() === "true")) meta.trial = true;
  return Object.keys(meta).length ? meta : null;
}

/** Default title: the first `#` heading of the text. */
const firstHeading = (md: string): string | undefined => /^#{1,3}\s+(.+)$/m.exec(md)?.[1]?.trim();

/**
 * Reads a knowledge file. `name` sets the format by its extension; `metaJson` is the content of the
 * sibling `.meta.json` (only applies to `.txt`).
 */
export function parseKnowledgeFile(name: string, raw: string, metaJson?: string | null): ParsedKnowledgeFile {
  if (/\.txt$/i.test(name)) {
    let meta: KnowledgeMeta | null = null;
    if (metaJson) {
      try {
        const parsed: unknown = JSON.parse(metaJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = normalizeMeta(parsed as Record<string, unknown>);
      } catch {
        // Broken .meta.json: the file goes in without metadata (the validator rejects it earlier, at publication).
      }
    }
    return { chunks: chunkPlainText(raw), meta, validUntil: meta?.valid_until ?? null };
  }
  const fm = parseFrontMatter(raw);
  // No front matter (v0 packages): the original text, byte for byte as before.
  if (fm.kind === "none") return { chunks: chunkMarkdown(raw), meta: null, validUntil: null };
  const meta = fm.kind === "ok" ? normalizeMeta(fm.data) : null;
  if (meta && !meta.title) {
    const heading = firstHeading(fm.body);
    if (heading) meta.title = heading;
  }
  return { chunks: chunkMarkdown(fm.body), meta, validUntil: meta?.valid_until ?? null };
}
