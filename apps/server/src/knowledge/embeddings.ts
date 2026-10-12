import { env } from "../env.js";

// Local embeddings (INSTRUCTIONS.md 5.5) with transformers.js and multilingual-e5-small (384 dims).
// e5 expects the "query: " and "passage: " prefixes. If the model fails to load, search falls back to
// Postgres full text (plan B) and nothing breaks.

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor | null> | null = null;
let loaded = false;

/** true when the model is already loaded in memory (non-blocking). */
export function embeddingsLoaded(): boolean {
  return loaded;
}

/** Loads the model in the background at boot. */
export function warmEmbeddings() {
  extractor ??= load();
  void extractor.then((x) => (loaded = x != null));
}
export const EMBEDDING_DIMS = 384;

async function load(): Promise<Extractor | null> {
  if (env.SEARCH_MODE === "fts") return null;
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const pipe = (await pipeline("feature-extraction", env.EMBEDDING_MODEL, { dtype: "q8" })) as unknown as Extractor;
    console.log(`[embeddings] model ${env.EMBEDDING_MODEL} loaded`);
    return pipe;
  } catch (e) {
    console.warn("[embeddings] unavailable, using full-text search:", (e as Error).message);
    return null;
  }
}

export function embeddingsReady(): Promise<boolean> {
  extractor ??= load();
  return extractor.then((x) => x != null);
}

export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][] | null> {
  extractor ??= load();
  const ex = await extractor;
  if (!ex || texts.length === 0) return ex ? [] : null;
  const out: number[][] = [];
  // Small batches so the VPS doesn't run out of memory.
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => `${kind}: ${t.slice(0, 2000)}`);
    const res = await ex(batch, { pooling: "mean", normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}
