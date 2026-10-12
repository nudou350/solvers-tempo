import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { relativePathProblem } from "../runtime/package-paths.js";
import type { PackageEntry } from "../runtime/validate/index.js";

// Safe extraction of a ZIP submitted by third parties (PACKAGE_SPEC.md 3.2). Nothing in the ZIP is executed and no link is followed:
//   - the file list comes from the CENTRAL DIRECTORY (yauzl) and is fully checked BEFORE writing any byte;
//   - the real bytes are counted while streaming during extraction, and extraction aborts when it exceeds the cap
//     (the size declared in the header is not trusted: a zip bomb lies about it);
//   - files are written with mode 0640 (no execute) into an isolated folder, and each name is checked against `..`, `\`,
//     absolute paths, control characters and names starting with a dot before becoming a disk path.
// The caller handles `ZipError`: its `issues` already have the validator's shape ({ code, path, message, fix }).

export type ZipIssue = { code: string; path: string; message: string; fix: string };

/** Catalog codes (Appendix A) plus `ZIP_UNREADABLE` (corrupted, encrypted or unsupported-compression ZIP). */
export class ZipError extends Error {
  constructor(readonly issues: ZipIssue[]) {
    super(issues[0]?.message ?? "Invalid ZIP");
    this.name = "ZipError";
  }
}

export type ZipLimits = {
  zipBytes: number;
  expandedBytes: number;
  files: number;
  fileBytes: number;
  /** Extensions accepted in the Core (lowercase, with the dot). */
  allowedExtensions: readonly string[];
};

export const NUCLEO_ZIP_LIMITS: ZipLimits = {
  zipBytes: 50 * 1024 * 1024,
  expandedBytes: 150 * 1024 * 1024,
  files: 2000,
  fileBytes: 10 * 1024 * 1024,
  allowedExtensions: [".json", ".md", ".txt"],
};

export type ExtractedZip = {
  /** Folder where the content of the ZIP's root was extracted: `manifest.json` sits directly in it. */
  root: string;
  /** Name of the root folder inside the ZIP. */
  rootName: string;
  /** Extracted files, with path relative to the root and REAL size. */
  entries: PackageEntry[];
  /** `ZIP_IGNORED_FILE` for the removed system junk. */
  warnings: ZipIssue[];
  /** Real bytes written and ZIP size (they feed the validator's `archive`). */
  expandedBytes: number;
  zipBytes: number;
};

const issue = (code: string, path: string, message: string, fix: string): ZipIssue => ({ code, path, message, fix });

const JUNK_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const isJunk = (name: string) => name.startsWith("__MACOSX/") || name === "__MACOSX" || JUNK_BASENAMES.has(name.slice(name.lastIndexOf("/") + 1));

const extOf = (p: string) => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
};

type Item = { entry: yauzl.Entry; rel: string; declared: number };

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) => {
    // decodeStrings:false -> the name arrives as a Buffer and is decoded/validated here (yauzl would silently swap `\` for `/`).
    // validateEntrySizes:false -> we count the real size ourselves, while streaming, against the caps.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: false }, (err, zf) => (err || !zf ? fail(err ?? new Error("empty ZIP")) : ok(zf)));
  });
}

/** Reads the whole central directory (without extracting anything). */
function readEntries(zf: yauzl.ZipFile, maxEntries: number): Promise<yauzl.Entry[]> {
  return new Promise((ok, fail) => {
    const all: yauzl.Entry[] = [];
    zf.on("error", fail);
    zf.on("end", () => ok(all));
    zf.on("entry", (e: yauzl.Entry) => {
      all.push(e);
      if (all.length > maxEntries) {
        zf.removeAllListeners("end");
        fail(new ZipError([issue("ZIP_TOO_MANY_FILES", "", `The ZIP has more than ${maxEntries} entries`, "Merge small knowledge files.")]));
        return;
      }
      zf.readEntry();
    });
    zf.readEntry();
  });
}

function openEntry(zf: yauzl.ZipFile, e: yauzl.Entry) {
  return new Promise<NodeJS.ReadableStream>((ok, fail) => zf.openReadStream(e, (err, s) => (err || !s ? fail(err ?? new Error("no stream")) : ok(s))));
}

/**
 * Extracts the ZIP into `destDir` (created here; it must not exist). On any failure it deletes what it wrote and throws `ZipError`.
 */
