import { z } from "zod";
import { badRequest } from "../lib/http.js";

// Pure functions of the server tools (no env, DB or Docker): they can be imported
// by the tests and the verifier without side effects. The executors live in tools.ts.

// ---------------------------------------------------------------------------------------------
// File input: accepts { files: { "A.tsx": "..." } } or { files: [{ path, content }] }
// ---------------------------------------------------------------------------------------------

const MAX_FILES = 40;
/** Same cap as the sandbox (verifier/sandbox.ts): applies to both formats. */
const MAX_TOTAL_BYTES = 300_000;

/** Relative path without "..": a leading slash, drive letter or leading "\\" is rejected. */
function badPath(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (!p.trim()) return "empty path";
  if (p.startsWith("/") || /^[a-z]:/i.test(p)) return "absolute paths are not allowed";
  if (p.split("/").some((seg) => seg === "..")) return 'paths with ".." are not allowed';
  return null;
}

const FileEntry = z.object({ path: z.string().min(1).max(200), content: z.string() });

export const FilesInput = z
  .object({
    files: z.union([z.array(FileEntry).min(1).max(MAX_FILES), z.record(z.string())], {
      errorMap: () => ({ message: 'use files: [{ path, content }] or files: { "Name.tsx": "content" }' }),
    }),
  })
  .transform(({ files }, ctx) => {
    const entries = Array.isArray(files) ? files.map((f) => [f.path, f.content] as const) : Object.entries(files);
    const out: Record<string, string> = {};
    if (entries.length > MAX_FILES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: `at most ${MAX_FILES} files` });
      return out;
    }
    entries.forEach(([path, content], i) => {
      const err = badPath(path);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", i], message: `${path}: ${err}` });
      else if (path in out) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", i], message: `${path}: duplicate file` });
      else out[path] = content;
    });
    if (entries.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "send at least one file" });
    const bytes = entries.reduce((a, [path, content]) => a + Buffer.byteLength(path) + Buffer.byteLength(content), 0);
    if (bytes > MAX_TOTAL_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "files too large (max. 300 KB in total)" });
    return out;
  });

/** Normalizes both files formats to Record<path, content>. */
export function normalizeFiles(input: unknown): Record<string, string> {
  return FilesInput.parse(input);
}

// ---------------------------------------------------------------------------------------------
// Contrast (WCAG 2.x)
// ---------------------------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

/** Accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb() and rgba() (commas or spaces, alpha in 0..1 or %). */
export function parseColor(input: string): Rgba {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? hex.split("").map((c) => c + c).join("") : hex;
    const [r, g, b, a] = [0, 2, 4, 6].map((i) => (i < full.length ? parseInt(full.slice(i, i + 2), 16) : 255));
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(s)?.[1];
  if (fn) {
    const parts = fn.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const chan = (v: string) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
      const [r, g, b] = parts.slice(0, 3).map(chan);
      const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      const ok = [r, g, b].every((c) => Number.isFinite(c) && c! >= 0 && c! <= 255) && Number.isFinite(a) && a >= 0 && a <= 1;
      if (ok) return { r: r!, g: g!, b: b!, a };
    }
  }
  throw badRequest(`Invalid color: ${input} (use #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb() or rgba())`);
}

const luminance = ({ r, g, b }: Rgba) => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};

/** fg with alpha composited over an opaque bg. */
const composite = (fg: Rgba, bg: Rgba): Rgba => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

const toHex = ({ r, g, b }: Rgba) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** Exact ratio (unrounded), to compare against the thresholds without "rounding up". */
function exactRatio(fgRaw: string, bgRaw: string) {
  const bg = parseColor(bgRaw);
  if (bg.a < 1) throw badRequest(`Background with transparency (${bgRaw}): provide the resulting opaque background color`);
  const fgParsed = parseColor(fgRaw);
  const fg = fgParsed.a < 1 ? composite(fgParsed, bg) : fgParsed;
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return { ratio: (hi! + 0.05) / (lo! + 0.05), composited: fgParsed.a < 1 ? toHex(fg) : null };
}

