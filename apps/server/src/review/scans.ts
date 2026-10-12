import { createHash } from "node:crypto";
import { chunkMarkdown } from "../knowledge/chunk.js";
import { todayInSaoPaulo } from "../knowledge/search-rules.js";
import { isIsoDate, parseFrontMatter } from "../runtime/validate/frontmatter.js";
import type { PackageInput } from "../runtime/validate/index.js";
import { hiddenCharsAll, injectionMatch, revealHiddenChars, sensitiveAsk, sensitiveQuestion, urlsIn } from "../runtime/validate/text-scans.js";
import { extOf, isTextPath, readText, reviewableEntries } from "./files.js";

// Automatic scans for the review screen (PACKAGE_SPEC.md 14.5, item 6). Simple heuristics that help the human reviewer
// look in the right place: they do NOT block anything and can be bypassed. Pure (no database, network or disk): the caller
// builds the PackageInput and, if it wants the duplicate check, passes the hashes of already published packages.
//
// Snippets (`snippet`) already come out as plain text: invisible characters become visible [U+XXXX], `<` and `>` become
// ‹ and › (no HTML survives) and the length is capped. Even so, the screen must display them escaped.

export type ScanSeverity = "info" | "warn" | "high";

export type ScanKind =
  | "hidden_unicode" // invisible, direction or Unicode "tag" character
  | "hidden_html" // hidden HTML/CSS, comment, script/iframe, dangerous link
  | "remote_image" // remote image in Markdown (may leak data when loaded)
  | "injection" // instruction injection pattern
  | "sensitive_ask" // asks for sensitive data (steps, manifest, calibration)
  | "url_list" // list of URLs in the file
  | "url_send" // URL that sends data
  | "duplicate_content" // chunks identical to those of an already published package
  | "search_phrase_off_topic" // searchPhrases unrelated to the content
  | "expired_knowledge"; // knowledge with an expired valid_until

export type ScanFinding = { kind: ScanKind; severity: ScanSeverity; path: string; snippet: string; detail: string };

export type ScanCounts = {
  total: number;
  high: number;
  warn: number;
  info: number;
  byKind: Partial<Record<ScanKind, number>>;
  /** Text files scanned. */
  files: number;
  knowledgeFiles: number;
  /** Knowledge chunks (same chunking as ingestion). */
  knowledgeChunks: number;
  /** Chunks from files with a `valid_until` before today. */
  expiredChunks: number;
  expiredFiles: number;
  /** Chunks identical (normalized) to already published chunks. */
  duplicateChunks: number;
  /** Findings of the same kind and file that exceeded the per-file cap and were left out of the list. */
  suppressed: number;
};

export type ScanReport = { findings: ScanFinding[]; counts: ScanCounts };

export type ScanContext = {
  /** Hashes (`chunkHashes`) of the knowledge chunks of already published packages. */
  publishedChunkHashes?: ReadonlySet<string>;
  /** "Today" for `valid_until` (default: now). */
  now?: Date;
};

/** Cap on findings of the same kind in the same file (the rest only count in `counts.suppressed`). */
const PER_KIND_PER_FILE = 10;
const SNIPPET_MAX = 160;
const URL_SNIPPET_MAX = 320;

// ---------------------------------------------------------------------------------------------------------------
// Text safe for display

