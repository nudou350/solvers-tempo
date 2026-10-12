import type { SubmissionFileEntry } from "@solvers/shared";
import type { PackageInput } from "../runtime/validate/index.js";
import { extOf, isTextPath, normalizeEol, reviewableEntries } from "./files.js";

// Diff of the package against the published version (PACKAGE_SPEC.md 14.5, item 3): status of ALL files (including
// knowledge) and a unified text diff, capped per file and in total so the screen never receives megabytes.
// Pure. Text comes out as text: the screen shows it escaped, never as HTML.

/** Cap on diff lines per file and for the whole package. */
export const DIFF_MAX_LINES_PER_FILE = 400;
export const DIFF_MAX_LINES_TOTAL = 2000;
/** Text files above this size are not diffed line by line. */
const DIFF_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Maximum edit distance for the algorithm (above it, the middle becomes "all removed, all added"). */
const MYERS_MAX_D = 1500;
const CONTEXT = 3;

export type ChangedFile = { path: string; unified: string; truncated: boolean };
export type PackageDiff = {
  files: SubmissionFileEntry[];
  /** Files with a diff (added, removed or changed), most important first: manifest, steps, templates... */
  changed: ChangedFile[];
  /** Some diff was cut by the per-file or total cap. */
  truncated: boolean;
};

type Op = { t: " " | "-" | "+"; s: string };

