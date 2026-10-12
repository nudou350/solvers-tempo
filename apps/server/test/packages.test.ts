import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { Manifest } from "../src/runtime/manifest.js";
import { loadAll, loadPackage, registerPackage, type SolverPackage } from "../src/runtime/package-loader.js";
import { PackagePathError, resolveInsidePackage } from "../src/runtime/package-paths.js";
import { SKIP_WITHOUT_PAID } from "./helpers/repo-agents.js";

// Package loader: containment of manifest paths, slug/version format and id/slug collisions
// (PACKAGE_SPEC.md 3.3, 4.1 and P0). No env, database or network.

const root = mkdtempSync(join(tmpdir(), "solvers-pkg-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

function manifestJson(over: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    slug: "meu-solver",
    name: "Meu Solver",
    tagline: "Uma frase de valor",
    description: "Descrição do solver",
    category: "Outros",
    version: "1.0.0",
    creator: { id: "c", name: "Criador", bio: "Bio" },
    requirements: [],
    packageContents: [],
    steps: [{ file: "steps/01-primeira.md", gate: [] }],
    pricing: { priceUsdc: 5, royaltyBps: 0 },
    guarantee: { available: false, defaultCriteria: [] },
    ...over,
  };
}

let n = 0;
/** Creates a package folder on disk and returns its path. */
function writePackage(manifest: Record<string, unknown>, files: Record<string, string> = { "steps/01-primeira.md": "# Etapa 1\n\nFaça o que for preciso." }) {
  const dir = join(root, `pkg-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("resolveInsidePackage", () => {
  const dir = writePackage(manifestJson(), { "steps/01-primeira.md": "ok", "steps/sub/02.md": "ok", "knowledge/a.md": "conhecimento" });
  const STEPS = ["steps/"];

  it("accepts a file inside steps/", () => {
    assert.match(resolveInsidePackage(dir, "steps/01-primeira.md", STEPS), /01-primeira\.md$/);
    assert.match(resolveInsidePackage(dir, "steps/sub/02.md", STEPS), /02\.md$/);
  });

  it("refuses ../ and its variants (leaving the package folder)", () => {
    for (const rel of ["../manifest.json", "steps/../manifest.json", "steps/../../x", "../../../etc/passwd", "steps/./01-primeira.md", "steps//01-primeira.md", "steps/"]) {
      assert.throws(() => resolveInsidePackage(dir, rel, STEPS), PackagePathError, rel);
    }
  });

  it("refuses an absolute path, a Windows drive, a backslash and control characters", () => {
    for (const rel of ["/etc/passwd", "C:/Windows/win.ini", "C:\\x.md", "steps\\01-primeira.md", "steps/01\u0000.md", "steps/01\n.md", ""]) {
      assert.throws(() => resolveInsidePackage(dir, rel, STEPS), PackagePathError, JSON.stringify(rel));
    }
  });

  it("refuses a prefix outside the allowed ones and a missing file", () => {
    assert.throws(() => resolveInsidePackage(dir, "knowledge/a.md", STEPS), /start with steps\//);
    assert.throws(() => resolveInsidePackage(dir, "steps/nao-existe.md", STEPS), /does not exist/);
    assert.throws(() => resolveInsidePackage(dir, "x".repeat(300), STEPS), /too long/);
  });

  it("refuses a symbolic link pointing outside (when the system allows creating one)", (t) => {
    const outside = join(root, "segredo.env");
    writeFileSync(outside, "SERVER_KEK=segredo");
    try {
      symlinkSync(outside, join(dir, "steps", "link.md"));
    } catch {
      t.skip("no permission to create a symbolic link on this system");
      return;
    }
    assert.throws(() => resolveInsidePackage(dir, "steps/link.md", STEPS), /symbolic link/);
  });
});

describe("resolveInsidePackage: directory link (junction on Windows, symlink on Linux)", () => {
  it("steps/link/file.md pointing outside is refused", (t) => {
    const dir = writePackage(manifestJson());
    const outsideDir = join(root, "fora-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "segredo.md"), "SERVER_KEK=segredo");
    try {
      symlinkSync(outsideDir, join(dir, "steps", "atalho"), "junction");
    } catch {
      t.skip("could not create a directory link on this system");
      return;
    }
    assert.throws(() => resolveInsidePackage(dir, "steps/atalho/segredo.md", ["steps/"]), /symbolic link/);
  });
});

describe("loadPackage: malicious manifest", () => {
  it("steps[].file with ../ does not serve the outside file as a step", () => {
    const dir = writePackage(manifestJson({ steps: [{ file: "../segredo.env", gate: [] }] }));
    writeFileSync(join(root, "segredo.env"), "SERVER_KEK=segredo");
    assert.throws(() => loadPackage(dir), PackagePathError);
  });

  it("steps[].file outside steps/ is refused even if it exists", () => {
    const dir = writePackage(manifestJson({ steps: [{ file: "knowledge/a.md", gate: [] }] }), { "knowledge/a.md": "texto", "steps/01-primeira.md": "x" });
    assert.throws(() => loadPackage(dir), /start with steps\//);
  });

  it("a package with a symbolic link does not load (nor enters the hash)", (t) => {
    const dir = writePackage(manifestJson());
    const outside = join(root, "fora.txt");
    writeFileSync(outside, "conteúdo de fora");
    try {
      symlinkSync(outside, join(dir, "knowledge-link.txt"));
    } catch {
      t.skip("no permission to create a symbolic link on this system");
      return;
    }
    assert.throws(() => loadPackage(dir), /symbolic link/);
  });

  it("a valid package loads and uses the step inside the folder", () => {
    const pkg = loadPackage(writePackage(manifestJson()));
    assert.equal(pkg.steps[0]!.title, "Etapa 1");
    assert.equal(pkg.manifest.slug, "meu-solver");
    assert.match(pkg.versionHash, /^[0-9a-f]{64}$/);
  });
});

describe("Manifest: slug and version", () => {
  const parse = (over: Record<string, unknown>) => Manifest.safeParse(manifestJson(over));

  it("valid slugs", () => {
    for (const slug of ["frontend-react", "abc", "a1-b2-c3", "x".repeat(40)]) assert.equal(parse({ slug }).success, true, slug);
  });

  it("refuses a slug with an invalid format", () => {
    for (const slug of ["", "ab", "Maiuscula", "com espaço", "com_underline", "-começa", "termina-", "duplo--hífen", "../x", "a/b", "ação", "x".repeat(41)]) {
      assert.equal(parse({ slug }).success, false, JSON.stringify(slug));
    }
  });

  it("refuses a slug shaped like an id (32 hex): it would hijack another agent's lookup", () => {
    const r = parse({ slug: ID_B });
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error?.issues), /format of an id/);
  });

  it("valid and invalid versions", () => {
    for (const version of ["1.0.0", "0.9.0", "10.20.30"]) assert.equal(parse({ version }).success, true, version);
    for (const version of ["1.0", "v1.0.0", "1.0.0-beta", "1.0.0+build", "1.0.x", "", "../1.0.0", "1234567890.1234567890.1"]) {
      assert.equal(parse({ version }).success, false, version);
    }
  });
});

/** Minimal SolverPackage, just for the registry map. */
const fakePkg = (id: string, slug: string): SolverPackage => ({ manifest: { id, slug } as never, dir: "/x", steps: [], versionHash: "", evalReport: null, usesMemory: false, translations: {} } as unknown as SolverPackage);

describe("registerPackage: id and slug share a single namespace", () => {
  it("registers by id and by slug", () => {
    const reg = new Map<string, SolverPackage>();
    const p = fakePkg(ID_A, "meu-solver");
    registerPackage(reg, p);
    assert.equal(reg.get(ID_A), p);
    assert.equal(reg.get("meu-solver"), p);
  });

  it("a repeated id is refused and the first one stays", () => {
    const reg = new Map<string, SolverPackage>();
    const first = fakePkg(ID_A, "primeiro");
    registerPackage(reg, first);
    assert.throws(() => registerPackage(reg, fakePkg(ID_A, "segundo")), /already belongs/);
    assert.equal(reg.get(ID_A), first);
    assert.equal(reg.has("segundo"), false);
  });

  it("a repeated slug is refused", () => {
    const reg = new Map<string, SolverPackage>();
    registerPackage(reg, fakePkg(ID_A, "mesmo"));
    assert.throws(() => registerPackage(reg, fakePkg(ID_B, "mesmo")), /already belongs/);
    assert.equal(reg.has(ID_B), false);
  });

  it("a slug equal to another package's id is refused (defense in depth, even though Manifest already blocks it)", () => {
    const reg = new Map<string, SolverPackage>();
    registerPackage(reg, fakePkg(ID_A, "original"));
    assert.throws(() => registerPackage(reg, fakePkg(ID_B, ID_A)), /already belongs/);
    assert.equal(reg.get(ID_A)?.manifest.slug, "original");
  });
});

describe("loadAll", () => {
  it("duplicate: the first in alphabetical order stays, the other is refused and reported", () => {
    const base = mkdtempSync(join(tmpdir(), "solvers-all-"));
    try {
      for (const [folder, slug] of [["a-primeiro", "primeiro"], ["b-copia", "copia"]] as const) {
        const d = join(base, folder);
        mkdirSync(join(d, "steps"), { recursive: true });
        writeFileSync(join(d, "manifest.json"), JSON.stringify(manifestJson({ slug })));
        writeFileSync(join(d, "steps", "01-primeira.md"), "# Etapa");
      }
      const errors: string[] = [];
      const reg = loadAll(base, (dir, e) => errors.push(`${dir}: ${e.message}`));
      assert.equal(reg.get(ID_A)?.manifest.slug, "primeiro");
      assert.equal(reg.has("copia"), false);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /b-copia.*already belongs/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the repository's real packages load without errors (regression for the new rules)", { skip: SKIP_WITHOUT_PAID }, () => {
    const errors: string[] = [];
    const reg = loadAll(resolve(import.meta.dirname, "../../../agents"), (dir, e) => errors.push(`${dir}: ${e.message}`));
    assert.deepEqual(errors, []);
    const ids = new Set([...reg.values()].map((p) => p.manifest.id));
    assert.ok(ids.size >= 8, `expected 8 packages, found ${ids.size}`);
  });
});