/** WCAG 2.x contrast ratio between two colors (fg may have alpha; bg must be opaque). */
export function contrastRatio(fg: string, bg: string): number {
  return Math.round(exactRatio(fg, bg).ratio * 100) / 100;
}

const ContrastKind = z.enum(["texto", "texto-grande", "ui"]);
const ContrastPair = z.object({
  fg: z.string().min(1).max(60),
  bg: z.string().min(1).max(60),
  use: z.string().max(120).optional(),
  kind: ContrastKind.optional(),
  large: z.boolean().optional(),
});
export const ContrastInput = z.object({ pairs: z.array(z.unknown()).min(1).max(50) });

const MIN = { texto: 4.5, "texto-grande": 3, ui: 3 } as const;

/** An invalid pair becomes { ..., error } without failing the others. */
export function contrastCheck(input: unknown) {
  const { pairs } = ContrastInput.parse(input);
  return pairs.map((raw) => {
    const parsed = ContrastPair.safeParse(raw);
    const echo = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (!parsed.success) {
      return { fg: echo.fg, bg: echo.bg, use: echo.use, error: parsed.error.issues.map((i) => `${i.path.join(".") || "pair"}: ${i.message}`).join("; ") };
    }
    const p = parsed.data;
    const kind = p.kind ?? (p.large ? "texto-grande" : "texto");
    try {
      const { ratio, composited } = exactRatio(p.fg, p.bg);
      return {
        fg: p.fg,
        bg: p.bg,
        use: p.use,
        kind,
        ratio: Math.round(ratio * 100) / 100,
        ...(composited ? { fgComposited: composited } : {}),
        pass: ratio >= MIN[kind],
        aa: { texto: ratio >= 4.5, textoGrande: ratio >= 3, ui: ratio >= 3 },
        aaa: { texto: ratio >= 7, textoGrande: ratio >= 4.5 },
      };
    } catch (e) {
      return { fg: p.fg, bg: p.bg, use: p.use, kind, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Static accessibility (JSX/HTML): a linear tokenizer that respects {} and quotes
// ---------------------------------------------------------------------------------------------

type Attr = { name: string; value: string | null };
export type Tag = { name: string; start: number; end: number; attrs: Attr[]; spread: boolean; selfClosing: boolean };
type Close = { name: string; start: number; end: number };
type Token = ({ kind: "open" } & Tag) | ({ kind: "close" } & Close);

/** Index of the closing quote of "..." or '...' starting at i (no recursion). */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j;
  }
  return src.length;
}

/**
 * Skips a balanced {...} expression starting at i, with nested strings, comments and template literals.
 * Iterative (explicit stack): deep `${`${...}`}` does not overflow the call stack.
 */
function skipBraces(src: string, i: number): number {
  const stack: ("{" | "`")[] = [];
  for (; i < src.length; i++) {
    const c = src[i];
    if (stack[stack.length - 1] === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") {
        stack.push("{");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") i = skipQuoted(src, i);
    else if (c === "`") stack.push("`");
    else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? src.length : close + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl < 0 ? src.length : nl;
    } else if (c === "{") stack.push("{");
    else if (c === "}") {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return src.length;
}

const TAG_NAME = /[A-Za-z][\w.:-]*/y;
const ATTR_NAME = /[^\s=/>{]+/y;
const BARE_VALUE = /[^\s>]+/y;
const CLOSE_TAG = /<\/([A-Za-z][\w.:-]*)\s*>/y;
const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

function sticky(re: RegExp, src: string, i: number): string | null {
  re.lastIndex = i;
  return re.exec(src)?.[0] ?? null;
}

/**
 * Reads the opening tag starting at "<" (position i). Returns the tag or, if it is not a readable tag,
 * how far it read (`stop`), so the caller continues from there without rescanning.
 */
export function readTag(src: string, i: number): { tag: Tag | null; stop: number } {
  const name = sticky(TAG_NAME, src, i + 1);
  if (!name) return { tag: null, stop: i + 1 };
  const tag: Tag = { name, start: i, end: -1, attrs: [], spread: false, selfClosing: false };
  let j = i + 1 + name.length;
  while (j < src.length) {
    const c = src[j]!;
    if (isSpace(c)) {
      j++;
    } else if (c === ">") {
      tag.end = j + 1;
      return { tag, stop: tag.end };
    } else if (c === "/" && src[j + 1] === ">") {
      tag.selfClosing = true;
      tag.end = j + 2;
      return { tag, stop: tag.end };
    } else if (c === "{") {
      // {...props} or a {/* */} comment
      let k = j + 1;
      while (isSpace(src[k])) k++;
      if (src.startsWith("...", k)) tag.spread = true;
      j = skipBraces(src, j);
    } else {
      const attrName = sticky(ATTR_NAME, src, j);
      if (!attrName) return { tag: null, stop: j + 1 };
      j += attrName.length;
      while (isSpace(src[j])) j++;
      let value: string | null = null;
      if (src[j] === "=") {
        j++;
        while (isSpace(src[j])) j++;
        if (src[j] === '"' || src[j] === "'") {
          const close = skipQuoted(src, j);
          value = src.slice(j, close + 1);
          j = close + 1;
        } else if (src[j] === "{") {
          const close = skipBraces(src, j);
          value = src.slice(j, close);
          j = close;
        } else {
          value = sticky(BARE_VALUE, src, j) ?? "";
          j += value.length;
        }
      }
      tag.attrs.push({ name: attrName, value });
    }
  }
  return { tag: null, stop: src.length };
}

/**
 * Tokenizes the file in one pass (opening and closing tags, in order) and pairs openings with
 * closings using a per-name stack. pair[k] = index of the matching token (or -1).
 */
export function tokenize(src: string): { tokens: Token[]; pair: number[] } {
  const tokens: Token[] = [];
  let i = src.indexOf("<");
  while (i >= 0 && i < src.length) {
    if (src[i + 1] === "/") {
      CLOSE_TAG.lastIndex = i;
      const m = CLOSE_TAG.exec(src);
      if (m) {
        tokens.push({ kind: "close", name: m[1]!, start: i, end: i + m[0].length });
        i = src.indexOf("<", i + m[0].length);
      } else i = src.indexOf("<", i + 2);
      continue;
    }
    const { tag, stop } = readTag(src, i);
    if (tag) tokens.push({ kind: "open", ...tag });
    i = src.indexOf("<", Math.max(stop, i + 1));
  }
  const pair = new Array<number>(tokens.length).fill(-1);
  const open = new Map<string, number[]>();
  tokens.forEach((t, k) => {
    if (t.kind === "open") {
      if (t.selfClosing) return;
      const s = open.get(t.name) ?? [];
      s.push(k);
      open.set(t.name, s);
    } else {
      const k0 = open.get(t.name)?.pop();
      if (k0 !== undefined) {
        pair[k0] = k;
        pair[k] = k0;
      }
    }
  });
  return { tokens, pair };
}

/** All opening tags with the given name (case-sensitive: <Button> is not <button>). */
export function scanTags(src: string, name: string): Tag[] {
  return tokenize(src).tokens.filter((t): t is { kind: "open" } & Tag => t.kind === "open" && t.name === name);
}

const attr = (t: Tag, ...names: string[]) => t.attrs.find((a) => names.some((n) => n.toLowerCase() === a.name.toLowerCase()));

/** Literal attribute value ("x", 'x', {"x"}, {'x'}); expressions come back as raw text. No regex (avoids ReDoS). */
function attrValue(a: Attr | undefined): string | null {
  if (!a || a.value == null) return a ? "" : null;
  let v = a.value.trim();
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1).trim();
  const q = v[0];
  if (v.length >= 2 && (q === '"' || q === "'" || q === "`") && v[v.length - 1] === q) return v.slice(1, -1);
  return v;
}

/** Attribute present and not explicitly empty/false. */
function truthy(t: Tag, ...names: string[]): boolean {
  const a = attr(t, ...names);
  if (!a) return false;
  if (a.value == null) return true;
  const v = attrValue(a);
  return v !== "" && v !== "false";
}

/** Is there visible text in the segment between tags? Ignores whitespace and JSX comments. */
function hasText(gap: string): boolean {
  for (let i = 0; i < gap.length; i++) {
    const c = gap[i];
    if (isSpace(c)) continue;
    if (c === "{" && gap.startsWith("/*", i + 1)) {
      const close = gap.indexOf("*/", i + 3);
      const end = close < 0 ? -1 : gap.indexOf("}", close + 2);
      if (end < 0) return true;
      i = end;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Does the button content (tokens from..to, exclusive) give it an accessible name? Text and {expressions} count;
 * aria-hidden elements do not; <svg> only counts with aria-label/title/<title>; <img> only with a non-empty alt;
 * self-closing *Icon components do not count. Skips whole subtrees: each token is seen once.
 */
function contentHasName(src: string, tokens: Token[], pair: number[], from: number, to: number, textEnd: number): boolean {
  let cursor = tokens[from - 1]!.end;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (hasText(src.slice(cursor, t.start))) return true;
    cursor = t.end;
    if (t.kind === "close") continue;
    const closeK = t.selfClosing ? k : pair[k]!;
    const skip = () => {
      if (closeK > k && closeK < to) {
        cursor = tokens[closeK]!.end;
        k = closeK;
      }
    };
    if (truthy(t, "aria-hidden")) {
      skip();
      continue;
    }
    if (t.name === "svg") {
      if (truthy(t, "aria-label", "aria-labelledby", "title")) return true;
      // Only looks for <title> in an svg closed inside the button (otherwise each token would be revisited).
      if (closeK > k && closeK < to) for (let s = k + 1; s < closeK; s++) {
        const inner = tokens[s]!;
        if (inner.kind === "open" && inner.name === "title" && pair[s]! > s && hasText(src.slice(inner.end, tokens[pair[s]!]!.start))) return true;
      }
      skip();
      continue;
    }
    if (/icon/i.test(t.name) && t.selfClosing) continue;
    if (t.name === "img") {
      if (truthy(t, "alt", "aria-label")) return true;
      continue;
    }
    // Component without children (e.g. <Trans id="..." />): no way to know, assume it has text.
    if (t.selfClosing && /^[A-Z]/.test(t.name)) return true;
    if (truthy(t, "aria-label")) return true;
  }
  return hasText(src.slice(cursor, textEnd));
}

export type A11yIssue = { file: string; rule: string; severity: "error" | "warning"; message: string; snippet: string };

const SKIP_INPUT_TYPES = /^(hidden|submit|button|reset|image)$/i;

/**
 * Static accessibility check of JSX/HTML code (does not render): field labels, button
 * names, images without alt, clickable div/span, positive tabIndex and outline removal.
 * issues = errors (they block the guarantee); warnings = warnings. passed = no errors.
 * Linear in input size: one tokenization per file and one pass over the tokens.
 */
export function a11yCheck(files: Record<string, string>) {
  const all: A11yIssue[] = [];
  const push = (file: string, rule: string, severity: A11yIssue["severity"], message: string, snippet: string) =>
    all.push({ file, rule, severity, message, snippet: snippet.slice(0, 200).replace(/\s+/g, " ").slice(0, 120) });

  for (const [file, src] of Object.entries(files)) {
    if (/\.css$/i.test(file)) {
      checkOutline(file, src, push);
      continue;
    }
    const { tokens, pair } = tokenize(src);
    const text = (t: Tag) => src.slice(t.start, t.end);

    // htmlFor/for of every label (literal value or raw expression).
    const forValues = new Set<string>();
    for (const t of tokens) {
      if (t.kind === "open" && (t.name === "label" || t.name === "Label")) {
        const v = attrValue(attr(t, "htmlFor", "for"));
        if (v) forValues.add(v);
      }
    }

    // One pass in order, with a stack of open <label>s (that have a closing tag) to know whether the field is inside one.
    const labelEnds: number[] = [];
    let buttonEnd = -1;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      while (labelEnds.length && labelEnds[labelEnds.length - 1]! <= t.start) labelEnds.pop();
      if (t.kind === "close") continue;
      const closeTok = pair[k]! > k ? tokens[pair[k]!]! : null;

      switch (t.name) {
        case "label":
          if (closeTok) labelEnds.push(closeTok.end);
          break;
        case "img":
          if (!t.spread && !attr(t, "alt")) push(file, "img-alt", "error", 'Image without an alt attribute (use alt="" if it is decorative)', text(t));
          break;
        case "button": {
          // A button inside a button is invalid: only the outer one is evaluated (keeps the pass linear).
          if (t.start < buttonEnd || t.spread || truthy(t, "aria-label", "aria-labelledby", "title")) break;
          if (t.selfClosing) {
            push(file, "button-name", "error", "Button without accessible text (icon without aria-label, aria-labelledby or title)", text(t));
            break;
          }
          if (!closeTok) break;
          buttonEnd = closeTok.end;
          if (!contentHasName(src, tokens, pair, k + 1, pair[k]!, closeTok.start)) {
            push(file, "button-name", "error", "Button without accessible text (icon without aria-label, aria-labelledby or title)", src.slice(t.start, Math.min(closeTok.end, t.start + 200)));
          }
          break;
        }
        case "input":
        case "select":
        case "textarea": {
          if (t.spread) break;
          if (t.name === "input" && SKIP_INPUT_TYPES.test(attrValue(attr(t, "type")) ?? "")) break;
          if (truthy(t, "aria-label", "aria-labelledby", "title")) break;
          const id = attrValue(attr(t, "id"));
          if (id && forValues.has(id)) break;
          if (labelEnds.length > 0) break;
          push(file, "label", "error", "Field without an associated label (label htmlFor, a label wrapping the field, or aria-label)", text(t));
          break;
        }
        case "div":
        case "span":
          if (attr(t, "onClick") && (!attr(t, "role") || !attr(t, "tabIndex", "tabindex"))) {
            push(file, "interactive-div", "error", `Clickable ${t.name} without role and tabIndex; prefer <button>`, text(t));
          }
          break;
      }
    }

    for (const m of src.matchAll(/tabIndex=\{?\s*["']?([1-9]\d*)/gi)) push(file, "tabindex", "error", "A positive tabIndex breaks the focus order", m[0]);
    checkOutline(file, src, push);
  }
  const issues = all.filter((i) => i.severity === "error");
  const warnings = all.filter((i) => i.severity === "warning");
  return { passed: issues.length === 0, issues, warnings, checked: Object.keys(files).length };
}

/**
 * outline:none / outline:0 with the value ending there (; , } quotes, !important or end of line; "0.5px"
 * does not count) and Tailwind's outline-none class. Becomes a warning if the same file defines :focus-visible.
 */
const OUTLINE_OFF = /outline\s*:\s*["']?(?:none|0)(?=["']?[ \t]*(?:[;,}]|!important|$))|(?<![\w:-])outline-none\b/gm;

function checkOutline(file: string, src: string, push: (f: string, r: string, s: A11yIssue["severity"], m: string, sn: string) => void) {
  const hasFocusVisible = /focus-visible/.test(src);
  for (const m of src.matchAll(OUTLINE_OFF)) {
    if (hasFocusVisible) push(file, "focus-visible", "warning", "Outline removed; check whether the file's :focus-visible covers this element", m[0]);
    else push(file, "focus-visible", "error", "Outline removed without a visible focus alternative (:focus-visible)", m[0]);
  }
}

// ---------------------------------------------------------------------------------------------
// Travel budget split (agents/planejador-viagens, step 3)
// ---------------------------------------------------------------------------------------------

export const BUDGET_CATEGORIES = ["aereo", "hospedagem", "alimentacao", "passeios", "transporteLocal", "seguro", "reserva"] as const;
type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
type PaidCategory = Exclude<BudgetCategory, "reserva">;
const PAID_CATEGORIES = BUDGET_CATEGORIES.filter((c): c is PaidCategory => c !== "reserva");

const Profile = z.enum(["economico", "moderado", "conforto", "luxo"]);
type Profile = z.infer<typeof Profile>;
type Split = Record<PaidCategory, number>;

/** Proportions (%) without the reserve, adding up to 90, within the step 3 ranges. */
const SPLITS: Record<"internacional" | "nacional", Record<Profile, Split>> = {
  internacional: {
    economico: { aereo: 39, hospedagem: 25, alimentacao: 12, passeios: 8, transporteLocal: 4, seguro: 2 },
    moderado: { aereo: 36, hospedagem: 27, alimentacao: 13, passeios: 8, transporteLocal: 4, seguro: 2 },
    // Same example as the planner's step 3 (R$ 45,000, 15 days, 3 people: local daily spend R$ 260).
    conforto: { aereo: 34, hospedagem: 28, alimentacao: 14, passeios: 8, transporteLocal: 4, seguro: 2 },
    luxo: { aereo: 30, hospedagem: 30, alimentacao: 13, passeios: 9, transporteLocal: 5, seguro: 3 },
  },
  nacional: {
    economico: { aereo: 30, hospedagem: 30, alimentacao: 15, passeios: 10, transporteLocal: 5, seguro: 0 },
    moderado: { aereo: 27, hospedagem: 31, alimentacao: 16, passeios: 10, transporteLocal: 6, seguro: 0 },
    conforto: { aereo: 24, hospedagem: 33, alimentacao: 16, passeios: 11, transporteLocal: 6, seguro: 0 },
    luxo: { aereo: 20, hospedagem: 36, alimentacao: 16, passeios: 12, transporteLocal: 6, seguro: 0 },
  },
};

const LABEL: Record<BudgetCategory, string> = {
  aereo: "flights",
  hospedagem: "lodging",
  alimentacao: "food",
  passeios: "activities",
  transporteLocal: "local transport",
  seguro: "insurance",
  reserva: "reserve",
};

/** Minimum plausible local daily spend per person (BRL). */
const MIN_DAILY_BRL = { internacional: 150, nacional: 80 };

const toCents = (n: number) => Math.round(n * 100);

export const BudgetInput = z
  .object({
    total: z.number().positive().max(1e12),
    currency: z.string().min(1).max(10).default("BRL"),
    days: z.number().int().positive().max(365),
    travelers: z.number().int().positive().max(50).default(1),
    profile: Profile.optional(),
    /** Old key, kept for compatibility. */
    style: Profile.optional(),
    destinationType: z.enum(["nacional", "internacional"]).default("internacional"),
    alreadyPaid: z.record(z.enum(PAID_CATEGORIES as [PaidCategory, ...PaidCategory[]]), z.number().nonnegative().max(1e12)).optional(),
    emergencyReservePct: z.number().min(0).max(50).optional(),
  })
  // Comparisons in whole cents, as in the calculation.
  .refine((v) => toCents(v.total) >= 1, { message: "total must be at least 0.01", path: ["total"] })
  .refine((v) => Object.values(v.alreadyPaid ?? {}).reduce((a, b) => a + toCents(b ?? 0), 0) <= toCents(v.total), {
    message: "the sum of alreadyPaid exceeds the total",
    path: ["alreadyPaid"],
  });

/** Splits `cents` among the keys by weight (largest remainders), with an exact sum. */
function splitCents<K extends string>(cents: number, weights: Record<K, number>): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const live = keys.filter((k) => weights[k] > 0);
  const sum = live.reduce((a, k) => a + weights[k], 0);
  if (sum <= 0 || cents <= 0) return out;
  const raw = live.map((k) => ({ k, v: (cents * weights[k]) / sum }));
  let left = cents;
  for (const r of raw) left -= out[r.k] = Math.floor(r.v);
  raw.sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)));
  for (let i = 0; left > 0; i = (i + 1) % raw.length, left--) out[raw[i]!.k]++;
  return out;
}

const brl = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Splits the budget by category. Amounts already paid (alreadyPaid) stay fixed in their category and are removed from
 * the total to distribute; the reserve is a % of the total (minimum 10). Everything in cents: the sum matches the total.
 */
export function budgetSplit(input: unknown) {
  const v = BudgetInput.parse(input);
  const profile: Profile = v.profile ?? v.style ?? "moderado";
  const alerts: string[] = [];
  const money = (n: number) => `${v.currency === "BRL" ? "R$ " : `${v.currency} `}${brl(n)}`;

  let reservePct = v.emergencyReservePct ?? 10;
  if (reservePct < 10) {
    alerts.push(`Emergency reserve raised from ${reservePct}% to the 10% minimum.`);
    reservePct = 10;
  }

  const totalCents = toCents(v.total);
  const base = SPLITS[v.destinationType][profile];
  // Ideal proportions over the total (the categories take 100 - reserve).
  const scale = (100 - reservePct) / 90;
  const idealPct = Object.fromEntries(PAID_CATEGORIES.map((c) => [c, base[c] * scale])) as Split;

  const paid = Object.fromEntries(
    Object.entries(v.alreadyPaid ?? {}).filter(([, n]) => (n ?? 0) > 0).map(([c, n]) => [c, toCents(n!)]).filter(([, n]) => (n as number) > 0),
  ) as Partial<Record<PaidCategory, number>>;
  const paidCents = Object.values(paid).reduce((a, b) => a + b!, 0);

  let reserveCents = Math.round((totalCents * reservePct) / 100);
  let freeCents = totalCents - reserveCents - paidCents;
  if (freeCents < 0) {
    reserveCents = Math.max(0, reserveCents + freeCents);
    freeCents = 0;
    alerts.push(`The amounts already paid leave no room for the full ${reservePct}% reserve: the budget doesn't add up.`);
  }

  const openWeights = Object.fromEntries(PAID_CATEGORIES.filter((c) => paid[c] == null).map((c) => [c, idealPct[c]])) as Record<string, number>;
  const open = splitCents(freeCents, openWeights);
  const openSum = Object.values(open).reduce((a, b) => a + b, 0);
  if (openSum < freeCents) {
    // No open category with weight (all paid, or only insurance left on a domestic trip).
    const leftover = money((freeCents - openSum) / 100);
    reserveCents += freeCents - openSum;
    const zeroOpen = Object.keys(openWeights).map((c) => LABEL[c as PaidCategory]);
    alerts.push(
      zeroOpen.length
        ? `The categories with a suggested amount are already paid (${zeroOpen.join(", ")} gets no amount in this profile): the leftover of ${leftover} was added to the reserve.`
        : `All categories are already paid: the leftover of ${leftover} was added to the reserve.`,
    );
  }

  const cents = {} as Record<BudgetCategory, number>;
  for (const c of PAID_CATEGORIES) cents[c] = paid[c] ?? open[c] ?? 0;
  cents.reserva = reserveCents;

  for (const c of PAID_CATEGORIES) {
    if (paid[c] == null) continue;
    const ideal = Math.round((totalCents * idealPct[c]) / 100);
    if (paid[c]! > ideal) {
      alerts.push(`${LABEL[c]}: already paid (${money(paid[c]! / 100)}) above what is suggested for the profile (${money(ideal / 100)}); the other categories got smaller.`);
    }
  }

  const categories = Object.fromEntries(BUDGET_CATEGORIES.map((c) => [c, cents[c] / 100])) as Record<BudgetCategory, number>;
  const percentages = Object.fromEntries(
    BUDGET_CATEGORIES.map((c) => [c, Math.round((cents[c] / totalCents) * 1000) / 10]),
  ) as Record<BudgetCategory, number>;
  const localCents = cents.alimentacao + cents.passeios + cents.transporteLocal;
  const perPersonPerDayLocal = Math.round(localCents / v.days / v.travelers) / 100;

  if (v.currency.toUpperCase() === "BRL") {
    const min = MIN_DAILY_BRL[v.destinationType];
    if (perPersonPerDayLocal < min) {
      alerts.push(
        `A daily spend at the destination of ${money(perPersonPerDayLocal)} per person is below the plausible minimum for a ${v.destinationType === "nacional" ? "domestic" : "international"} trip (~${money(min)}). Consider fewer days, low season, another destination, or lodging with a kitchen.`,
      );
    }
  }

  return {
    total: v.total,
    currency: v.currency,
    days: v.days,
    travelers: v.travelers,
    profile,
    destinationType: v.destinationType,
    emergencyReservePct: reservePct,
    categories,
    percentages,
    ...(paidCents > 0 ? { alreadyPaid: Object.fromEntries(Object.entries(paid).map(([c, n]) => [c, n! / 100])) } : {}),
    perPersonPerDayLocal,
    alerts,
  };
}
