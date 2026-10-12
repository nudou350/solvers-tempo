import { createHash } from "node:crypto";
import type { PackageInput } from "../runtime/validate/index.js";

// Package hash from a PackageInput (ZIP extracted in memory, or a folder). It is the SAME algorithm as
// `packageHash(dir)` in runtime/package-loader.ts, which becomes the on-chain `versionHash`: sha256 over (path + "\0" +
// sha256 of the content) of every file in alphabetical order, with CRLF normalized in text extensions, excluding
// `evals/report.json`, `node_modules` and names starting with a dot. If one changes, the other changes with it (the test in
// test/review-hash.test.ts compares both on the packages in agents/).

const TEXT_FILE = /\.(md|json|tsx?|jsx?|css|txt|ya?ml)$/;

export function packageHashOf(input: PackageInput): string {
  const files: string[] = [];
  for (const e of input.entries) {
    // A symbolic link would enter the hash pointing outside the folder: reject it, like the disk loader does.
    if (e.isSymlink) throw new Error(`symbolic links are not allowed in the package: ${e.path}`);
    const segments = e.path.split("/");
    if (segments.some((s) => s === "node_modules" || s.startsWith("."))) continue;
    if (e.path === "evals/report.json") continue;
    files.push(e.path);
  }
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const raw = input.read(rel);
    if (!raw) throw new Error(`file missing from the hash input: ${rel}`);
    const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const content = TEXT_FILE.test(rel) ? Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n")) : buf;
    h.update(rel);
    h.update("\0");
    h.update(createHash("sha256").update(content).digest());
  }
  return h.digest("hex");
}