/** Short snippet, in plain text: invisible characters revealed, no `<` or `>`, whitespace collapsed. */
export function safeSnippet(text: string, max = SNIPPET_MAX): string {
  const s = revealHiddenChars(text).replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Text window around a position, already made safe. */
function around(text: string, index: number, length = 0, radius = 50): string {
  return safeSnippet(text.slice(Math.max(0, index - radius), Math.min(text.length, index + length + radius)));
}

// ---------------------------------------------------------------------------------------------------------------
// Invisible and direction Unicode

const DIRECTION = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const TAG = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;

function hiddenUnicode(text: string): { severity: ScanSeverity; index: number; snippet: string; detail: string }[] {
  const hits = hiddenCharsAll(text);
  const out: { severity: ScanSeverity; index: number; snippet: string; detail: string }[] = [];
  let i = 0;
  while (i < hits.length) {
    // Groups neighboring characters into a single run (a hidden message becomes one finding, not 80).
    let j = i;
    let end = hits[i]!.index + (hits[i]!.cp > 0xffff ? 2 : 1);
    while (j + 1 < hits.length && hits[j + 1]!.index === end) {
      j += 1;
      end += hits[j]!.cp > 0xffff ? 2 : 1;
    }
    const run = hits.slice(i, j + 1);
    const first = run[0]!;
    let severity: ScanSeverity = "warn";
    if (run.some((h) => DIRECTION(h.cp) || TAG(h.cp))) severity = "high";
    else if (run.length === 1 && (first.cp === 0x200c || first.cp === 0x200d || (first.cp === 0xfeff && first.index === 0))) severity = "info";
    const tagText = run
      .filter((h) => TAG(h.cp) && h.cp >= 0xe0020 && h.cp <= 0xe007e)
      .map((h) => String.fromCharCode(h.cp - 0xe0000))
      .join("");
    const codes = [...new Set(run.map((h) => h.codePoint))].slice(0, 6).join(", ");
    out.push({
      severity,
      index: first.index,
      snippet: around(text, first.index, end - first.index),
      detail: `${run.length} invisible or direction character(s) (${codes})${tagText ? `; text hidden in Unicode tags: "${safeSnippet(tagText, 120)}"` : ""}`,
    });
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Hidden HTML and CSS

const HIDING_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|"|'|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|"|'|$)|(?:left|top|text-indent|margin-left)\s*:\s*-\d{3,}|color\s*:\s*(?:#fff(?:fff)?\b|white\b|transparent\b)|(?:width|height)\s*:\s*0(?:px)?\s*(?:;|"|'|$)/i;
const HIDDEN_ATTR = /\shidden(?:\s|=|\/?>|$)/i;
const DANGEROUS_TAG = /<\s*(script|iframe|object|embed|meta|base|link)\b/gi;
const STYLE_TAG = /<\s*style\b/gi;
const ANY_TAG = /<[a-z][a-z0-9]*\b[^>]{0,500}>/gi;
const MD_COMMENT = /^[ \t]*\[\/\/\]:\s*#\s*[("']/gm;
// Capped repetitions ({0,20}): `\s*=\s*["']?\s*` followed by a failure was quadratic (href= + 80 thousand spaces).
const BAD_LINK = /(?:\]\(|href\s{0,20}=\s{0,20}["']?)\s{0,20}(?:javascript|vbscript|data)\s{0,20}:/gi;
const REMOTE_IMAGE = /!\[[^\]\n]{0,200}\]\(\s*(https?:\/\/[^)\s]+)/gi;

type HtmlHit = { kind: "hidden_html" | "remote_image"; severity: ScanSeverity; index: number; length: number; detail: string };

function hiddenHtml(text: string): HtmlHit[] {
  const out: HtmlHit[] = [];
  // HTML comments: the human reader doesn't see them, the AI does (linear: no regex restarting the search at every "<!--").
  for (let from = 0; ; ) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    const end = close === -1 ? text.length : close + 3;
    const body = text.slice(open + 4, close === -1 ? text.length : close);
    const bad = injectionMatch(body) !== null;
    out.push({
      kind: "hidden_html",
      severity: bad || close === -1 ? "high" : body.trim() ? "warn" : "info",
      index: open,
      length: Math.min(end - open, 120),
      detail: close === -1 ? "HTML comment opened and never closed (hides the rest of the file)" : bad ? "HTML comment with an injection pattern" : "HTML comment (the AI reads it, the user does not see it)",
    });
    if (close === -1) break;
    from = end;
  }
  for (const [re, severity, detail] of [
    [DANGEROUS_TAG, "high", "Dangerous tag in content that should be text"],
    [STYLE_TAG, "warn", "<style> block in content that should be text"],
    [MD_COMMENT, "warn", "Hidden Markdown comment ([//]: #)"],
    [BAD_LINK, "high", "Link with javascript:, vbscript: or data:"],
  ] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ kind: "hidden_html", severity, index: m.index, length: m[0].length, detail });
  }
  ANY_TAG.lastIndex = 0;
  for (let m = ANY_TAG.exec(text); m; m = ANY_TAG.exec(text)) {
    if (HIDING_STYLE.test(m[0]) || HIDDEN_ATTR.test(m[0])) out.push({ kind: "hidden_html", severity: "high", index: m.index, length: m[0].length, detail: "HTML element hidden by CSS or the hidden attribute" });
  }
  REMOTE_IMAGE.lastIndex = 0;
  for (let m = REMOTE_IMAGE.exec(text); m; m = REMOTE_IMAGE.exec(text)) {
    out.push({ kind: "remote_image", severity: "warn", index: m.index, length: m[0].length, detail: `Remote image (${safeSnippet(m[1]!, 80)}): loading the image may send data to another server` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Collection

type Collector = {
  findings: ScanFinding[];
  suppressed: number;
  push: (f: ScanFinding) => void;
};

function collector(): Collector {
  const perKey = new Map<string, number>();
  const c: Collector = {
    findings: [],
    suppressed: 0,
    push(f) {
      const key = `${f.kind}\0${f.path}`;
      const n = perKey.get(key) ?? 0;
      perKey.set(key, n + 1);
      if (n >= PER_KIND_PER_FILE) c.suppressed += 1;
      else c.findings.push(f);
    },
  };
  return c;
}

type TextOpts = {
  /** Injection phrases (does not apply to evals, which the AI doesn't read). */
  injection: boolean;
  /** Requests for sensitive data (steps and manifest). */
  sensitive: boolean;
  /** Hidden HTML only makes sense in free text, not in loose manifest strings. */
  html: boolean;
};

function scanText(c: Collector, path: string, text: string, o: TextOpts): void {
  for (const h of hiddenUnicode(text)) c.push({ kind: "hidden_unicode", severity: h.severity, path, snippet: h.snippet, detail: h.detail });
  if (o.html) {
    for (const h of hiddenHtml(text)) c.push({ kind: h.kind, severity: h.severity, path, snippet: around(text, h.index, h.length, 10), detail: h.detail });
  }
  if (o.injection) {
    let found = false;
    for (const [i, line] of text.split("\n").entries()) {
      const m = injectionMatch(line);
      if (m) {
        found = true;
        c.push({ kind: "injection", severity: "high", path, snippet: safeSnippet(line), detail: `Injection pattern on line ${i + 1}: "${safeSnippet(m, 80)}"` });
      }
    }
    if (!found) {
      // Phrases split across two lines only show up in the whole text.
      const m = injectionMatch(text);
      if (m) c.push({ kind: "injection", severity: "high", path, snippet: safeSnippet(m), detail: "Injection pattern spanning a line break" });
    }
  }
  if (o.sensitive) {
    const ask = sensitiveAsk(text);
    if (ask) c.push({ kind: "sensitive_ask", severity: "warn", path, snippet: safeSnippet(ask), detail: "Tells the AI to ask the user for sensitive data" });
  }
}

/** One URL list per file (groups the manifest strings under manifest.json itself) + one finding per data-sending URL. */
function scanUrls(c: Collector, path: string, texts: string[]): void {
  const urls = new Map<string, boolean>();
  for (const t of texts) {
    for (const u of urlsIn(t)) urls.set(u.url, (urls.get(u.url) ?? false) || u.sending);
  }
  if (urls.size === 0) return;
  const hosts = new Set<string>();
  for (const u of urls.keys()) {
    try {
      hosts.add(new URL(u).hostname.toLowerCase());
    } catch {
      hosts.add("(invalid URL)");
    }
  }
  const insecure = [...urls.keys()].filter((u) => u.toLowerCase().startsWith("http://")).length;
  c.push({
    kind: "url_list",
    severity: "info",
    path,
    snippet: safeSnippet([...urls.keys()].join(" | "), URL_SNIPPET_MAX),
    detail: `${urls.size} URL(s) across ${hosts.size} host(s)${insecure ? `, ${insecure} without https` : ""}: ${safeSnippet([...hosts].join(", "), 200)}`,
  });
  for (const [u, sending] of urls) {
    if (sending) c.push({ kind: "url_send", severity: "warn", path, snippet: safeSnippet(u, URL_SNIPPET_MAX), detail: "Data-sending URL (sending verb on the same line or query parameters)" });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge: chunks, duplicates and expired content

/** Length (in hex) of the stored/compared chunk hash: 128 bits are enough and fit in small columns and sets. */
export const CHUNK_HASH_HEX_LEN = 32;
/** Chunks shorter than this (already normalized) are titles and loose phrases: they don't prove copying. */
const MIN_CHUNK_CHARS = 80;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const normalizeChunk = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

const isKnowledgeText = (p: string) => p.startsWith("knowledge/") && !p.endsWith(".meta.json") && (extOf(p) === ".md" || extOf(p) === ".txt");

/** Body of the knowledge file (without front-matter, which does not go into search), chunked as in ingestion. */
function knowledgeChunks(path: string, text: string): string[] {
  const body = extOf(path) === ".md" ? parseFrontMatter(text).body : text;
  return chunkMarkdown(body);
}

/** Hash of the normalized knowledge chunks (lowercase, no accents or punctuation), to store and compare across packages. */
export function chunkHashes(input: PackageInput): { path: string; index: number; hash: string }[] {
  const out: { path: string; index: number; hash: string }[] = [];
  for (const e of reviewableEntries(input)) {
    if (!isKnowledgeText(e.path)) continue;
    const text = readText(input, e.path);
    if (text === null) continue;
    for (const [index, chunk] of knowledgeChunks(e.path, text).entries()) {
      const norm = normalizeChunk(chunk);
      if (norm.length < MIN_CHUNK_CHARS) continue;
      out.push({ path: e.path, index, hash: createHash("sha256").update(norm).digest("hex").slice(0, CHUNK_HASH_HEX_LEN) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Off-topic searchPhrases

const STOPWORDS = new Set(
  (
    "para como com uma uns umas dos nos nas por que quero preciso precisa gostaria posso pode meu minha seu sua mais sem ser sobre entre quando onde qual quais quanto quantos quanta isso esse essa este esta " +
    "fazer faco faca ajuda ajudar uso usar the and for with from how what make need want help get can you your into"
  ).split(" "),
);

/** Crude stem (drops a trailing "s" and cuts at 5 letters): "receitas" and "receita" become the same. */
const stemOf = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w).slice(0, 5);

function contentWords(text: string): string[] {
  return (fold(text).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

function scanSearchPhrases(c: Collector, phrases: string[], corpusTexts: string[]): void {
  if (phrases.length === 0) return;
  const vocab = new Set<string>();
  for (const t of corpusTexts) for (const w of contentWords(t)) vocab.add(stemOf(w));
  for (const [i, phrase] of phrases.entries()) {
    const words = [...new Set(contentWords(phrase))];
    if (words.length === 0) continue;
    const missing = words.filter((w) => !vocab.has(stemOf(w)));
    const coverage = (words.length - missing.length) / words.length;
    if (coverage >= 0.5) continue;
    c.push({
      kind: "search_phrase_off_topic",
      severity: coverage === 0 ? "warn" : "info",
      path: `manifest.json#searchPhrases.${i}`,
      snippet: safeSnippet(phrase),
      detail: `${words.length - missing.length} of ${words.length} word(s) appear in the title, description, steps or knowledge; unrelated: ${safeSnippet(missing.join(", "), 120)}`,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

/** Every manifest string with its field path (`manifest.json#steps.0.gate.1`). */
function manifestStrings(raw: unknown): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 12) return;
    if (typeof node === "string") out.push({ path: `manifest.json#${path}`, text: node });
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i), depth + 1));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(raw, "", 0);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

/** Scans the whole package. Pure: no disk, database or network. */
export function scanPackage(input: PackageInput, ctx: ScanContext = {}): ScanReport {
  const now = ctx.now ?? new Date();
  const c = collector();
  const counts: ScanCounts = { total: 0, high: 0, warn: 0, info: 0, byKind: {}, files: 0, knowledgeFiles: 0, knowledgeChunks: 0, expiredChunks: 0, expiredFiles: 0, duplicateChunks: 0, suppressed: 0 };

  const corpus: string[] = [];
  let phrases: string[] = [];

  for (const e of reviewableEntries(input)) {
    if (!isTextPath(e.path)) continue;
    const text = readText(input, e.path);
    if (text === null) continue;
    counts.files += 1;

    if (e.path === "manifest.json") {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        // Broken JSON: the validator already rejects it; still scan the raw text for hidden characters.
        scanText(c, e.path, text, { injection: true, sensitive: false, html: false });
        continue;
      }
      const strings = manifestStrings(raw);
      for (const s of strings) scanText(c, s.path, s.text, { injection: true, sensitive: true, html: true });
      scanUrls(c, e.path, strings.map((s) => s.text));
      for (const f of sensitiveOnboarding(raw)) c.push(f);
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj?.searchPhrases)) phrases = (obj.searchPhrases as unknown[]).filter((p): p is string => typeof p === "string");
      for (const k of ["name", "tagline", "description"] as const) if (typeof obj?.[k] === "string") corpus.push(obj[k] as string);
      if (Array.isArray(obj?.packageContents)) corpus.push(...(obj.packageContents as unknown[]).filter((p): p is string => typeof p === "string"));
      continue;
    }

    const isStep = e.path.startsWith("steps/");
    const isEval = e.path.startsWith("evals/");
    scanText(c, e.path, text, { injection: !isEval, sensitive: isStep, html: extOf(e.path) !== ".json" || e.path.startsWith("knowledge/") });
    scanUrls(c, e.path, [text]);

    if (isStep || e.path.startsWith("templates/")) corpus.push(text);

    if (isKnowledgeText(e.path)) {
      counts.knowledgeFiles += 1;
      let body = text;
      if (extOf(e.path) === ".md") {
        const fm = parseFrontMatter(text);
        body = fm.body;
        if (fm.kind === "ok") {
          // The front-matter title and tags also describe the subject.
          for (const k of ["title", "tags"] as const) {
            const v = fm.data[k];
            if (v !== undefined) corpus.push(Array.isArray(v) ? v.join(" ") : v);
          }
          const vu = fm.data.valid_until;
          const expired = typeof vu === "string" && isIsoDate(vu) && vu < todayInSaoPaulo(now);
          if (expired) {
            const n = chunkMarkdown(body).length;
            counts.expiredFiles += 1;
            counts.expiredChunks += n;
            c.push({ kind: "expired_knowledge", severity: "warn", path: e.path, snippet: `valid_until: ${vu}`, detail: `Content expired on ${vu}: ${n} chunk(s) still enter search` });
          }
        }
      }
      corpus.push(body);
      const chunks = chunkMarkdown(body);
      counts.knowledgeChunks += chunks.length;

      const published = ctx.publishedChunkHashes;
      if (published && published.size > 0) {
        let dup = 0;
        let sample = "";
        for (const chunk of chunks) {
          const norm = normalizeChunk(chunk);
          if (norm.length < MIN_CHUNK_CHARS) continue;
          if (published.has(createHash("sha256").update(norm).digest("hex").slice(0, CHUNK_HASH_HEX_LEN))) {
            dup += 1;
            if (!sample) sample = chunk;
          }
        }
        if (dup > 0) {
          counts.duplicateChunks += dup;
          c.push({
            kind: "duplicate_content",
            severity: dup / Math.max(chunks.length, 1) >= 0.5 ? "high" : "warn",
            path: e.path,
            snippet: safeSnippet(sample),
            detail: `${dup} of ${chunks.length} chunk(s) are identical (normalized) to content of an already published package`,
          });
        }
      }
    }
  }

  scanSearchPhrases(c, phrases, corpus);

  const order: Record<ScanSeverity, number> = { high: 0, warn: 1, info: 2 };
  const findings = c.findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of findings) {
    counts.total += 1;
    counts[f.severity] += 1;
    counts.byKind[f.kind] = (counts.byKind[f.kind] ?? 0) + 1;
  }
  counts.suppressed = c.suppressed;
  return { findings, counts };
}

/** Calibration questions that seem to ask for sensitive data (same rule as the validator's ONBOARDING_SENSITIVE warning). */
export function sensitiveOnboarding(manifest: unknown): ScanFinding[] {
  const out: ScanFinding[] = [];
  const questions = (manifest as { onboarding?: { questions?: { ask?: unknown; why?: unknown; options?: unknown }[] } } | null)?.onboarding?.questions;
  if (!Array.isArray(questions)) return out;
  for (const [i, q] of questions.entries()) {
    const text = [q?.ask, q?.why, ...(Array.isArray(q?.options) ? q.options : [])].filter((x): x is string => typeof x === "string").join(" ");
    if (sensitiveQuestion(text)) out.push({ kind: "sensitive_ask", severity: "warn", path: `manifest.json#onboarding.questions.${i}`, snippet: safeSnippet(text), detail: "The calibration question seems to ask for sensitive data" });
  }
  return out;
}
