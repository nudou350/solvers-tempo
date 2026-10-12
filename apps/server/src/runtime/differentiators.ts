import { statSync } from "node:fs";
import { join } from "node:path";
import type { SolverPackage } from "./package-loader.js";
import { validatePackage, type PackageInput } from "./validate/index.js";
import { packageFromFolder } from "./validate/input.js";

// PROVEN differentiators of a v1 package (PACKAGE_SPEC.md 4.2 and 20): what the validator can check, not what the
// creator declared. They show in the storefront (`Agent.differentiators`) and in find_solver. A v0 package has none (empty list).
// Cost: the public catalog calls this per package, and running the full validator reads the whole folder. So (1) the validator
// gets a trimmed view of the package (manifest, steps and only the knowledge front-matter: that is all the differentiators
// read; evals, templates and the knowledge body are left out) and (2) the result is cached by package identity
// (id, version and manifest.json stamp), which survives `reloadPackages()`, for 12 h because `liveData`
// depends on today's date.

const TTL_MS = 12 * 3600_000;
const MAX_ENTRIES = 500;
const byIdentity = new Map<string, { at: number; value: string[] }>();
const identityOf = new WeakMap<SolverPackage, string>();

function keyOf(pkg: SolverPackage): string {
  let key = identityOf.get(pkg);
  if (key) return key;
  let stamp = "?";
  try {
    const st = statSync(join(pkg.dir, "manifest.json"));
    stamp = `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    // no readable manifest.json: the key falls back to the object (the validator will fail anyway)
  }
  key = `${pkg.manifest.id}|${pkg.manifest.version}|${pkg.source ?? "agents"}|${stamp}`;
  identityOf.set(pkg, key);
  return key;
}

/** Only the front-matter block of a knowledge file (the rest is body, which the differentiators do not read). */
export function frontMatterHead(text: string): string {
  if (!/^---[ \t]*\r?\n/.test(text)) return "";
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i]!)) return `${lines.slice(0, i + 1).join("\n")}\n`;
  }
  return text; // unclosed front-matter: the validator must see all of it to give the same verdict
}

/** Trimmed view of the package folder for computing the differentiators (same entries, reads only what matters). */
export function differentiatorsInput(full: PackageInput): PackageInput {
  return {
    entries: full.entries,
    read: (path) => {
      if (path === "manifest.json" || path.startsWith("steps/")) return full.read(path);
      if (path.startsWith("knowledge/") && !path.endsWith(".meta.json")) {
        const raw = full.read(path);
        if (!raw) return undefined;
        return path.endsWith(".md") ? new TextEncoder().encode(frontMatterHead(new TextDecoder().decode(raw))) : new Uint8Array();
      }
      return undefined;
    },
  };
}

export function provenDifferentiators(pkg: SolverPackage | undefined, now = new Date()): string[] {
  if (!pkg || pkg.manifest.specVersion !== 1) return [];
  const key = keyOf(pkg);
  const hit = byIdentity.get(key);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.value;
  let value: string[] = [];
  try {
    // A creator package is judged by third-party rules (no "verifier"); a platform package, by platform rules.
    value = validatePackage(differentiatorsInput(packageFromFolder(pkg.dir)), { mode: pkg.source === "published" ? "third_party" : "platform", now }).stats.differentiators;
  } catch (e) {
    console.error(`[runtime] could not compute the differentiators of ${pkg.manifest.slug}:`, (e as Error).message);
  }
  if (byIdentity.size >= MAX_ENTRIES) byIdentity.clear();
  byIdentity.set(key, { at: now.getTime(), value });
  return value;
}

/** For tests: empties the cache. */
export function clearDifferentiatorsCache(): void {
  byIdentity.clear();
}
