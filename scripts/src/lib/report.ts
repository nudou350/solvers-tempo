// PASS/FAIL harness of the e2e scripts: named checks, tx evidence (explorer links) and a summary with the exit code.

export type CheckResult = { name: string; ok: boolean; detail: string; ms: number };

/** Throws with `message` when `cond` is falsy. */
export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const js = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

/** Deep equality through JSON (bigints kept). */
export function assertEq(got: unknown, want: unknown, what: string): void {
  if (js(got) !== js(want)) throw new Error(`${what}: expected ${js(want)}, got ${js(got)}`);
}

/** Skipped checks fail the run unless E2E_ALLOW_SKIP=1 (a skipped check proves nothing). */
export const allowSkip = (): boolean => process.env.E2E_ALLOW_SKIP === "1";

export class Report {
  readonly results: CheckResult[] = [];
  readonly skipped: { name: string; why: string }[] = [];
  readonly txs: { label: string; hash: string; link: string }[] = [];
  private explorer: (hash: string) => string = (h) => h;

  constructor(readonly title: string) {
    console.log(`\n=== ${title} ===`);
  }

  setExplorer(fn: (hash: string) => string): void {
    this.explorer = fn;
  }

  /** Records a transaction as evidence (printed now and in the summary). */
  tx(label: string, hash: string | null | undefined): void {
    if (!hash) return;
    const link = this.explorer(hash);
    this.txs.push({ label, hash, link });
    console.log(`        tx  ${label}: ${link}`);
  }

  /**
   * Runs one named check. A failing check is recorded and, with `critical` (default), stops the script (later checks
   * depend on it); a non-critical failure is recorded and the script goes on. The detail printed next to PASS is the
   * text given to `note`, else the returned value when it is a string.
   */
  async step<T>(name: string, fn: (note: (text: string) => void) => Promise<T>, o: { critical?: boolean } = {}): Promise<T | undefined> {
    const t0 = Date.now();
    let noted = "";
    try {
      const value = await fn((text) => {
        noted = text;
      });
      const detail = noted || (typeof value === "string" ? value : "");
      this.results.push({ name, ok: true, detail, ms: Date.now() - t0 });
      console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`);
      return value;
    } catch (e) {
      const detail = ((e as Error)?.message ?? String(e)).slice(0, 1500);
      this.results.push({ name, ok: false, detail, ms: Date.now() - t0 });
      console.log(`  FAIL  ${name}\n        ${detail.replace(/\n/g, "\n        ")}`);
      if (o.critical ?? true) throw new StopRun(name);
      return undefined;
    }
  }

  /**
   * Skipped check (prerequisite missing): printed and counted apart from passes. Any skip fails the run unless
   * E2E_ALLOW_SKIP=1, so a server without the prerequisite never "passes" a check it did not run.
   */
  skip(name: string, why: string): void {
    this.skipped.push({ name, why });
    console.log(`  SKIP  ${name}  (${why})`);
  }

  get failed(): CheckResult[] {
    return this.results.filter((r) => !r.ok);
  }

  /** Prints the summary and sets the exit code (1 on any failure, an aborted run, or a skip without E2E_ALLOW_SKIP=1). */
  finish(error?: unknown): never {
    if (error && !(error instanceof StopRun)) {
      this.results.push({ name: "unexpected error", ok: false, detail: String((error as Error)?.stack ?? error).slice(0, 2000), ms: 0 });
      console.log(`  FAIL  unexpected error\n        ${String((error as Error)?.stack ?? error)}`);
    }
    const failed = this.failed;
    const passed = this.results.length - failed.length;
    const skips = this.skipped.length;
    const ok = failed.length === 0 && (skips === 0 || allowSkip());
    const skipNote = skips ? `, ${skips} skipped${allowSkip() ? " (allowed by E2E_ALLOW_SKIP=1)" : " (fails the run; E2E_ALLOW_SKIP=1 allows it)"}` : "";
    console.log(`\n--- ${this.title}: ${ok ? "PASS" : "FAIL"} (${passed}/${this.results.length} checks passed${skipNote}) ---`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.detail.split("\n")[0]}`);
    for (const s of this.skipped) console.log(`  SKIPPED: ${s.name}: ${s.why}`);
    if (this.txs.length) {
      console.log("  transactions:");
      for (const t of this.txs) console.log(`    ${t.label}: ${t.link}`);
    }
    process.exit(ok ? 0 : 1);
  }
}

/** Thrown by a failing critical step to stop the run (already recorded). */
export class StopRun extends Error {
  constructor(step: string) {
    super(`stopped after the failing step: ${step}`);
  }
}

/** Runs `main(report)` and always ends with the summary. */
export async function run(title: string, main: (r: Report) => Promise<void>): Promise<never> {
  const r = new Report(title);
  try {
    await main(r);
  } catch (e) {
    return r.finish(e);
  }
  return r.finish();
}
