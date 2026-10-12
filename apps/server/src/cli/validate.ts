import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePackage, type Issue, type ValidateOptions } from "../runtime/validate/index.js";
import { packageFromFolder } from "../runtime/validate/input.js";
import { extractZip, NUCLEO_ZIP_LIMITS, ZipError } from "../submissions/zip.js";

// Validates Solver packages on disk (PACKAGE_SPEC.md 13). No database, network or env.
//
//   npm run cli:validate -- ../../agents/financas-pessoais          # one package (folder)
//   npm run cli:validate -- my-package.zip                          # a ZIP: extracted with the upload rules (§3.2) and validated as third party
//   npm run cli:validate -- --all ../../agents                      # every folder with a manifest.json
//   npm run cli:validate -- --third-party --phase abertura <folder> # third-party rules (Núcleo by default)
//   npm run cli:validate -- --platform my-package.zip               # ZIP validated with the platform rules
//   npm run cli:validate -- --json <folder or zip>                  # machine-readable output
//
// Exits with code 1 if there is an error (warnings do not fail). A ZIP is extracted into a temporary folder (nothing is executed) that is deleted at the end.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--phase" && args[i - 1] !== "--min-price");

if (positional.length === 0) {
  console.error("usage: cli:validate [--all] [--third-party|--platform] [--phase nucleo|abertura] [--min-price N] [--json] <folder or .zip>");
  process.exit(2);
}

const target = resolve(positional[0]!);
const isZip = existsSync(target) && statSync(target).isFile() && /\.zip$/i.test(target);

const options: ValidateOptions = {
  // A ZIP is a submission: third-party rules apply unless --platform is passed.
  origin: flag("--third-party") || (isZip && !flag("--platform")) ? "third_party" : "platform",
  phase: opt("--phase") === "abertura" ? "abertura" : "nucleo",
  minPriceUsdc: opt("--min-price") ? Number(opt("--min-price")) : undefined,
};

const fmt = (i: { code: string; path: string; message: string; fix: string }) => `    ${i.code} ${i.path}\n      ${i.message}\n      → ${i.fix}`;

let tmp: string | undefined;
const cleanup = () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
};

let dirs: string[];
const zipWarnings: Issue[] = [];
if (isZip) {
  tmp = mkdtempSync(join(tmpdir(), "solvers-validate-"));
  try {
    const out = await extractZip(target, join(tmp, "pkg"), NUCLEO_ZIP_LIMITS);
    options.archive = { zipBytes: out.zipBytes, expandedBytes: out.expandedBytes, roots: 1 };
    zipWarnings.push(...(out.warnings as Issue[]));
    dirs = [out.root];
  } catch (e) {
    cleanup();
    if (!(e instanceof ZipError)) throw e;
    if (flag("--json")) console.log(JSON.stringify({ ok: false, errors: e.issues, warnings: [] }, null, 2));
    else console.log(`✘ ${target}\n  ${e.issues.length} error(s) in the ZIP:\n${e.issues.map(fmt).join("\n")}`);
    process.exit(1);
  }
} else {
  dirs = flag("--all")
    ? readdirSync(target)
        .map((n) => join(target, n))
        .filter((d) => existsSync(join(d, "manifest.json")))
    : [target];
}

let failed = 0;
const json: Record<string, unknown> = {};
for (const dir of dirs) {
  const r = validatePackage(packageFromFolder(dir), options);
  for (const w of zipWarnings) r.warnings.push(w);
  if (!r.ok) failed += 1;
  json[dir] = r;
  if (flag("--json")) continue;
  const name = isZip ? target.split(/[\\/]/).pop() : dir.split(/[\\/]/).pop();
  console.log(`${r.ok ? "✔" : "✘"} ${name}  (v${r.stats.specVersion}; ${r.stats.steps} steps, ${r.stats.knowledgeFiles} knowledge files ≈ ${r.stats.knowledgeChunksEstimate} chunks, ${r.stats.cases} cases; differentiators: ${r.stats.differentiators.join(", ") || "none"})`);
  if (r.errors.length) console.log(`  ${r.errors.length} error(s):\n${r.errors.map(fmt).join("\n")}`);
  if (r.warnings.length) console.log(`  ${r.warnings.length} warning(s):\n${r.warnings.map(fmt).join("\n")}`);
}
if (flag("--json")) console.log(JSON.stringify(dirs.length === 1 ? json[dirs[0]!] : json, null, 2));
cleanup();
process.exit(failed ? 1 : 0);
