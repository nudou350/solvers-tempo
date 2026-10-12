// Summary of a browser e2e run: PASS/FAIL per test, what each one checked outside the screen and every transaction
// with its explorer link. Written to report/summary.json and report/summary.md and printed at the end of the run.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import type { TxEvidence } from "./fixtures.js";

type Row = { title: string; project: string; status: string; ms: number; checked: string[]; txs: TxEvidence[]; error: string | null };

const OUT_DIR = join(import.meta.dirname, "..", "report");

export default class SummaryReporter implements Reporter {
  private rows = new Map<string, Row>();

  /** Every planned test gets a row up front: a test that never ran (interrupted, failed dependency) shows as NOT RUN. */
  onBegin(_config: FullConfig, suite: Suite): void {
    for (const t of suite.allTests()) {
      this.rows.set(t.id, { title: t.titlePath().slice(2).join(" › "), project: t.parent.project()?.name ?? "", status: "NOT RUN", ms: 0, checked: [], txs: [], error: null });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Runtime annotations (testInfo.annotations) land in the result; the test case only adds the declared ones.
    const ann = result.annotations.length ? result.annotations : test.annotations;
    // Retries replace the earlier attempt of the same test.
    this.rows.set(test.id, {
      title: test.titlePath().slice(2).join(" › "),
      project: test.parent.project()?.name ?? "",
      // outcome() honours test.fail() and retries; "flaky" (passed on a retry) is reported as such, never as a plain PASS.
      status: { expected: "PASS", flaky: "FLAKY", skipped: "SKIP", unexpected: "FAIL" }[test.outcome()],
      ms: result.duration,
      checked: ann.filter((a) => a.type === "checked").map((a) => a.description ?? ""),
      txs: ann.filter((a) => a.type === "tx").map((a) => JSON.parse(a.description ?? "{}") as TxEvidence),
      error: result.error?.message?.split("\n").slice(0, 6).join("\n") ?? null,
    });
  }

  onEnd(result: FullResult): void {
    const rows = [...this.rows.values()];
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify({ status: result.status, finishedAt: new Date().toISOString(), tests: rows }, null, 2));
    writeFileSync(join(OUT_DIR, "summary.md"), markdown(rows, result.status));
    console.log(`\n${text(rows, result.status)}`);
  }

  printsToStdio(): boolean {
    return true;
  }
}

const link = (t: TxEvidence) => t.link ?? `${t.hash} (local chain, no explorer)`;

function text(rows: Row[], status: string): string {
  const out = [`=== Browser e2e summary: ${status.toUpperCase()} (${rows.filter((r) => r.status === "PASS").length}/${rows.length} passed) ===`];
  for (const r of rows) {
    out.push(`${r.status.padEnd(4)}  [${r.project}] ${r.title}  (${(r.ms / 1000).toFixed(1)} s)`);
    for (const c of r.checked) out.push(`        checked: ${c}`);
    for (const t of r.txs) out.push(`        tx ${t.chain} ${t.label}: ${link(t)}`);
    if (r.error) out.push(`        error: ${r.error.replace(/\n/g, "\n               ")}`);
  }
  out.push(`(report/summary.md, HTML report: npx playwright show-report report/html)`);
  return out.join("\n");
}

function markdown(rows: Row[], status: string): string {
  const out = [`# Browser e2e: ${status.toUpperCase()}`, "", `| Result | Test | Checked outside the screen | Transactions |`, `|---|---|---|---|`];
  for (const r of rows) {
    const txs = r.txs.map((t) => (t.link ? `[${t.chain}: ${t.label}](${t.link})` : `${t.chain}: ${t.label} \`${t.hash}\``)).join("<br>");
    out.push(`| ${r.status} | [${r.project}] ${r.title} | ${r.checked.join("<br>")} | ${txs} |`);
  }
  return `${out.join("\n")}\n`;
}
