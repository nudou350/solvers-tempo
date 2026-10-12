import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { packageHashOf } from "../src/review/hash.js";
import { packageHash } from "../src/runtime/package-loader.js";
import { packageFromFolder, packageFromMemory } from "../src/runtime/validate/input.js";
import { baseFiles } from "./validate-fixtures.js";
import { SKIP_WITHOUT_PAID } from "./helpers/repo-agents.js";

// The PackageInput hash must be IDENTICAL to the disk loader's (what `cli:publish` writes on-chain as versionHash).

const agents = resolve(import.meta.dirname, "../../../agents");
const SLUGS = ["backend-node", "copy-marketing", "financas-pessoais", "frontend-react", "planejador-viagens", "planilhas-dados", "revisao-contratos", "ui-design"];

describe("packageHashOf = packageHash(dir) on the agents/ packages", { skip: SKIP_WITHOUT_PAID }, () => {
  for (const slug of SLUGS) {
    it(`${slug}`, () => {
      const dir = resolve(agents, slug);
      assert.equal(packageHashOf(packageFromFolder(dir)), packageHash(dir));
    });
  }

  it("with CRLF in the checkout the hash is the same (normalized text)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "solvers-hash-"));
    try {
      const dir = join(tmp, "backend-node");
      cpSync(resolve(agents, "backend-node"), dir, { recursive: true });
      const manifest = join(dir, "manifest.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/\r?\n/g, "\r\n"));
      assert.equal(packageHashOf(packageFromFolder(dir)), packageHash(resolve(agents, "backend-node")));
      assert.equal(packageHash(dir), packageHash(resolve(agents, "backend-node")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("packageHashOf in memory", () => {
  it("is deterministic and independent of entry order", () => {
    const a = packageFromMemory(baseFiles());
    const b = { entries: [...a.entries].reverse(), read: a.read };
    assert.equal(packageHashOf(a), packageHashOf(b));
    assert.match(packageHashOf(a), /^[0-9a-f]{64}$/);
  });

  it("CRLF vs LF in text gives the same hash; one different byte changes it", () => {
    const f = baseFiles();
    const g = { ...f, "steps/01-levantar.md": (f["steps/01-levantar.md"] as string).replace(/\n/g, "\r\n") };
    assert.equal(packageHashOf(packageFromMemory(f)), packageHashOf(packageFromMemory(g)));
    const h = { ...f, "steps/01-levantar.md": `${f["steps/01-levantar.md"] as string}.` };
    assert.notEqual(packageHashOf(packageFromMemory(f)), packageHashOf(packageFromMemory(h)));
  });

  it("evals/report.json, node_modules and dot names are left out", () => {
    const f = baseFiles();
    const base = packageHashOf(packageFromMemory(f));
    const g = { ...f, "evals/report.json": '{"scoreBps": 9000}', ".DS_Store": "x", "knowledge/.oculto.md": "x", "node_modules/x/a.js": "x" };
    assert.equal(packageHashOf(packageFromMemory(g)), base);
  });

  it("the path is part of the hash (renaming changes it) and binaries are not normalized", () => {
    const f = baseFiles();
    const { "knowledge/das-mei-2026.md": md, ...rest } = f;
    assert.notEqual(packageHashOf(packageFromMemory(f)), packageHashOf(packageFromMemory({ ...rest, "knowledge/outro-nome.md": md! })));
    const x = packageHashOf(packageFromMemory({ ...f, "templates/a.png": new Uint8Array([13, 10]) }));
    const y = packageHashOf(packageFromMemory({ ...f, "templates/a.png": new Uint8Array([10]) }));
    assert.notEqual(x, y);
  });

  it("a symbolic link and a missing file are refused", () => {
    const a = packageFromMemory(baseFiles());
    assert.throws(() => packageHashOf({ entries: [...a.entries, { path: "knowledge/l.md", size: 0, isSymlink: true }], read: a.read }), /symbolic links are not allowed/);
    assert.throws(() => packageHashOf({ entries: [...a.entries, { path: "knowledge/falta.md", size: 1 }], read: a.read }), /missing/);
  });
});
