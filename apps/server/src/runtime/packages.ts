import { resolve } from "node:path";
import { env } from "../env.js";
import { loadAll, packagesStamp, type SolverPackage } from "./package-loader.js";
import { Manifest } from "./manifest.js";

// Cache of the solver packages read from disk (INSTRUCTIONS.md 5.4 and 6; PACKAGE_SPEC.md 15.1). The server merges two
// sources: AGENTS_DIR (platform, agents/<slug>) and PUBLISHED_DIR (creators, <slug>/, one active per slug). Step content
// never goes out whole: only the current step is delivered. Reading each package and the collision rules live in
// package-loader.ts (no env, testable).

export { Manifest };
export { loadPackage, packageHash, registerPackage, type SolverPackage } from "./package-loader.js";

let cache: Map<string, SolverPackage> | null = null;
/** Folder stamp at the last load and when it was last checked (another process may swap the folder). */
let cacheStamp = "";
let lastStampCheck = 0;
/** The API and the CLI/worker are different processes: the stamp check (stat only) runs at most every 5 s. */
const STAMP_CHECK_MS = 5000;
/** Errors from the last load (invalid package, duplicate id/slug, unauthorized platform): for logging and diagnosis. */
let lastErrors: { dir: string; message: string }[] = [];

export function agentsDir(): string {
  return resolve(process.cwd(), env.AGENTS_DIR);
}

export function publishedDir(): string {
  return resolve(process.cwd(), env.PUBLISHED_DIR);
}

/**
 * All packages, indexed by id and by slug (a single namespace). Loading is on demand (on the first
 * call, not at module import) and each package's version hash is only computed when someone reads it.
 * Duplicate `id`/`slug`, within one source or across both, do NOT overwrite: the package that came later is
 * rejected and reported (the platform comes first and always wins).
 */
export function packages(): Map<string, SolverPackage> {
  if (cache) {
    refreshPackagesIfChanged();
    return cache;
  }
  const errors: { dir: string; message: string }[] = [];
  const onError = (dir: string, e: Error) => {
    errors.push({ dir, message: e.message });
    console.error(`[runtime] invalid package in ${dir}:`, e.message);
  };
  const registry = loadAll(agentsDir(), onError, { source: "agents" });
  // PUBLISHED_DIR may not exist (no creator has published yet): not an error.
  loadAll(publishedDir(), onError, { source: "published", into: registry });
  lastErrors = errors;
  cache = registry;
  cacheStamp = packagesStamp([agentsDir(), publishedDir()]);
  lastStampCheck = Date.now();
  return cache;
}

/**
 * Reloads the cache if the folders changed since the last load (a publication done by ANOTHER process, e.g. `cli:approve`:
 * without this the API would serve the old manifest and the already deleted knowledge version until a restart). `force`
 * skips the 5 s interval. Returns whether it reloaded.
 */
export function refreshPackagesIfChanged(force = false): boolean {
  if (!cache) return false;
  const now = Date.now();
  if (!force && now - lastStampCheck < STAMP_CHECK_MS) return false;
  lastStampCheck = now;
  if (packagesStamp([agentsDir(), publishedDir()]) === cacheStamp) return false;
  reloadPackages();
  return true;
}

export function packageLoadErrors(): readonly { dir: string; message: string }[] {
  packages();
  return lastErrors;
}

export function getPackage(idOrSlug: string): SolverPackage | undefined {
  return packages().get(idOrSlug);
}

/** Invalidates the cache and reloads from disk (called after publishing, updating or suspending a package). */
export function reloadPackages(): Map<string, SolverPackage> {
  cache = null;
  return packages();
}
