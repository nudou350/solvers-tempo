import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Package cache: the API must not serve the old manifest/version after ANOTHER process (cli:approve, worker) swaps the
// published folder. The directories come from the environment (env.ts reads them on the first import), so this file only imports
// the runtime after pointing AGENTS_DIR and PUBLISHED_DIR at temporary folders (which is why it is separate from creator-fixes.test.ts).

describe("package cache: getPackage reloads after a publication by another process", () => {
  let root: string;
  const ID = "0123456789abcdef0123456789abcdef";
  const manifest = (version: string) => ({
    id: ID,
    slug: "troca-solver",
    name: "Troca",
    tagline: "Frase",
    description: "Descrição",
    category: "Outros",
    version,
    creator: { id: "c", name: "Criador", bio: "Bio" },
    requirements: [],
    packageContents: [],
    steps: [{ file: "steps/01-primeira.md", gate: [] }],
    pricing: { priceUsdc: 5, royaltyBps: 0 },
    guarantee: { available: false, defaultCriteria: [] },
  });
  const publish = (version: string) => {
    const dir = join(root, "published", "troca-solver");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "steps"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(version)));
    writeFileSync(join(dir, "steps", "01-primeira.md"), "# Etapa 1\n\nFaça.");
    const when = new Date(Date.now() + Number(version.split(".")[1]) * 10_000);
    utimesSync(join(dir, "manifest.json"), when, when);
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "solvers-reload-"));
    mkdirSync(join(root, "agents"));
    mkdirSync(join(root, "published"));
    process.env.AGENTS_DIR = join(root, "agents");
    process.env.PUBLISHED_DIR = join(root, "published");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("the API follows the disk without a restart (no explicit reloadPackages)", async () => {
    const { getPackage, refreshPackagesIfChanged } = await import("../src/runtime/packages.js");
    publish("1.0.0");
    assert.equal(getPackage(ID)?.manifest.version, "1.0.0");
    // Another process (cli:approve) swaps the published folder: the API still has the old cache within the 5 s interval...
    publish("1.1.0");
    assert.equal(getPackage(ID)?.manifest.version, "1.0.0", "within the interval it does not check the disk (low cost)");
    // ...and reloads when the check runs.
    assert.equal(refreshPackagesIfChanged(true), true);
    assert.equal(getPackage(ID)?.manifest.version, "1.1.0");
    assert.equal(refreshPackagesIfChanged(true), false, "no change, no reload");
  });
});

