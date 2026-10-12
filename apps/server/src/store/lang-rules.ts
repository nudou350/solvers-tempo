import { resolveCatalogLang, type CatalogLang } from "@solvers/shared";

// Language of the catalog texts of a request (no express/database: tested in test/catalog-lang.test.ts).
// `?lang=pt|en` wins; without it the Accept-Language counts; with neither, English (the manifest's).

type ReqLike = { query?: Record<string, unknown>; headers?: Record<string, string | string[] | undefined> };
/** Express response: the answer depends on Accept-Language, so caches are told with `Vary`. */
type ResLike = { vary(field: string): unknown };

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

export function catalogLangOf(req: ReqLike, res?: ResLike): CatalogLang {
  res?.vary("Accept-Language");
  const accept = first(req.headers?.["accept-language"]);
  return resolveCatalogLang(first(req.query?.lang), typeof accept === "string" ? accept : undefined);
}