/** Line diff (Myers). Strips the common prefix and suffix first; past MYERS_MAX_D, it replaces the whole middle. */
export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: Op[] = a.slice(0, start).map((s) => ({ t: " ", s }));
  const tail: Op[] = a.slice(endA).map((s) => ({ t: " ", s }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid = midA.length === 0 ? midB.map((s): Op => ({ t: "+", s })) : midB.length === 0 ? midA.map((s): Op => ({ t: "-", s })) : (myers(midA, midB) ?? [...midA.map((s): Op => ({ t: "-", s })), ...midB.map((s): Op => ({ t: "+", s }))]);
  return [...head, ...mid, ...tail];
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MYERS_MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ t: " ", s: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ t: "+", s: b[prevY]! });
      else out.push({ t: "-", s: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** File lines: without the phantom empty line after the last "\n". */
const toLines = (s: string): string[] => {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Hunks in unified format (3 lines of context), without a file header. Empty if no line changed. */
export function unifiedHunks(ops: Op[]): string[] {
  const aBefore: number[] = [0];
  const bBefore: number[] = [0];
  for (const o of ops) {
    aBefore.push(aBefore[aBefore.length - 1]! + (o.t !== "+" ? 1 : 0));
    bBefore.push(bBefore[bBefore.length - 1]! + (o.t !== "-" ? 1 : 0));
  }
  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    let c = i;
    while (c < ops.length && ops[c]!.t === " ") c++;
    if (c >= ops.length) break;
    const from = Math.max(i, c - CONTEXT);
    let last = c;
    for (let j = c; j < ops.length; j++) {
      if (ops[j]!.t !== " ") last = j;
      else if (j - last > 2 * CONTEXT) break;
    }
    const to = Math.min(ops.length, last + CONTEXT + 1);
    const aCount = aBefore[to]! - aBefore[from]!;
    const bCount = bBefore[to]! - bBefore[from]!;
    const aStart = aCount === 0 ? aBefore[from]! : aBefore[from]! + 1;
    const bStart = bCount === 0 ? bBefore[from]! : bBefore[from]! + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let j = from; j < to; j++) out.push(`${ops[j]!.t}${ops[j]!.s}`);
    i = to;
  }
  return out;
}

/** Comparable text: CRLF normalized and, for valid JSON of reasonable size, indented (a minified manifest becomes a readable diff). */
function comparable(path: string, bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = normalizeEol(new TextDecoder("utf-8").decode(bytes));
  if (extOf(path) === ".json" && text.length <= 1024 * 1024) {
    try {
      return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    } catch {
      return text;
    }
  }
  return text;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

function rank(path: string): number {
  if (path === "manifest.json") return 0;
  if (path.startsWith("steps/")) return 1;
  if (path.startsWith("templates/")) return 2;
  if (path === "README.md") return 3;
  if (path.startsWith("evals/")) return 4;
  if (path.startsWith("knowledge/")) return 5;
  return 6;
}

/** Unified diff of one file (header + hunks), without the size cut. `null` on the missing side = new or removed file. */
function fileDiffLines(path: string, prev: Uint8Array | null, next: Uint8Array | null): { lines: string[] } {
  const header = [`--- ${prev ? `a/${path}` : "/dev/null"}`, `+++ ${next ? `b/${path}` : "/dev/null"}`];
  const big = Math.max(prev?.byteLength ?? 0, next?.byteLength ?? 0) > DIFF_MAX_FILE_BYTES;
  if (!isTextPath(path) || big) {
    const why = big ? `text file too large to diff (${Math.max(prev?.byteLength ?? 0, next?.byteLength ?? 0)} bytes)` : "binary file";
    const what = !prev ? "added" : !next ? "removed" : "changed";
    return { lines: [...header, `(${why}: ${what}; size ${prev?.byteLength ?? 0} -> ${next?.byteLength ?? 0} bytes)`] };
  }
  const a = prev ? comparable(path, prev) : "";
  const b = next ? comparable(path, next) : "";
  if (a === null || b === null) return { lines: [...header, "(binary content: not shown)"] };
  const hunks = unifiedHunks(diffLines(toLines(a), toLines(b)));
  if (hunks.length === 0) return { lines: [...header, "(no line differences: only whitespace or line breaks)"] };
  return { lines: [...header, ...hunks] };
}

/** Compares the new package with the published one (`prev` null = 1st version: everything "added"). */
export function diffPackages(prev: PackageInput | null, next: PackageInput): PackageDiff {
  const prevBytes = new Map<string, Uint8Array>();
  if (prev) for (const e of reviewableEntries(prev)) prevBytes.set(e.path, prev.read(e.path) ?? new Uint8Array());
  const nextBytes = new Map<string, Uint8Array>();
  for (const e of reviewableEntries(next)) nextBytes.set(e.path, next.read(e.path) ?? new Uint8Array());

  const paths = [...new Set([...prevBytes.keys(), ...nextBytes.keys()])].sort();
  const files: SubmissionFileEntry[] = [];
  const todo: { path: string; prev: Uint8Array | null; next: Uint8Array | null }[] = [];
  for (const path of paths) {
    const p = prevBytes.get(path) ?? null;
    const n = nextBytes.get(path) ?? null;
    let diff: SubmissionFileEntry["diff"];
    if (!p) diff = "added";
    else if (!n) diff = "removed";
    else if (sameBytes(p, n) || (/\.(md|json|txt)$/.test(path) && comparableEqual(p, n))) diff = "same";
    else diff = "changed";
    files.push({ path, size: (n ?? p)!.byteLength, diff });
    if (diff !== "same") todo.push({ path, prev: p, next: n });
  }

  todo.sort((x, y) => rank(x.path) - rank(y.path) || (x.path < y.path ? -1 : 1));
  const changed: ChangedFile[] = [];
  let remaining = DIFF_MAX_LINES_TOTAL;
  let truncated = false;
  for (const t of todo) {
    if (remaining <= 0) {
      changed.push({ path: t.path, unified: `(omitted: the package diff exceeded the ${DIFF_MAX_LINES_TOTAL}-line cap)`, truncated: true });
      truncated = true;
      continue;
    }
    const { lines } = fileDiffLines(t.path, t.prev, t.next);
    const budget = Math.min(DIFF_MAX_LINES_PER_FILE, remaining);
    if (lines.length > budget) {
      const omitted = lines.length - budget;
      changed.push({ path: t.path, unified: [...lines.slice(0, budget), `… diff truncated: ${omitted} more line(s) not shown`].join("\n"), truncated: true });
      remaining -= budget;
      truncated = true;
    } else {
      changed.push({ path: t.path, unified: lines.join("\n"), truncated: false });
      remaining -= lines.length;
    }
  }
  return { files, changed, truncated };
}

/** Text equal except for CRLF/LF (the package hash already treats both as the same content). */
function comparableEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.includes(0) || b.includes(0)) return false;
  const dec = new TextDecoder("utf-8");
  return normalizeEol(dec.decode(a)) === normalizeEol(dec.decode(b));
}
