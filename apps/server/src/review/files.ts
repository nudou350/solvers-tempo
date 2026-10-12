import type { PackageEntry, PackageInput } from "../runtime/validate/index.js";

// Shared review utilities (scans, diff and hash): which package files count and how to read their text. Pure.

/** System junk that ZIP extraction discards (PACKAGE_SPEC.md 3.2). */
export function isJunkPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return path.startsWith("__MACOSX/") || base === ".DS_Store" || base === "Thumbs.db";
}

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/** Extensions the review reads as text (the Opening adds html and csv). */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".txt", ".json", ".html", ".htm", ".csv"]);

export const isTextPath = (path: string) => TEXT_EXTENSIONS.has(extOf(path));

/** Package files without system junk or symbolic links, in stable alphabetical order. */
export function reviewableEntries(input: PackageInput): PackageEntry[] {
  return input.entries
    .filter((e) => !e.isSymlink && !isJunkPath(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** UTF-8 text of the file (invalid bytes become U+FFFD: the review never fails because of that; the validator is what rejects). */
export function readText(input: PackageInput, path: string): string | null {
  const bytes = input.read(path);
  return bytes ? new TextDecoder("utf-8").decode(bytes) : null;
}

/** CRLF becomes LF, as in the package hash (a checkout on Windows and on the VPS must give the same result). */
export const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");
