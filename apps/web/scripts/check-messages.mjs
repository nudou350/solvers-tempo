// Checks the i18n messages (run by `pnpm test` in apps/web):
//  1. every namespace in src/i18n/namespaces.ts has a file in messages/en and messages/pt (and there is no extra file);
//  2. en and pt have exactly the same keys (different ICU variables, such as {n} or <b>, are reported as warnings);
//  3. (best effort) every literal key used in t("..."), t.rich("..."), t.raw("..."), t.has("...") from
//     useTranslations("ns") / getTranslations("ns") exists in the messages.
// Keys built with ${...} only have their fixed part checked (the prefix must exist).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "pt"];
const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// 1. Namespaces
const nsSource = readFileSync(join(ROOT, "src/i18n/namespaces.ts"), "utf8");
const listMatch = nsSource.match(/NAMESPACES\s*=\s*\[([\s\S]*?)\]\s*as const/);
if (!listMatch) {
  console.error("check-messages: NAMESPACES not found in src/i18n/namespaces.ts");
  process.exit(1);
}
const NAMESPACES = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** @type {Record<string, Record<string, any>>} */
const messages = { en: {}, pt: {} };
for (const loc of LOCALES) {
  const dir = join(ROOT, "messages", loc);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    fail(`messages/${loc}/ does not exist`);
  }
  for (const ns of NAMESPACES) {
    if (!files.includes(`${ns}.json`)) {
      fail(`messages/${loc}/${ns}.json does not exist (namespace "${ns}" is in namespaces.ts)`);
      continue;
    }
    try {
      messages[loc][ns] = JSON.parse(readFileSync(join(dir, `${ns}.json`), "utf8"));
    } catch (e) {
      fail(`messages/${loc}/${ns}.json is not valid JSON: ${e.message}`);
    }
  }
  for (const f of files) {
    const ns = f.slice(0, -5);
    if (!NAMESPACES.includes(ns)) fail(`messages/${loc}/${f} is not registered in src/i18n/namespaces.ts`);
  }
}

// 2. Same keys in en and pt
/** "a.b.c" -> text, for each leaf (string). */
function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === "string") out.set(key, v);
    else fail(`value that is neither text nor object at ${key}`);
  }
  return out;
}

/** Position of the `}` that closes the `{` at `i` (respecting nesting); -1 if it never closes. */
function closeBrace(text, i) {
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === "{") depth++;
    else if (text[k] === "}" && --depth === 0) return k;
  }
  return -1;
}

/** ICU variables of a text ({n}, {n, plural, one {...}}, <b>...</b>), including inside plural/select branches. */
function collect(text, names) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'" && text[i + 1] === "{") {
      const end = text.indexOf("}", i); // {literal} escaped with an apostrophe
      if (end < 0) return;
      i = end;
      continue;
    }
    if (text[i] !== "{") continue;
    const end = closeBrace(text, i);
    if (end < 0) return;
    const inner = text.slice(i + 1, end);
    const m = /^\s*([A-Za-z_]\w*)\s*(?:,\s*(plural|select|selectordinal)\s*,([\s\S]*))?$/.exec(inner);
    if (m) {
      names.add(m[1]);
      if (m[3]) {
        // Branches: `one {text} other {text}`; only the inner text can hold other variables.
        const opts = m[3];
        for (let k = 0; k < opts.length; k++) {
          if (opts[k] !== "{") continue;
          const e = closeBrace(opts, k);
          if (e < 0) break;
          collect(opts.slice(k + 1, e), names);
          k = e;
        }
      }
    }
    i = end;
  }
}

function placeholders(text) {
  const names = new Set();
  collect(text, names);
  for (const m of text.matchAll(/<([A-Za-z]\w*)>/g)) names.add(`<${m[1]}>`);
  return [...names].sort().join(",");
}

