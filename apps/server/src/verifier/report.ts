// Verifier report types and validation. No env/DB/Docker: unit-testable.
//
// The vitest JSON report is written inside the container, next to untrusted code. So it is only
// accepted if (1) the container exited normally with code 0, (2) every file of the expected
// acceptance suite appears in the report, with tests and all of them passing, and (3) nothing was skipped.

export type Files = Record<string, string>;

export type TestReport = {
  passed: boolean;
  mode: "docker" | "simulated" | "manual";
  numTests: number;
  numPassed: number;
  numFailed: number;
  /** Tests from the (fixed) acceptance suite versus tests that came with the delivery. */
  acceptance: { numTests: number; numPassed: number } | null;
  failures: { test: string; message: string }[];
  durationMs: number;
  log?: string;
};

export type RunResult = { report: TestReport; previewHtml: string | null };

/** Delivery folder inside the container (vitest root: /work). */
export const CONTAINER_WORK = "/work";
export const PREVIEW_TEST_FILE = "__preview__.test.tsx";

type VitestAssertion = { fullName?: unknown; title?: unknown; status?: unknown; failureMessages?: unknown };
type VitestFile = { name?: unknown; status?: unknown; message?: unknown; assertionResults?: unknown };
type VitestJson = { success?: unknown; testResults?: unknown };

export type EvalInput = {
  /** Vitest JSON, already read safely (null if missing/invalid). */
  json: unknown | null;
  /** Why there is no usable JSON (goes into the execution failure). */
  jsonProblem?: string;
  exitCode: number;
  timedOut?: boolean;
  /** The container exceeded the report disk limit and was killed. */
  overflow?: boolean;
  /** Tail of the container output (diagnostics). */
  out: string;
  /** Names (already written to src/) of the expected acceptance suite files; null = no suite. */
  acceptanceFiles: string[] | null;
  durationMs: number;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Test file path relative to the vitest root (`src/X.test.tsx`), comparable by exact equality. */
export function relTestPath(name: string): string {
  return name.startsWith(`${CONTAINER_WORK}/`) ? name.slice(CONTAINER_WORK.length + 1) : name;
}

export function evaluateReport(i: EvalInput): TestReport {
  const base = { mode: "docker" as const, durationMs: i.durationMs };
  const tail = i.out.slice(-1500);

  const execFailure = (message: string): TestReport => ({
    ...base,
    passed: false,
    numTests: 0,
    numPassed: 0,
    numFailed: 0,
    acceptance: i.acceptanceFiles ? { numTests: 0, numPassed: 0 } : null,
    failures: [{ test: "execution", message: message.slice(0, 1500) }],
    log: i.out.slice(-2000) || undefined,
  });

  if (i.timedOut) return execFailure("The check exceeded the time limit and was stopped.");
  if (i.overflow) return execFailure("The run produced too many files in the report and was stopped.");
  const json = i.json;
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    return execFailure(i.jsonProblem ?? (tail || "No test report"));
  }

  const files = Array.isArray((json as VitestJson).testResults) ? ((json as VitestJson).testResults as VitestFile[]) : [];
  const previewPath = `src/${PREVIEW_TEST_FILE}`;
  const expected = new Set((i.acceptanceFiles ?? []).map((f) => `src/${f}`));

  type Row = { file: string; name: string; ok: boolean; msg: string };
  const rows: Row[] = [];
  const failures: { test: string; message: string }[] = [];
  const seenExpected = new Map<string, { assertions: number }>();

  for (const fr of files) {
    if (fr == null || typeof fr !== "object") continue;
    const file = relTestPath(str(fr.name));
    if (file === previewPath) continue; // server helper test, does not count
    const assertions = Array.isArray(fr.assertionResults) ? (fr.assertionResults as VitestAssertion[]) : [];
    let anyFailed = false;
    for (const a of assertions) {
      const ok = a?.status === "passed";
      if (!ok) anyFailed = true;
      const msgs = Array.isArray(a?.failureMessages) ? (a.failureMessages as unknown[]).map((m) => str(m)).join("\n") : "";
      rows.push({ file, name: str(a?.fullName) || str(a?.title) || "test", ok, msg: msgs });
    }
    // File that didn't even load (import/syntax error): vitest marks the file as failed, with no tests.
    if (str(fr.status) === "failed" && !anyFailed) {
      failures.push({ test: file, message: (str(fr.message) || "The test file failed to load.").slice(0, 800) });
    }
    if (expected.has(file)) seenExpected.set(file, { assertions: assertions.length });
  }

  for (const r of rows) if (!r.ok) failures.push({ test: r.name, message: r.msg.slice(0, 800) });

  // Acceptance suite: every expected file must have run, with tests, all of them passing.
  let accOk = true;
  for (const f of expected) {
    const seen = seenExpected.get(f);
    if (!seen || seen.assertions === 0) {
      accOk = false;
      failures.push({ test: f.replace(/^src\//, ""), message: "The acceptance test file didn't run or has no tests." });
    } else if (rows.some((r) => r.file === f && !r.ok)) {
      accOk = false;
    }
  }
  const acc = rows.filter((r) => expected.has(r.file));

  // Only reports the exit code when no test explains the failure (e.g. an unhandled error after the tests).
  if (i.exitCode !== 0 && failures.length === 0) {
    failures.push({ test: "execution", message: `Vitest exited with code ${i.exitCode}.${tail ? ` ${tail}` : ""}`.slice(0, 1500) });
  }
  if ((json as VitestJson).success === false && failures.length === 0) {
    failures.push({ test: "execution", message: "Vitest reported the run as unsuccessful." });
  }

  const numPassed = rows.filter((r) => r.ok).length;
  return {
    ...base,
    passed: i.exitCode === 0 && rows.length > 0 && failures.length === 0 && accOk,
    numTests: rows.length,
    numPassed,
    numFailed: rows.length - numPassed,
    acceptance: i.acceptanceFiles ? { numTests: acc.length, numPassed: acc.filter((r) => r.ok).length } : null,
    failures,
    log: undefined,
  };
}

// ---------- On-chain state of the step before mark_passed ----------

export const MILESTONE_PENDING = 0;
export const MILESTONE_PASSED = 1;

export type ChainMilestone = { status: number; deliverableHash: string } | null;

/**
 * Decides what to do with mark_passed (irreversible on-chain):
 * - send: step pending (or on-chain state unknown): send it;
 * - already: already Passed with the SAME hash (a previous send that died midway): don't resend;
 * - conflict: already Passed with another hash, or in another state: this delivery can't be marked.
 */
export function planMarkPassed(state: ChainMilestone, hashHex: string): "send" | "already" | "conflict" {
  if (!state) return "send";
  if (state.status === MILESTONE_PENDING) return "send";
  if (state.status === MILESTONE_PASSED && state.deliverableHash.toLowerCase() === hashHex.toLowerCase()) return "already";
  return "conflict";
}
