// Pure search_knowledge rules (PACKAGE_SPEC.md 6.3 and 6.5): chunk text with source, date and expiry
// warning, daily quota and the free trial of v1 packages. No env or DB: test/knowledge-search.test.ts.

export type HitView = {
  /** File path inside the package (knowledge/x.md). */
  source: string;
  content: string;
  /** The file's front matter; null in v0 packages. */
  meta: Record<string, unknown> | null;
  /** YYYY-MM-DD or null. */
  validUntil: string | null;
};

/** YYYY-MM-DD date as it appears in the text for the AI ("" if it is not a date). */
export function dateText(iso: string | null | undefined): string {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

const SP_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today (YYYY-MM-DD) in the Brasília time zone: the `valid_until` date is the author's, not UTC's (at 9 pm it would already be "tomorrow"). */
export function todayInSaoPaulo(now: Date): string {
  return SP_DATE.format(now);
}

/** Is the chunk past its expiry? The `valid_until` day itself still counts (Brasília time zone); only the next day is "out of date". */
export function isStale(validUntil: string | null, now: Date): boolean {
  if (!validUntil) return false;
  return validUntil < todayInSaoPaulo(now);
}

const metaStr = (meta: HitView["meta"], k: string): string => (typeof meta?.[k] === "string" ? (meta[k] as string) : "");

/** One chunk for the AI: title, source, date and, if expired, the warning. No metadata (v0 package): old header. */
export function hitText(h: HitView, index: number, now: Date): string {
  const source = metaStr(h.meta, "source");
  const title = metaStr(h.meta, "title");
  if (!h.meta || (!source && !title && !h.validUntil)) return `### Excerpt ${index} (${h.source})\n${h.content}`;
  const head = `### Excerpt ${index}: ${title || h.source}`;
  const url = metaStr(h.meta, "source_url");
  const date = dateText(metaStr(h.meta, "source_date"));
  const fonte = `Source: ${source || h.source}${url ? ` (${url})` : ""}${date ? ` · source date: ${date}` : ""}`;
  const stale = isStale(h.validUntil, now) ? `\nWarning: may be out of date (valid until ${dateText(h.validUntil)}).` : "";
  return `${head}\n${fonte}${stale}\n${h.content}`;
}

/** search_knowledge response: chunks, an instruction to cite the source (when there is one) and the watermark. */
export function hitsText(hits: HitView[], now: Date, watermark: string): string {
  const body = hits.map((h, i) => hitText(h, i + 1, now)).join("\n\n");
  const cited = hits.some((h) => metaStr(h.meta, "source"));
  const stale = hits.some((h) => isStale(h.validUntil, now));
  const notes: string[] = [];
  if (cited) notes.push("Cite the source of each excerpt you use in your answer.");
  if (stale) notes.push("Excerpts with an out-of-date warning: tell the user the information may have changed and suggest confirming it at the source.");
  return `${body}${notes.length ? `\n\n${notes.join(" ")}` : ""}\n\n${watermark}`;
}

/** In the free trial of a v1 package, only files with `trial: true` in the front matter; a v0 package keeps the whole base. */
export function trialFilesOnly(i: { specVersion?: number; accessIsTrial: boolean }): boolean {
  return i.accessIsTrial && i.specVersion === 1;
}

export const TRIAL_NO_FILES_TEXT =
  "Nothing relevant in the part of the knowledge base unlocked in the free trial. The specialist's full knowledge base comes with the license.";

// ----- Daily quota -----

/** Quota window: the last 24 hours (so midnight is not a loophole for doubling usage). */
export const QUOTA_WINDOW_MS = 24 * 3600 * 1000;

/** Response once over the quota. Always the same text: the count ignores these responses (they don't extend the block). */
export const quotaText = (quota: number): string =>
  `Daily limit reached: this specialist allows ${quota} knowledge base searches per day. Continue with what you already looked up and try again tomorrow.`;

/** `quota` 0 turns the quota off; `used` is what the wallet has already queried in the window. */
export const quotaExceeded = (used: number, quota: number): boolean => quota > 0 && used >= quota;
