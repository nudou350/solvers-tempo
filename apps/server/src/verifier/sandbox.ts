import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { env } from "../env.js";
import { badRequest } from "../lib/http.js";
import { randomId } from "../lib/crypto.js";
import { evaluateReport, PREVIEW_TEST_FILE, type Files, type RunResult } from "./report.js";
import { describeReadFailure, dirUsage, readRegularFile, readRegularJson } from "./safe-read.js";

// Guarantee verifier (INSTRUCTIONS.md 5.7): runs the delivery against the acceptance suite agreed
// when the guarantee was created, in a disposable container (no network, limited CPU/memory,
// no privileges, read-only rootfs, a timeout that kills the container). One test at a time (queue).
// It also captures a static HTML preview of the component (no source code).
// Everything that comes back from the container (report and preview) is UNTRUSTED: read only via safe-read.ts.

export type { Files, RunResult, TestReport } from "./report.js";

const ALLOWED_EXT = /\.(tsx?|jsx?|css|json|md)$/;
const RESERVED = /^(acceptance\.|__preview__)/;
const MAX_TOTAL_BYTES = 300_000;
const MAX_FILES = 40;
const MAX_OUTPUT = 200_000;
const TIMEOUT_MS = 60_000;
/** Caps on the files that come back from the container and on what it may write to the report. */
const MAX_JSON_BYTES = 2_000_000;
const MAX_PREVIEW_BYTES = 400_000;
const MAX_REPORT_DIR_BYTES = 8_000_000;
const MAX_REPORT_DIR_ENTRIES = 500;
const WATCH_MS = 1_000;

function normalizeName(name: string): string {
  const norm = posix.normalize(name.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (norm.startsWith("..") || norm.includes("/../") || !ALLOWED_EXT.test(norm)) throw badRequest(`File not allowed: ${name}`);
  return norm;
}

/** Validates names (no ../, no absolute path, no reserved names) and the delivery size. */
export function sanitizeFiles(files: Files): Files {
  const entries = Object.entries(files);
  if (entries.length === 0) throw badRequest("Delivery has no files");
  if (entries.length > MAX_FILES) throw badRequest(`At most ${MAX_FILES} files per delivery`);
  let total = 0;
  const out: Files = {};
  for (const [name, content] of entries) {
    const norm = normalizeName(name);
    if (RESERVED.test(posix.basename(norm))) throw badRequest(`Name reserved for the acceptance test suite: ${name}`);
    total += Buffer.byteLength(content);
    out[norm] = content;
  }
  if (total > MAX_TOTAL_BYTES) throw badRequest("Delivery too large (max. 300 KB)");
  return out;
}

/** Acceptance suite: test files only, written as acceptance.<name> at the root of src. */
export function sanitizeAcceptance(files: Files): Files {
  const out: Files = {};
  for (const [name, content] of Object.entries(files)) {
    const norm = normalizeName(name);
    if (!/\.test\.(tsx?|jsx?)$/.test(norm) || norm.includes("/")) throw badRequest(`Invalid acceptance test: ${name} (use Name.test.tsx)`);
    out[`acceptance.${norm}`] = content;
  }
  if (Object.keys(out).length === 0) throw badRequest("Acceptance test suite is empty");
  return out;
}

export function writeFiles(dir: string, files: Files) {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Main component of the delivery (first .tsx/.jsx that is not a test and exports something). */
export function entryComponent(files: Files): string | null {
  const entry = Object.entries(files).find(
    ([n, c]) => /\.(tsx|jsx)$/.test(n) && !/\.test\./.test(n) && /export\s+(default\s+)?(function|const)\s+[A-Z]/.test(c),
  );
  return entry ? entry[0] : null;
}

/**
 * Helper test that renders the component and writes the static HTML for the preview. It never fails:
 * the server requires exit code 0 from vitest, and the preview is optional (a component that needs
 * other props, or that fails to import, simply gets no preview).
 */
function previewTest(entry: string): string {
  const mod = `./${entry.replace(/\.(tsx|jsx)$/, "")}`;
  return `import { render } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { it } from "vitest";
it("__preview__", async () => {
  try {
    const all = (await import(${JSON.stringify(mod)})) as Record<string, unknown>;
    const C = (all.default ?? Object.values(all).find((v) => typeof v === "function" && /^[A-Z]/.test((v as { name: string }).name))) as never;
    if (!C) return;
    const { container } = render(<C {...({ onSubmit: () => {} } as object)} />);
    writeFileSync("/work/report/preview.html", container.innerHTML);
  } catch {
    // no preview
  }
});
`;
}

let queue: Promise<unknown> = Promise.resolve();

/** Queues work so one test runs at a time (small VPS). */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function docker(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const append = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString().slice(0, MAX_OUTPUT - out.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => res({ code: code ?? 1, out }));
    child.on("error", (e) => res({ code: 127, out: String(e) }));
  });
}

/** Removes scripts, handlers and javascript: URLs from the captured HTML (the preview runs nothing). */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "")
    .slice(0, 200_000);
}

