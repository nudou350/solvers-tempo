import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { localeFilePath, PACKAGE_LOCALE_LANGS, PackageLocale, type AgentTranslations } from "@solvers/shared";
import { Manifest } from "./manifest.js";
import { resolveInsidePackage } from "./package-paths.js";
import { platformVerdict } from "./platform-agents.js";
import { ManifestV1 } from "./validate/schema-v1.js";

// Reads ONE package from disk and registers it in the package map (INSTRUCTIONS.md 5.4 and 6). No env/DB:
// tested in test/packages.test.ts. The cache and root folders live in packages.ts.

/** Template declared in `manifest.templates[]` (PACKAGE_SPEC.md 7). */
export type TemplateDecl = { name: string; path: string; title: string; description: string };

/** v1 manifest fields the v0 zod schema does not know (the loader uses ManifestV1 when `specVersion` is 1). */
export type ManifestExtras = {
  specVersion?: 1;
  platform?: boolean;
  templates?: TemplateDecl[];
  differentiators?: string[];
  /** First-use calibration (PACKAGE_SPEC.md 10): questions get_memory returns while there is no profile. */
  onboarding?: { questions: { id: string; ask: string; why: string; options?: string[] }[] };
};

export type SolverPackage = {
  manifest: Manifest & ManifestExtras;
  dir: string;
  steps: { title: string; body: string; gate: string[] }[];
  /** Computed on demand (reads every file in the package): boot does not pay for it. */
  versionHash: string;
  evalReport: { scoreBps: number; hash: string } | null;
  /** Translated catalog texts (locales/<lang>.json); empty = only the manifest's English. */
  translations: AgentTranslations;
  usesMemory: boolean;
  /** Where it came from: the platform folder (AGENTS_DIR) or creators' published packages (PUBLISHED_DIR). Default: agents. */
  source?: PackageSource;
  /** Platform Solver: the server's PLATFORM_AGENTS list is what counts, not the manifest field. */
  platform?: boolean;
};

export type PackageSource = "agents" | "published";

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    // A symbolic link would enter the hash (and a future read) pointing outside the folder.
    // Checked before skipping hidden files: `knowledge/.x.md` can also be a link.
    if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed in the package: ${relative(dir, full)}`);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (st.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Deterministic package hash: sha256 over (relative path + sha256 of the content) of all
 * files in alphabetical order, without dates. Same package => same hash on any machine.
 * The evals report is excluded (it is generated later and has its own on-chain hash).
 */
export function packageHash(dir: string): string {
  const h = createHash("sha256");
  const files = listFiles(dir)
    .map((f) => relative(dir, f).split(sep).join("/"))
    .filter((f) => f !== "evals/report.json")
    .sort();
  for (const rel of files) {
    const raw = readFileSync(join(dir, rel));
    // Text with CRLF (Windows checkout) and LF (VPS) must produce the same hash.
    const content = /\.(md|json|tsx?|jsx?|css|txt|ya?ml)$/.test(rel) ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n")) : raw;
    h.update(rel);
    h.update("\0");
    h.update(createHash("sha256").update(content).digest());
  }
  return h.digest("hex");
}

/**
 * Cheap stamp of the package folders (name, inode, mtime and size of each package's `manifest.json`): changes when another
 * process (the `cli:approve` CLI, the worker) swaps a folder or publishes a new version. Only stat, no content reads.
 */
export function packagesStamp(roots: readonly string[]): string {
  const parts: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      continue; // missing folder (no creator has published yet)
    }
    for (const name of names) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      try {
        const st = statSync(join(root, name, "manifest.json"));
        // Catalog translations (locales/pt.json) are included too: editing them without touching the manifest reloads the package.
        let loc = "";
        try {
          const ls = statSync(join(root, name, localeFilePath("pt")));
          loc = `|${Math.trunc(ls.mtimeMs)}|${ls.size}`;
        } catch {
          // no translations
        }
        parts.push(`${root}|${name}|${st.ino}|${Math.trunc(st.mtimeMs)}|${st.size}${loc}`);
      } catch {
        // no manifest.json (stray folder or swap in progress): skipped
      }
    }
  }
  return parts.join("\n");
}

/** Gate item: text or an object with evidence (v1); the engine delivers only the text. */
const gateText = (g: string | { text: string }): string => (typeof g === "string" ? g : g.text);

/** A v1 manifest (`specVersion: 1`) uses the new strict schema; without `specVersion` the platform v0 applies (zod strips what it does not know). */
function parseManifest(raw: unknown): Manifest & ManifestExtras {
  if (raw && typeof raw === "object" && (raw as { specVersion?: unknown }).specVersion === 1) {
    const m = ManifestV1.parse(raw);
    if (!m.id) throw new Error("v1 manifest without an id (the server assigns the id on upload; a published package needs one)");
    return { ...m, id: m.id, steps: m.steps.map((s) => ({ ...s, gate: s.gate.map(gateText) })) } as unknown as Manifest & ManifestExtras;
  }
  return Manifest.parse(raw);
}

/**
 * The package's catalog translations (`locales/<lang>.json`, only pt for now). The file is optional; if present and invalid
 * the package is rejected (the submission validator already blocks it earlier: this only protects what is on disk).
 */
export function loadLocales(dir: string): AgentTranslations {
  const out: AgentTranslations = {};
  for (const lang of PACKAGE_LOCALE_LANGS) {
    const rel = localeFilePath(lang);
    // Never follows a symbolic link: the path is fixed, but the folder comes from a third-party ZIP.
    const path = join(dir, rel);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) throw new Error(`symbolic links are not allowed in the package: ${rel}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${rel}: invalid JSON (${(e as Error).message})`);
    }
    const parsed = PackageLocale.safeParse(raw);
    if (!parsed.success) throw new Error(`${rel}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    out[lang] = parsed.data;
  }
  return out;
}

