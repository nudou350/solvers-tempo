// Grader of the Solver evals: applies the checks of agents/<slug>/evals/cases/*.json to the answers saved in
// evals/outputs/<id>.md and writes evals/report.json (the score `cli:publish` records on-chain with `setEval`, labelled
// "internal team test", never "verified"). No model and no API key: the answers are generated beforehand with the
// Solver active; evals/outputs/meta.json says how ({ model, method, generatedAt }).
//
//   npx tsx src/eval.ts                     # every package with saved outputs
//   npx tsx src/eval.ts frontend-react      # only some
//
// A case passes only if every check passes. The report does not depend on the grading time: grading again without
// changes writes the same file (and the same hash). Packages with cases but no saved outputs are listed as skipped.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gradeOutput, type Check } from "./lib/eval-rules.js";

type Case = { id: string; input: string; checks: Check[] };
type Meta = { model: string; method: string; generatedAt: string };

const AGENTS = resolve(import.meta.dirname, "../../agents");

function grade(slug: string) {
  const dir = join(AGENTS, slug);
  const casesDir = join(dir, "evals", "cases");
  const outDir = join(dir, "evals", "outputs");
  const meta = JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8")) as Meta;
  const { version } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string };

  const cases = readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as Case);
  const results = cases.map((c) => {
    const outPath = join(outDir, `${c.id}.md`);
    if (!existsSync(outPath)) return { id: c.id, passed: false, failed: ["no saved answer"] };
    const failed = gradeOutput(c.checks, readFileSync(outPath, "utf8"));
    return { id: c.id, passed: failed.length === 0, failed };
  });
  const passed = results.filter((r) => r.passed).length;
  const report = {
    version,
    cases: cases.length,
    passed,
    scoreBps: cases.length ? Math.round((passed / cases.length) * 10000) : 0,
    runAt: meta.generatedAt,
    model: meta.model,
    method: meta.method,
    results,
  };
  writeFileSync(join(dir, "evals", "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const wanted = process.argv.slice(2);
const slugs = readdirSync(AGENTS).filter((s) => existsSync(join(AGENTS, s, "evals", "cases")) && (wanted.length === 0 || wanted.includes(s)));
if (slugs.length === 0) throw new Error(`no package with evals/cases: ${wanted.join(", ")}`);
let failedAny = false;
for (const slug of slugs) {
  if (!existsSync(join(AGENTS, slug, "evals", "outputs", "meta.json"))) {
    console.log(`${slug}: skipped (no saved outputs in evals/outputs; generate the answers with the Solver active first)`);
    if (wanted.includes(slug)) failedAny = true;
    continue;
  }
  try {
    const r = grade(slug);
    console.log(`${slug}: ${r.passed}/${r.cases} (${r.scoreBps / 100}%)`);
    for (const x of r.results.filter((x) => !x.passed)) console.log(`  x ${x.id}: ${x.failed.join("; ")}`);
  } catch (e) {
    failedAny = true;
    console.error(`${slug}: ${(e as Error).message}`);
  }
}
if (failedAny) process.exitCode = 1;
