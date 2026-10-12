import { strict as assert } from "node:assert";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isKnowledgeFile, metaJsonPathFor, parseKnowledgeFile } from "../src/knowledge/file-rules.js";
import { trialFilesOnly } from "../src/knowledge/search-rules.js";
import { SKIP_WITHOUT_PAID } from "./helpers/repo-agents.js";

// Free trial regression: in a v1 package the trial's search_knowledge only sees the `knowledge/` files
// with `trial: true` (PACKAGE_SPEC.md 6.5 item 4). With no file marked, the trial search
// returns "Nothing relevant..." for any query, even with `trial.searches` > 0 in the manifest.
// Here, for each package in `agents/`: with a free trial and searches allowed, some files are unlocked, and they are a
// small part of the knowledge base (the demo shows value without handing over everything). No env or database: only reads the disk.

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agents");
/** Cap on the share of the knowledge base unlocked in the trial, in files and in chunks. */
const MAX_SHARE = 0.35;

type KFile = { source: string; chunks: number; trial: boolean };

function knowledgeFiles(root: string): KFile[] {
  const base = join(root, "knowledge");
  if (!existsSync(base) || !lstatSync(base).isDirectory()) return [];
  const out: KFile[] = [];
  const walk = (cur: string, rel: string[]) => {
    for (const name of readdirSync(cur).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = join(cur, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, [...rel, name]);
      else if (isKnowledgeFile(name)) {
        const metaPath = metaJsonPathFor(abs);
        const metaJson = /\.txt$/i.test(name) && existsSync(metaPath) ? readFileSync(metaPath, "utf8") : null;
        const parsed = parseKnowledgeFile(name, readFileSync(abs, "utf8"), metaJson);
        out.push({ source: ["knowledge", ...rel, name].join("/").split(sep).join("/"), chunks: parsed.chunks.length, trial: parsed.meta?.trial === true });
      }
    }
  };
  walk(base, []);
  return out;
}

type Loaded = { slug: string; specVersion: number; trialSearches: number; files: KFile[] };

function loadAll(): Loaded[] {
  const out: Loaded[] = [];
  for (const dir of readdirSync(AGENTS).sort()) {
    if (dir.startsWith("_") || dir.startsWith(".")) continue;
    const root = join(AGENTS, dir);
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { specVersion?: number; trial?: { available?: boolean; searches?: number } };
    const t = m.trial;
    const trialSearches = t && t.available !== false ? (t.searches ?? 0) : 0;
    out.push({ slug: dir, specVersion: m.specVersion ?? 0, trialSearches, files: knowledgeFiles(root) });
  }
  return out;
}

const packages = loadAll();

describe("free trial: unlocked knowledge in each package of agents/", () => {
  it("finds the packages (the check does not pass for lack of packages)", { skip: SKIP_WITHOUT_PAID }, () => {
    assert.ok(packages.length >= 6, `expected at least 6 packages in ${AGENTS}, found ${packages.length}`);
    assert.ok(packages.some((p) => p.specVersion === 1 && p.trialSearches > 0), "no v1 package with a free trial and searches");
  });

  for (const p of packages) {
    describe(p.slug, () => {
      const marked = p.files.filter((f) => f.trial);
      const gated = p.specVersion === 1 && p.trialSearches > 0 && p.files.length > 0;

      if (gated) {
        it("the free trial search is restricted to files with trial: true (v1 package)", () => {
          assert.equal(trialFilesOnly({ specVersion: p.specVersion, accessIsTrial: true }), true);
        });

        it("trial.searches > 0 and at least one knowledge file is unlocked in the trial", () => {
          assert.ok(marked.length > 0, `${p.slug}: trial.searches = ${p.trialSearches}, but no file in knowledge/ has "trial: true"; the free trial search would always return "Nothing relevant"`);
        });

        it(`unlocked files are at most ${MAX_SHARE * 100}% of the files`, () => {
          const share = marked.length / p.files.length;
          assert.ok(share <= MAX_SHARE, `${p.slug}: ${marked.length} of ${p.files.length} files unlocked (${Math.round(share * 100)}%)`);
        });

        it(`unlocked chunks are at most ${MAX_SHARE * 100}% of the chunks`, () => {
          const total = p.files.reduce((n, f) => n + f.chunks, 0);
          const free = marked.reduce((n, f) => n + f.chunks, 0);
          assert.ok(total > 0 && free / total <= MAX_SHARE, `${p.slug}: ${free} of ${total} chunks unlocked (${total ? Math.round((free / total) * 100) : 0}%)`);
        });
      } else {
        it("no trial with searches (or no knowledge, or a v0 package): no file marked", () => {
          assert.deepEqual(marked.map((f) => f.source), [], `${p.slug}: "trial: true" has no effect without a free trial with searches`);
        });
      }
    });
  }
});
