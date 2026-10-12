import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

// Containment of paths written in the manifest (PACKAGE_SPEC.md 3.3). The loader used to read
// `join(dir, steps[].file)` unchecked: a package with "../../../.env" would serve that file as a step.

export class PackagePathError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PackagePathError";
  }
}

/**
 * Why `rel` is not acceptable as a relative path inside the package, or null. Looks at the text only (no disk):
 * the validator uses this on the contents of a ZIP, and `resolveInsidePackage` adds the disk checks.
 */
export function relativePathProblem(rel: string, allowedPrefixes: readonly string[]): string | null {
  if (typeof rel !== "string" || rel.length === 0) return "empty";
  if (rel.length > 200) return "too long";
  if (/[\u0000-\u001f\\]/.test(rel)) return "has a control character or a backslash";
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("/")) return "can't be absolute";
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "can't have '.', '..' or an empty segment";
  if (!allowedPrefixes.some((p) => rel.startsWith(p))) return `must start with ${allowedPrefixes.join(" or ")}`;
  return null;
}

/**
 * Resolves `rel` (a manifest path) inside `dir` and returns the file's real path.
 * Rejects: absolute paths, `..`, `.`, empty segments, `\`, control characters, prefixes outside
 * `allowedPrefixes`, a symbolic link in any segment and anything that, once resolved, leaves the folder.
 */
export function resolveInsidePackage(dir: string, rel: string, allowedPrefixes: readonly string[]): string {
  const bad = (why: string) => new PackagePathError(`invalid path "${rel}": ${why}`, rel);
  const textual = relativePathProblem(rel, allowedPrefixes);
  if (textual) throw bad(textual);
  const parts = rel.split("/");

  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw bad("the package folder does not exist");
  }
  let cur = root;
  for (const p of parts) {
    cur = join(cur, p);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw bad("the file does not exist in the package");
    }
    if (st.isSymbolicLink()) throw bad("symbolic links are not allowed");
  }
  const real = realpathSync(cur);
  const fromRoot = relative(root, real);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw bad("leaves the package folder");
  return real;
}