export function loadPackage(dir: string, opts: { source?: PackageSource } = {}): SolverPackage {
  const source = opts.source ?? "agents";
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  // The server list is the authority on "platform"; the manifest field only counts if the list agrees.
  const verdict = platformVerdict(manifest, source);
  if (verdict.error) throw new Error(verdict.error);
  // A published package lives in PUBLISHED_DIR/<slug>/: a folder with another name means a stray copy or a swap in progress.
  if (source === "published" && basename(dir) !== manifest.slug) throw new Error(`the folder ${basename(dir)} is not the package slug (${manifest.slug})`);
  // A symbolic link is never accepted in the package (lstat only, no content reads): the hash is lazy, so the rejection cannot depend on it.
  listFiles(dir);
  const steps = manifest.steps.map((s, i) => {
    // The path comes from the manifest: never join it directly (../ and symbolic links would escape the folder).
    const body = readFileSync(resolveInsidePackage(dir, s.file, ["steps/"]), "utf8");
    const title = s.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? `Step ${i + 1}`;
    return { title, body, gate: s.gate };
  });
  const reportPath = join(dir, "evals", "report.json");
  let evalReport: SolverPackage["evalReport"] = null;
  if (existsSync(reportPath)) {
    const raw = readFileSync(reportPath);
    const r = JSON.parse(raw.toString("utf8")) as { scoreBps?: number };
    evalReport = { scoreBps: Number(r.scoreBps ?? 0), hash: createHash("sha256").update(raw).digest("hex") };
  }
  const usesMemory = manifest.usesMemory ?? steps.some((s) => /(save_memory|get_memory)/.test(s.body));
  // The hash reads ALL files (knowledge included): it is only computed when something needs it (publish, catalog).
  let hash: string | undefined;
  return {
    manifest,
    dir,
    steps,
    get versionHash() {
      return (hash ??= packageHash(dir));
    },
    evalReport,
    translations: loadLocales(dir),
    usesMemory,
    source,
    platform: verdict.platform,
  };
}

/**
 * Registers the package by `id` and by `slug` in the same map. `id` and `slug` form ONE namespace:
 * any collision (repeated id, repeated slug, one package's slug equal to another's id) rejects the new package and
 * keeps the existing one, instead of the last one silently overwriting the first.
 */
export function registerPackage(registry: Map<string, SolverPackage>, pkg: SolverPackage): void {
  const { id, slug } = pkg.manifest;
  for (const key of [id, slug]) {
    const owner = registry.get(key);
    if (owner) throw new Error(`"${key}" already belongs to package ${owner.manifest.slug} (${owner.manifest.id})`);
  }
  registry.set(id, pkg);
  registry.set(slug, pkg);
}

/**
 * Loads all packages from a root folder (one per subfolder with manifest.json). An invalid or colliding package is skipped
 * and reported. `into` merges several roots into the SAME map: what is already in it takes priority (the platform comes before
 * creators) and an id/slug collision across roots rejects the new package. A missing root is not an error (PUBLISHED_DIR may not exist).
 */
export function loadAll(
  root: string,
  onError: (dir: string, e: Error) => void = () => undefined,
  opts: { source?: PackageSource; into?: Map<string, SolverPackage> } = {},
): Map<string, SolverPackage> {
  const registry = opts.into ?? new Map<string, SolverPackage>();
  if (!existsSync(root)) return registry;
  for (const name of readdirSync(root).sort()) {
    // `_archive/` (old versions), work folders (`.tmp`) and `node_modules` are never packages.
    if (name.startsWith("_") || name.startsWith(".") || name === "node_modules") continue;
    const dir = join(root, name);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    try {
      registerPackage(registry, loadPackage(dir, { source: opts.source }));
    } catch (e) {
      onError(dir, e as Error);
    }
  }
  return registry;
}
