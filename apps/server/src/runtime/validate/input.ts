import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageInput } from "./index.js";

// Builds the validator input from a folder on disk or from in-memory files (e.g. JSON coming from MCP).

/** Package folder on disk (relative paths with `/`). Symbolic links are included flagged, never followed. */
export function packageFromFolder(dir: string): PackageInput {
  const entries: PackageInput["entries"] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (name === "node_modules" || name === ".git") continue;
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, relPath));
      if (st.isSymbolicLink()) entries.push({ path: relPath, size: 0, isSymlink: true });
      else if (st.isDirectory()) walk(relPath);
      else entries.push({ path: relPath, size: st.size });
    }
  };
  walk("");
  return {
    entries,
    read: (path) => {
      try {
        return readFileSync(join(dir, path));
      } catch {
        return undefined;
      }
    },
  };
}

/** In-memory files: { "manifest.json": "...", "steps/01.md": "..." }. */
export function packageFromMemory(files: Record<string, string | Uint8Array>): PackageInput {
  const bytes = new Map(Object.entries(files).map(([p, c]) => [p, typeof c === "string" ? new TextEncoder().encode(c) : c]));
  return {
    entries: [...bytes].map(([path, b]) => ({ path, size: b.byteLength })),
    read: (path) => bytes.get(path),
  };
}