/** @type {Record<string, Map<string,string>>} */
const flat = { en: new Map(), pt: new Map() };
for (const loc of LOCALES) {
  for (const ns of NAMESPACES) {
    if (!messages[loc][ns]) continue;
    for (const [k, v] of flatten(messages[loc][ns], ns)) flat[loc].set(k, v);
  }
}
// Intentional differences: en shows the amount in dollars (1:1 with USDC) and needs neither the conversion nor the rate.
const PLACEHOLDER_DIFF_OK = new Set(["catalog.card.orUsdc", "checkout.view.summary.rateNote"]);
for (const [k, v] of flat.en) {
  if (!flat.pt.has(k)) fail(`missing in pt: ${k}`);
  else if (!PLACEHOLDER_DIFF_OK.has(k) && placeholders(v) !== placeholders(flat.pt.get(k)))
    // Warning only: one language may deliberately skip a variable the other uses (e.g. en shows $ and not the BRL rate).
    warn(`different variables in ${k}: en={${placeholders(v)}} pt={${placeholders(flat.pt.get(k))}}`);
}
for (const k of flat.pt.keys()) if (!flat.en.has(k)) fail(`missing in en: ${k}`);

// 3. Literal keys used in src
const allKeys = flat.en;
const prefixes = new Set();
for (const k of allKeys.keys()) {
  const parts = k.split(".");
  for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("."));
}
const exists = (key) => allKeys.has(key);
const hasPrefix = (key) => prefixes.has(key);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const DECL = /\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:"([^"]*)"|\{[^}]*?namespace:\s*"([^"]*)"[^}]*?\})?\s*\)/g;
let checked = 0;
for (const file of walk(join(ROOT, "src"))) {
  const src = readFileSync(file, "utf8");
  const decls = [...src.matchAll(DECL)].map((m) => ({ pos: m.index, name: m[1], ns: m[2] ?? m[3] ?? "" }));
  if (!decls.length) continue;
  const names = [...new Set(decls.map((d) => d.name))];
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  for (const name of names) {
    const mine = decls.filter((d) => d.name === name).sort((a, b) => a.pos - b.pos);
    const call = new RegExp(`(?<![\\w.])${name}(?:\\.(?:rich|raw|has|markup))?\\(\\s*("([^"\\\\]*)"|\`([^\`]*)\`)`, "g");
    for (const m of src.matchAll(call)) {
      // The closest declaration before the call applies (a file can have several components with `t`).
      const d = [...mine].reverse().find((x) => x.pos < m.index);
      if (!d) continue;
      const literal = m[2] ?? m[3];
      const line = src.slice(0, m.index).split("\n").length;
      const full = (key) => (d.ns ? `${d.ns}.${key}` : key);
      checked++;
      if (m[3] !== undefined && m[3].includes("${")) {
        const fixed = m[3].slice(0, m[3].indexOf("${"));
        const base = fixed.endsWith(".") ? fixed.slice(0, -1) : fixed.includes(".") ? fixed.slice(0, fixed.lastIndexOf(".")) : "";
        if (base && !hasPrefix(full(base)) && !exists(full(base))) fail(`${rel}:${line} nonexistent key prefix: ${full(base)} (from t(\`${m[3]}\`))`);
        continue;
      }
      const key = full(literal);
      // t.has("x") may legitimately point to a key that may not exist; the others must exist.
      const isHas = src.slice(m.index, m.index + name.length + 5).startsWith(`${name}.has(`);
      if (isHas) continue;
      if (!exists(key) && !hasPrefix(key)) fail(`${rel}:${line} nonexistent key: ${key}`);
      else if (!exists(key) && hasPrefix(key) && !src.slice(m.index, m.index + name.length + 6).startsWith(`${name}.raw(`))
        fail(`${rel}:${line} the key ${key} is a group, not a text`);
    }
  }
}

if (warnings.length) console.warn(`check-messages: ${warnings.length} warning(s)\n` + warnings.map((w) => `  - ${w}`).join("\n"));
if (errors.length) {
  console.error(`check-messages: ${errors.length} problem(s)\n` + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log(
  `check-messages: ok (${NAMESPACES.length} namespaces, ${flat.en.size} keys in en and pt, ${checked} literal t(...) uses checked)`,
);
