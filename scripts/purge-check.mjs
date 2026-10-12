#!/usr/bin/env node
// Purge check for the migration (docs/migration/decisions.md X2).
// Scans every file tracked or staged in git (plus untracked, non-ignored files) and reports matches of the
// previous-chain vocabulary. Only docs/migration/00-inventory.md may match.
//
//   node scripts/purge-check.mjs            word-boundary mode (the gate)
//   node scripts/purge-check.mjs --literal  the mission's literal substring regex (informational)
//   node scripts/purge-check.mjs --list     print every matching line
//
// Exit code 1 when a file other than the allow-listed one matches (in the selected mode), or when a package.json
// or the lockfile references a forbidden package.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const literal = process.argv.includes("--literal");
const list = process.argv.includes("--list");

// Tokens are assembled from fragments so this file does not match its own regex.
const J = (...parts) => parts.join("");
const BASE = [J("sol", "ana"), J("anc", "hor"), J("lam", "port"), "#short1", J("meta", "plex"), J("mpl", "-core"), J("hel", "ius"),
  J("cod", "ama"), J("lite", "svm"), J("base", "58"), J("bs", "58"), J("tweet", "nacl"), "#short2", J("dev", "net"), "#short3",
  J("clo", "ak"), J("so", "dax"), J("re", "sale"), J("re", "venda"), J("@sol", "ana")];
const SHORT_LITERAL = { "#short1": J("s", "pl"), "#short2": J("SI", "WS"), "#short3": J("P", "DA") };
const SHORT_WORD = { "#short1": J("\\bs", "pl\\b"), "#short2": J("\\bSI", "WS\\b"), "#short3": J("\\bP", "DAs?\\b") };
// Word mode: the SVG/CSS attribute `text-anchor` is not the previous chain's framework.
const WORD_OVERRIDES = { [J("anc", "hor")]: J("(?<!text-)anc", "hor") };
// Word mode only (the literal mode stays the mission's regex): the Portuguese stem of the dropped secondary market
// (verb, noun and adjective forms); licenses are transferred, never put up for sale again.
const WORD_EXTRA = [J("re", "vend")];
const TOKENS_LITERAL = BASE.map((t) => SHORT_LITERAL[t] ?? t).join("|");
const TOKENS_WORD = [...BASE.map((t) => SHORT_WORD[t] ?? WORD_OVERRIDES[t] ?? t), ...WORD_EXTRA].join("|");
const RE = new RegExp(literal ? TOKENS_LITERAL : TOKENS_WORD, "i");
const ALLOWED = new Set(["docs/migration/00-inventory.md"]);
// Exact occurrences allowed outside the inventory: file -> phrases. A line is allowed only when it still contains the
// phrase and nothing else on it matches once the phrase is removed.
const ALLOWED_PHRASES = new Map([
  // Generic web term (in-page links from an accessible error summary to each form field), not the previous chain's
  // framework.
  // Kept verbatim: frontend-react is a paid package with a measured eval, and editing it would change its package hash.
  ["agents/frontend-react/knowledge/formularios-e-validacao.md", [J("a list of ", "anc", "hor links to each field")]],
]);
const lineAllowed = (f, line) =>
  (ALLOWED_PHRASES.get(f) ?? []).some((p) => line.includes(p) && !RE.test(line.split(p).join(" ")));