export async function extractZip(zipPath: string, destDir: string, limits: ZipLimits = NUCLEO_ZIP_LIMITS): Promise<ExtractedZip> {
  const st = await stat(zipPath);
  if (st.size > limits.zipBytes) {
    throw new ZipError([issue("ZIP_TOO_LARGE", "", `The ZIP is ${st.size} bytes, over the ${limits.zipBytes} byte limit`, "Reduce the knowledge base or split the content.")]);
  }
  let zf: yauzl.ZipFile | undefined;
  try {
    try {
      zf = await openZip(zipPath);
    } catch (e) {
      throw new ZipError([issue("ZIP_UNREADABLE", "", `Could not open the ZIP: ${(e as Error).message}`, "Create the ZIP again (select the package folder and compress it).")]);
    }
    const entries = await readEntries(zf, limits.files * 2 + 100).catch((e) => {
      if (e instanceof ZipError) throw e;
      throw new ZipError([issue("ZIP_UNREADABLE", "", `Corrupted ZIP: ${(e as Error).message}`, "Create the ZIP again.")]);
    });
    const { items, rootName, warnings } = plan(entries, limits);
    const root = resolve(destDir);
    await mkdir(root, { recursive: true, mode: 0o750 });
    try {
      const out = await extractItems(zf, items, root, limits);
      return { root, rootName, entries: out.entries, warnings, expandedBytes: out.bytes, zipBytes: st.size };
    } catch (e) {
      await rm(root, { recursive: true, force: true });
      throw e;
    }
  } finally {
    zf?.close();
  }
}

/** Checks every central directory entry and returns what will be extracted. Throws with ALL the problems found. */
function plan(entries: yauzl.Entry[], limits: ZipLimits): { items: Item[]; rootName: string; warnings: ZipIssue[] } {
  const problems: ZipIssue[] = [];
  const warnings: ZipIssue[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Map<string, string>();
  const warned = new Set<string>();
  const staged: { entry: yauzl.Entry; name: string; declared: number }[] = [];
  let declaredTotal = 0;

  for (const entry of entries) {
    let name: string;
    try {
      name = decoder.decode(entry.fileName as unknown as Buffer);
    } catch {
      problems.push(issue("ZIP_BAD_PATH", "(unreadable name)", "A file name is not valid UTF-8", "Rename it without accents or compress with another program (for example, your system's built-in compressor)."));
      continue;
    }
    const isDir = name.endsWith("/");
    if (isJunk(name)) {
      // The __MACOSX/ folder may have thousands of entries: only one warning per folder.
      const key = name.startsWith("__MACOSX") ? "__MACOSX/" : name;
      if (!warned.has(key)) {
        warned.add(key);
        warnings.push(issue("ZIP_IGNORED_FILE", key, "System file removed from the extraction", "Nothing to do; avoid compressing with Finder without cleaning up first."));
      }
      continue;
    }
    if (isDir) {
      // Folders are not extracted (they are created with the files), but the name must be as safe as any other path.
      const why = pathProblem(name.slice(0, -1).normalize("NFC"));
      if (why) problems.push(issue("ZIP_BAD_PATH", name, `Invalid path: ${why}`, "Rename the folder using letters, digits, hyphens, underscores and dots."));
      continue;
    }
    const nfc = name.normalize("NFC");
    const unixMode = entry.versionMadeBy >> 8 === 3 ? (entry.externalFileAttributes >>> 16) & 0o170000 : 0;
    if (unixMode === 0o120000) {
      problems.push(issue("ZIP_SYMLINK", nfc, "Symbolic links are not allowed", "Replace the link with the real file."));
      continue;
    }
    const why = pathProblem(nfc);
    if (why) {
      problems.push(issue("ZIP_BAD_PATH", nfc, `Invalid path: ${why}`, "Rename the file using letters, digits, hyphens, underscores and dots."));
      continue;
    }
    const key = nfc.toLowerCase();
    if (seen.has(key)) {
      problems.push(issue("ZIP_DUPLICATE_ENTRY", nfc, `Duplicates the file ${seen.get(key)} (NFC, case-insensitive)`, "Keep only one version of the file."));
      continue;
    }
    seen.set(key, nfc);
    if (entry.isEncrypted()) {
      problems.push(issue("ZIP_UNREADABLE", nfc, "Password-protected file", "Create the ZIP without a password."));
      continue;
    }
    staged.push({ entry, name: nfc, declared: entry.uncompressedSize });
    declaredTotal += entry.uncompressedSize;
  }

  if (staged.length > limits.files) {
    problems.push(issue("ZIP_TOO_MANY_FILES", "", `${staged.length} files exceed the limit of ${limits.files}`, "Merge small knowledge files."));
  }
  if (declaredTotal > limits.expandedBytes) {
    problems.push(issue("ZIP_EXPANDS_TOO_MUCH", "", `The extracted content would exceed ${limits.expandedBytes} bytes`, "Reduce the size of the files."));
  }

  // Single root: every entry starts with the same folder, and that folder contains manifest.json.
  const roots = new Set(staged.map((s) => s.name.split("/")[0]!));
  const flat = staged.filter((s) => !s.name.includes("/"));
  const rootName = [...roots][0] ?? "";
  if (staged.length === 0 || roots.size !== 1 || flat.length > 0) {
    problems.push(issue("ZIP_BAD_ROOT", "", `The ZIP must have exactly 1 root folder containing manifest.json (found ${flat.length ? "loose files at the root" : `${roots.size} roots`})`, "Put everything inside a single folder that contains manifest.json."));
  } else if (!staged.some((s) => s.name === `${rootName}/manifest.json`)) {
    // Exact name: `MANIFEST.JSON` would pass a case-insensitive comparison, but the rest of the system reads `manifest.json`.
    problems.push(issue("ZIP_BAD_ROOT", `${rootName}/manifest.json`, "manifest.json is missing from the root folder (exact name, lowercase)", "Put manifest.json directly in the package root folder."));
  }

  // A path that is both a file and a folder (`a/b` and `a/b/c.md`) cannot exist on disk: a clean error, not EISDIR/ENOTDIR.
  const fileKeys = new Set(staged.map((s) => s.name.toLowerCase()));
  const clash = new Set<string>();
  for (const s of staged) {
    const segs = s.name.split("/");
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join("/");
      if (fileKeys.has(prefix.toLowerCase())) clash.add(prefix);
    }
  }
  for (const p of clash) problems.push(issue("ZIP_BAD_PATH", p, "The same path appears as both a file and a folder", "Rename the file or the folder so they don't collide."));

  const items: Item[] = [];
  for (const s of staged) {
    const rel = s.name.slice(s.name.indexOf("/") + 1);
    if (!limits.allowedExtensions.includes(extOf(rel))) {
      problems.push(issue("FILE_TYPE_NOT_ALLOWED", rel, `File type not allowed (${extOf(rel) || "no extension"})`, "Use only .json, .md and .txt (convert PDF and HTML to .md)."));
    }
    if (s.declared > limits.fileBytes) {
      problems.push(issue("FILE_TOO_LARGE", rel, `File of ${s.declared} bytes exceeds the limit of ${limits.fileBytes}`, "Split the file into smaller parts."));
    }
    items.push({ entry: s.entry, rel, declared: s.declared });
  }
  if (problems.length) throw new ZipError(problems);
  return { items, rootName, warnings };
}

