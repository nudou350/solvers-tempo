import { z } from "zod";
import type { Requirement } from "./schemas.js";

// Catalog texts per language (PACKAGE_SPEC.md, "Localization"). The package is in English (manifest.json) and may ship
// `locales/pt.json` with the storefront texts in Portuguese. Catalog text only: steps, knowledge and tools stay in a
// single language. No env/database: the same rule serves the server and the front end.

/** Languages served by the catalog. The default (en) comes from the manifest; the others are overlays. */
export const CATALOG_LANGS = ["en", "pt"] as const;
export type CatalogLang = (typeof CATALOG_LANGS)[number];
export const DEFAULT_CATALOG_LANG: CatalogLang = "en";

/** Languages a package can translate with `locales/<lang>.json` (only pt for now). */
export const PACKAGE_LOCALE_LANGS = ["pt"] as const;
export type PackageLocaleLang = (typeof PACKAGE_LOCALE_LANGS)[number];

/** Path of each translation file inside the package. */
export const localeFilePath = (lang: PackageLocaleLang): string => `locales/${lang}.json`;

/** Translated requirement: matched to the manifest's by `key` (only the text changes; type, optional and howTo come from the manifest). */
export const LocaleRequirement = z.object({ key: z.string().min(1).max(60), label: z.string().min(1).max(200) }).strict();

/** Contents of `locales/<lang>.json`. Strict: an unknown field is an error (avoids a translation that never shows). */
export const PackageLocale = z
  .object({
    name: z.string().trim().min(1).max(80),
    tagline: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(3000),
    packageContents: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
    requirements: z.array(LocaleRequirement).max(10).default([]),
    /** Typical requests in the language: they become extra search vectors (someone searching in Portuguese finds the Solver). */
    searchPhrases: z.array(z.string().min(3).max(120)).max(20).optional(),
    /** Creator bio in the language (the storefront shows it on the creator's profile). */
    creatorBio: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type PackageLocale = z.infer<typeof PackageLocale>;

/** Translations stored in the agent row (`agents.translations`). Missing = only the manifest's English. */
export const AgentTranslations = z.object({ pt: PackageLocale.optional() }).strict();
export type AgentTranslations = z.infer<typeof AgentTranslations>;

/** Parses a language tag ("pt", "pt-BR", "pt_br", "EN-us"): returns the served language or undefined. */
export function parseCatalogLang(value: unknown): CatalogLang | undefined {
  if (typeof value !== "string") return undefined;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return (CATALOG_LANGS as readonly string[]).includes(primary) ? (primary as CatalogLang) : undefined;
}

/** Accept-Language header: the first served language in order of preference (q), else the default. */
export function langFromAcceptLanguage(header: string | undefined | null): CatalogLang {
  if (!header) return DEFAULT_CATALOG_LANG;
  const items = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((i) => i.tag !== "" && i.tag !== "*" && i.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const i of items) {
    const lang = parseCatalogLang(i.tag);
    if (lang) return lang;
  }
  return DEFAULT_CATALOG_LANG;
}

/** `?lang=` wins; a missing or unknown value falls back to Accept-Language; with neither, English. */
export function resolveCatalogLang(queryLang: unknown, acceptLanguage?: string | null): CatalogLang {
  return parseCatalogLang(queryLang) ?? langFromAcceptLanguage(acceptLanguage);
}

/** Catalog fields the translation overlays. */
export type CatalogTexts = {
  name: string;
  tagline: string;
  description: string;
  packageContents: string[];
  requirements: Requirement[];
};

/**
 * Overlays the translation on the manifest text (English). Rules: English, or no translation for the language, returns
 * `base` itself; name, tagline and description change when the translation has text; `packageContents` replaces the whole
 * list; each requirement changes only its `label`, and only when its `key` is in the translation (the others stay in
 * English); the rest of the object does not change.
 */
export function overlayCatalogTexts<T extends CatalogTexts>(base: T, translations: AgentTranslations | null | undefined, lang: CatalogLang): T {
  if (lang !== "pt") return base;
  const t = translations?.pt;
  if (!t) return base;
  const labels = new Map((t.requirements ?? []).map((r) => [r.key, r.label]));
  return {
    ...base,
    name: t.name || base.name,
    tagline: t.tagline || base.tagline,
    description: t.description || base.description,
    packageContents: t.packageContents.length > 0 ? [...t.packageContents] : base.packageContents,
    requirements: base.requirements.map((r) => {
      const label = r.key ? labels.get(r.key) : undefined;
      return label ? { ...r, label } : r;
    }),
  };
}

/** Creator bio in the requested language (the first translation that has `creatorBio`); without one, the original bio. */
export function creatorBioFor(bio: string, translationsOfCreatorAgents: (AgentTranslations | null | undefined)[], lang: CatalogLang): string {
  if (lang !== "pt") return bio;
  for (const t of translationsOfCreatorAgents) if (t?.pt?.creatorBio) return t.pt.creatorBio;
  return bio;
}