// pnpm-lock.yaml: exact entries allowed by their place in the lockfile (package entry -> section -> key), never by text
// alone. FORBIDDEN_LOCK below still fails on any installed package of the previous chain.
const LOCK_ALLOWED = [
  // Decision X33: Privy declares optional peers for its wallet support on the previous chain. With
  // `autoInstallPeers: false` none of them is installed; only these declaration lines remain as text, under the
  // `peerDependencies` / `peerDependenciesMeta` of the `@privy-io/react-auth` package entry.
  {
    entry: /^'@privy-io\/react-auth@[^']+'$/,
    sections: ["peerDependencies", "peerDependenciesMeta"],
    keys: [
      J("@farcaster/mini-app-", "sol", "ana"),
      J("@sol", "ana-program/memo"),
      J("@sol", "ana-program/system"),
      J("@sol", "ana-program/token"),
      J("@sol", "ana/kit"),
    ],
  },
  // A generic base-58 codec (no chain SDK), installed for Privy's WalletConnect/Reown connectors: its own entries
  // (packages and snapshots) and the two parents that depend on it today. Any other dependent fails the check.
  { entry: new RegExp(`^${J("b", "s58")}@[0-9.]+$`), self: true },
  { entry: /^'@(reown\/appkit|walletconnect\/utils)@[^']+'$/, sections: ["dependencies"], keys: [J("b", "s58")] },
];
/** Line indexes of pnpm-lock.yaml covered by LOCK_ALLOWED. */
function lockAllowedLines(lines) {
  const allowed = new Set();
  let entry = null;
  let section = null;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    const top = l.match(/^ {2}(\S.*):$/);
    if (top) {
      entry = top[1];
      section = null;
      if (LOCK_ALLOWED.some((a) => a.self && a.entry.test(entry))) allowed.add(i);
      return;
    }
    if (/^\S/.test(l)) {
      entry = null;
      section = null;
      return;
    }
    const sec = l.match(/^ {4}(\w+):\s*$/);
    if (sec) {
      section = sec[1];
      return;
    }
    const key = l.match(/^ {6}'?([^':]+)'?:/);
    const ok = (a) => !a.self && a.entry.test(entry) && a.sections.includes(section) && a.keys.includes(key[1]);
    if (key && entry && section && LOCK_ALLOWED.some(ok)) allowed.add(i);
  });
  return allowed;
}
const BINARY = /\.(png|jpe?g|gif|ico|webp|zip|woff2?|ttf|onnx|bin|pdf)$/i;
const SOL = J("@sol", "ana");
const CLK = J("@clo", "ak");
const FORBIDDEN_PKG = new RegExp(`"(${SOL}[^"]*|web3\\.js|@x402/[^"]*|${CLK}\\.dev/[^"]*)"\\s*:`);
const FORBIDDEN_LOCK = new RegExp(`^\\s{2}'?(${SOL}[/-]|@x402/|${CLK}\\.dev/|web3\\.js@)`, "m");

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(f) && !BINARY.test(f));

let bad = 0;
const perFile = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  const lockAllowed = f === "pnpm-lock.yaml" ? lockAllowedLines(lines) : null;
  const hits = [];
  lines.forEach((l, i) => {
    if (RE.test(l) && !lineAllowed(f, l) && !lockAllowed?.has(i)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
  });
  if (hits.length) {
    const allowed = ALLOWED.has(f);
    if (!allowed) bad++;
    perFile.push([f, hits.length, allowed]);
    if (list && !allowed) console.log(hits.join("\n"));
  }
  if (/(^|\/)package\.json$/.test(f) && FORBIDDEN_PKG.test(text)) {
    bad++;
    console.log(`FORBIDDEN PACKAGE in ${f}: ${text.match(FORBIDDEN_PKG)[1]}`);
  }
}
if (existsSync("pnpm-lock.yaml")) {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const m = lock.match(FORBIDDEN_LOCK);
  if (m) {
    bad++;
    const n = lock.split("\n").filter((l) => FORBIDDEN_LOCK.test(l)).length;
    console.log(`FORBIDDEN PACKAGE in pnpm-lock.yaml: ${n} entries, first: ${m[0].trim()}`);
  }
}
perFile.sort((a, b) => b[1] - a[1]);
const total = perFile.reduce((s, [, n, a]) => s + (a ? 0 : n), 0);
console.log(`mode: ${literal ? "literal" : "word-boundary"}; files matching (excluding allow-list): ${perFile.filter((p) => !p[2]).length}; lines: ${total}`);
if (!list) for (const [f, n, a] of perFile.slice(0, 40)) console.log(`${String(n).padStart(5)}  ${f}${a ? "  (allowed)" : ""}`);
process.exit(bad ? 1 : 0);
