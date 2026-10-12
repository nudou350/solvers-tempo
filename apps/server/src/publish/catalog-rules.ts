import type { AgentTranslations } from "@solvers/shared";
import type { Manifest } from "../runtime/manifest.js";

// Pure rules for the catalog search text (no database or embeddings model): tested in test/catalog-rules.test.ts.
// The English text is the manifest's; the Portuguese one (locales/pt.json) goes in as extra text and extra vectors, so
// that a request in Portuguese still finds the Solver (the search model is multilingual).

type CatalogManifest = Pick<Manifest, "name" | "tagline" | "description" | "category" | "packageContents" | "requirements" | "searchPhrases">;

/** Manifest text (English) that becomes the Solver's main vector. */
export function manifestSearchText(m: CatalogManifest): string {
  return [m.name, m.tagline, m.description, m.category, ...m.packageContents, ...m.requirements.map((r) => r.label)].join("\n");
}

/** Portuguese text from the translation (name, tagline, description, contents and requirements); empty without a translation. */
export function translationSearchText(translations: AgentTranslations | null | undefined): string {
  const pt = translations?.pt;
  if (!pt) return "";
  return [pt.name, pt.tagline, pt.description, ...pt.packageContents, ...pt.requirements.map((r) => r.label)].join("\n");
}

/**
 * `agents.search_text` column: English followed by Portuguese, if present (text search covers both languages).
 * The main vector uses only `manifestSearchText`: mixing languages in a single vector would leave it halfway between them.
 */
export function fullSearchText(m: CatalogManifest, translations: AgentTranslations | null | undefined): string {
  const pt = translationSearchText(translations);
  return pt ? `${manifestSearchText(m)}\n${pt}` : manifestSearchText(m);
}

/**
 * Short phrases that become extra vectors (one per phrase): name and tagline, the typical requests (searchPhrases) and, with a
 * translation, the same in Portuguese plus the whole Portuguese text (a long request in Portuguese matches it).
 */
export function searchPhrasesOf(m: CatalogManifest, translations: AgentTranslations | null | undefined): string[] {
  const phrases = [`${m.name}: ${m.tagline}`, ...m.searchPhrases];
  const pt = translations?.pt;
  if (pt) phrases.push(`${pt.name}: ${pt.tagline}`, ...(pt.searchPhrases ?? []), translationSearchText(translations));
  // No duplicates (e.g. the same name in both languages): a repeated vector only wastes an embedding.
  return [...new Set(phrases)];
}