/** Why the ZIP path is unusable (or null): `..`, `\`, absolute, control character, leading dot, character outside the allowed list. */
function pathProblem(p: string): string | null {
  const why = relativePathProblem(p, [""]);
  if (why) return why;
  if (!/^[\p{L}\p{N}._\-/ ]+$/u.test(p)) return "contains a character other than letters, digits, . _ - and space";
  const segs = p.split("/");
  if (segs.some((s) => s.startsWith("."))) return "name starts with a dot";
  if (segs.some((s) => s.endsWith(" ") || s.endsWith("."))) return "name ends with a dot or space";
  return null;
}

async function extractItems(zf: yauzl.ZipFile, items: Item[], root: string, limits: ZipLimits): Promise<{ entries: PackageEntry[]; bytes: number }> {
  const out: PackageEntry[] = [];
  let total = 0;
  for (const it of items) {
    const dest = resolve(join(root, ...it.rel.split("/")));
    // Belt and braces: once resolved, the destination must be inside the root (the name was already checked).
    if (!dest.startsWith(root + sep)) throw new ZipError([issue("ZIP_BAD_PATH", it.rel, "Path escapes the package folder", "Rename the file.")]);
    await mkdir(dirname(dest), { recursive: true, mode: 0o750 });
    let size = 0;
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        total += chunk.length;
        if (total > limits.expandedBytes) return cb(new ZipError([issue("ZIP_EXPANDS_TOO_MUCH", it.rel, `The extracted content exceeded ${limits.expandedBytes} bytes`, "Reduce the size of the files.")]));
        if (size > limits.fileBytes) return cb(new ZipError([issue("FILE_TOO_LARGE", it.rel, `File exceeds ${limits.fileBytes} bytes`, "Split the file into smaller parts.")]));
        try {
          utf8.decode(chunk, { stream: true });
        } catch {
          return cb(new ZipError([issue("FILE_NOT_UTF8", it.rel, "The file is not valid UTF-8", "Save the file as UTF-8.")]));
        }
        cb(null, chunk);
      },
      flush(cb) {
        try {
          utf8.decode();
        } catch {
          return cb(new ZipError([issue("FILE_NOT_UTF8", it.rel, "The file is not valid UTF-8", "Save the file as UTF-8.")]));
        }
        cb();
      },
    });
    try {
      const src = await openEntry(zf, it.entry);
      await pipeline(src, counter, createWriteStream(dest, { flags: "wx", mode: 0o640 }));
    } catch (e) {
      if (e instanceof ZipError) throw e;
      // The detail (it may include a disk path) stays in the log; the creator gets a fixed text.
      console.error(`[zip] failed to extract ${it.rel}:`, (e as Error).message);
      throw new ZipError([issue("ZIP_UNREADABLE", it.rel, "Could not extract this file from the ZIP.", "Create the ZIP again.")]);
    }
    if (size !== it.declared) {
      // The header lied about the size: tampered or corrupted ZIP.
      throw new ZipError([issue(size > it.declared ? "ZIP_EXPANDS_TOO_MUCH" : "ZIP_UNREADABLE", it.rel, `The actual size (${size}) does not match the declared size (${it.declared})`, "Create the ZIP again.")]);
    }
    out.push({ path: it.rel, size });
  }
  return { entries: out, bytes: total };
}
