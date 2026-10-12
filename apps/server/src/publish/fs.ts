import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// Publication on disk (PACKAGE_SPEC.md 15.1): the submission's extracted folder -> PUBLISHED_DIR/<slug> via `rename`, with the
// previous version moving to _archive/<slug>/<version>/. Only `node:fs`: tested in test/publish-fs.test.ts.

/** The package folder inside the extracted folder: itself (has manifest.json) or the only subfolder that has one (ZIP root). */
export function findPackageRoot(extracted: string): string {
  if (!existsSync(extracted)) throw new Error(`extracted folder not found: ${extracted}`);
  if (existsSync(join(extracted, "manifest.json"))) return extracted;
  const candidates = readdirSync(extracted)
    .filter((n) => !n.startsWith(".") && n !== "__MACOSX")
    .map((n) => join(extracted, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "manifest.json")));
  if (candidates.length !== 1) throw new Error(`could not find a single manifest.json in ${extracted} (${candidates.length} candidates)`);
  return candidates[0]!;
}

/** Copies the package to `<parent>/<slug>` (the folder name is the slug: the loader checks it). Redoes the copy if it already exists. */
export function stagePackage(srcRoot: string, parent: string, slug: string): string {
  const dest = join(parent, slug);
  mkdirSync(parent, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(srcRoot, dest, { recursive: true, errorOnExist: true });
  return dest;
}

/** `version` from a published folder's manifest.json (null if unreadable). */
export function publishedVersionOf(dir: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** `id` and `version` from a published folder's manifest.json (null if unreadable). */
export function publishedIdentityOf(dir: string): { id: string | null; version: string | null } | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { id?: unknown; version?: unknown };
    return { id: typeof m.id === "string" && m.id ? m.id : null, version: typeof m.version === "string" && m.version ? m.version : null };
  } catch {
    return null;
  }
}

/** A free name inside the archive (never overwrites an already archived version). */
function freeArchiveDir(archiveRoot: string, slug: string, version: string): string {
  let dest = join(archiveRoot, slug, version);
  for (let n = 1; existsSync(dest); n++) dest = join(archiveRoot, slug, `${version}-${n}`);
  return dest;
}

/**
 * Puts `staged` at `<published>/<slug>`. If a package is already there, it first moves to `<published>/_archive/<slug>/<version>/`.
 * Both steps are a `rename` on the same volume (the staging folder lives inside `published`). Returns where the previous
 * version ended up (null if there was none). Does not check the hash: the caller already checked `staged`.
 */
export function swapInPublished(published: string, slug: string, staged: string, expectAgentId?: string): { archivedTo: string | null } {
  const target = join(published, slug);
  let archivedTo: string | null = null;
  if (existsSync(target)) {
    // Last line of defense: never archive (or replace) the folder of ANOTHER Solver occupying this slug.
    const current = publishedIdentityOf(target);
    if (expectAgentId && current?.id && current.id !== expectAgentId) throw new Error("the published folder for this slug belongs to another Solver");
    const version = publishedVersionOf(target) ?? `unknown-${Date.now()}`;
    archivedTo = freeArchiveDir(join(published, "_archive"), slug, version);
    mkdirSync(join(archivedTo, ".."), { recursive: true });
    renameSync(target, archivedTo);
  }
  renameSync(staged, target);
  return { archivedTo };
}

/** Staging folder for a finalization (inside PUBLISHED_DIR, same volume; hidden, so the loader ignores it). */
export function incomingParent(published: string, submissionId: string): string {
  return join(published, ".incoming", submissionId);
}

/** Cleans up the staging folder (on success or abort). */
export function cleanIncoming(published: string, submissionId: string): void {
  rmSync(incomingParent(published, submissionId), { recursive: true, force: true });
}