function simulate(files: Files, acceptance: Files | null): RunResult {
  const tests = Object.keys({ ...files, ...(acceptance ?? {}) }).filter((n) => /\.test\.(tsx?|jsx?)$/.test(n));
  const all = { ...files, ...(acceptance ?? {}) };
  const count = tests.reduce((acc, t) => acc + (all[t]!.match(/\b(it|test)\(/g)?.length ?? 0), 0);
  const accCount = acceptance ? Object.values(acceptance).reduce((a, c) => a + (c.match(/\b(it|test)\(/g)?.length ?? 0), 0) : 0;
  const passed = count > 0 && entryComponent(files) != null;
  return {
    report: {
      passed,
      mode: "simulated",
      numTests: count,
      numPassed: passed ? count : 0,
      numFailed: passed ? 0 : 1,
      acceptance: acceptance ? { numTests: accCount, numPassed: passed ? accCount : 0 } : null,
      failures: passed ? [] : [{ test: "structure", message: "The delivery needs a component and tests (*.test.tsx)." }],
      durationMs: 0,
    },
    previewHtml: null,
  };
}

/** Deletes the run folder. The container may have left folders without permissions: cleans up from inside it. */
async function cleanup(base: string, report: string, image: string) {
  try {
    rmSync(base, { recursive: true, force: true });
    return;
  } catch {
    /* fall through to cleanup via the container */
  }
  try {
    await docker([
      "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--user", "node",
      "-v", `${report}:/work/report`, image,
      "sh", "-c", "rm -rf /work/report/* /work/report/.[!.]* 2>/dev/null; true",
    ]);
    rmSync(base, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[verifier] could not delete ${base}:`, (e as Error).message);
  }
}

export async function runTests(rawFiles: Files, opts: { acceptance?: Files | null; image?: string } = {}): Promise<RunResult> {
  const files = sanitizeFiles(rawFiles);
  const acceptance = opts.acceptance ?? null;
  if (env.VERIFIER_MODE === "simulated") return simulate(files, acceptance);
  const image = opts.image ?? env.VERIFIER_IMAGE;
  return enqueue(async () => {
    const id = randomId(8);
    const base = resolve(env.DELIVERABLES_DIR, "runs", id);
    const src = join(base, "src");
    const report = join(base, "report");
    const name = `solvers-verify-${id}`;
    const t0 = Date.now();
    let timedOut = false;
    let overflow = false;
    let timer: NodeJS.Timeout | undefined;
    let watch: NodeJS.Timeout | undefined;
    const kill = () => void docker(["kill", name]);
    // Everything that creates the run folder stays inside the try: any error here also deletes runs/<id>.
    try {
      mkdirSync(report, { recursive: true });
      // The container runs as "node" (uid 1000), which does not own the folder (the server user does):
      // without this vitest cannot write the report. The folder belongs to this run only and is deleted at the end.
      // What the container leaves here is UNTRUSTED (symlink, FIFO, huge file): see safe-read.ts.
      chmodSync(report, 0o777);
      writeFiles(src, { ...files, ...(acceptance ?? {}) });
      const entry = entryComponent(files);
      if (entry) writeFiles(src, { [PREVIEW_TEST_FILE]: previewTest(entry) });
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, TIMEOUT_MS);
      // Report size watchdog: the container writes straight into a host folder.
      watch = setInterval(() => {
        const u = dirUsage(report, MAX_REPORT_DIR_ENTRIES);
        if (!overflow && (u.truncated || u.bytes > MAX_REPORT_DIR_BYTES)) {
          overflow = true;
          kill();
        }
      }, WATCH_MS);
      const r = await docker([
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--cpus",
        "1",
        "--memory",
        "768m",
        "--pids-limit",
        "256",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        // Read-only rootfs: the delivery's code cannot tamper with vitest or node_modules.
        // Only /tmp (capped tmpfs; vitest's cacheDir points there) and /work/report are writable.
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        // Vite writes the bundled config here (node_modules/.vite-temp); with a read-only rootfs it needs a tmpfs.
        "--tmpfs",
        "/work/node_modules/.vite-temp:rw,size=16m",
        "--env",
        "HOME=/tmp",
        // No created file may exceed 8 MB (the watchdog above covers the folder total).
        "--ulimit",
        "fsize=8000000:8000000",
        "--user",
        "node",
        "-v",
        `${src}:/work/src:ro`,
        "-v",
        `${report}:/work/report`,
        image,
        "npx",
        "--no-install",
        "vitest",
        "run",
        "--reporter=json",
        "--outputFile.json=/work/report/vitest.json",
      ]);
      clearInterval(watch);
      const read = readRegularJson(join(report, "vitest.json"), MAX_JSON_BYTES);
      const testReport = evaluateReport({
        json: read.ok ? read.value : null,
        jsonProblem: read.ok ? undefined : describeReadFailure("The test report", read),
        exitCode: r.code,
        timedOut,
        overflow,
        out: r.out,
        acceptanceFiles: acceptance ? Object.keys(acceptance) : null,
        durationMs: Date.now() - t0,
      });
      let previewHtml: string | null = null;
      if (testReport.passed) {
        const p = readRegularFile(join(report, "preview.html"), MAX_PREVIEW_BYTES);
        if (p.ok) previewHtml = sanitizeHtml(p.data.toString("utf8"));
      }
      return { report: testReport, previewHtml };
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
      await cleanup(base, report, image);
    }
  });
}
