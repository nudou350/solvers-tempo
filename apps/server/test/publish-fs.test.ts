import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanIncoming, findPackageRoot, incomingParent, publishedVersionOf, stagePackage, swapInPublished } from "../src/publish/fs.js";

// Publication disk work (PACKAGE_SPEC.md 15.1): find the root of the extracted package, copy it to the staging folder and swap
// the published folder by rename, archiving the previous version. node:fs only, in a temporary folder.

const base = mkdtempSync(join(tmpdir(), "solvers-pubfs-"));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function pkg(version: string, extra: Record<string, string> = {}) {
  const dir = join(base, `src-${++n}`);
  mkdirSync(join(dir, "steps"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ slug: "meu-solver", version }));
  writeFileSync(join(dir, "steps", "01.md"), `etapa ${version}`);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("findPackageRoot", () => {
  it("the folder itself, when it has manifest.json", () => {
    const dir = pkg("1.0.0");
    assert.equal(findPackageRoot(dir), dir);
  });

  it("the only subfolder with manifest.json (ZIP root), ignoring __MACOSX and hidden ones", () => {
    const outer = join(base, `outer-${++n}`);
    mkdirSync(join(outer, "__MACOSX"), { recursive: true });
    mkdirSync(join(outer, ".git"), { recursive: true });
    mkdirSync(join(outer, "meu-solver"), { recursive: true });
    writeFileSync(join(outer, "meu-solver", "manifest.json"), "{}");
    assert.equal(findPackageRoot(outer), join(outer, "meu-solver"));
  });

  it("fails without manifest.json, with two candidates or without the folder", () => {
    const empty = join(base, `empty-${++n}`);
    mkdirSync(empty);
    assert.throws(() => findPackageRoot(empty), /manifest\.json/);
    const two = join(base, `two-${++n}`);
    for (const d of ["a", "b"]) {
      mkdirSync(join(two, d), { recursive: true });
      writeFileSync(join(two, d, "manifest.json"), "{}");
    }
    assert.throws(() => findPackageRoot(two), /2 candidates/);
    assert.throws(() => findPackageRoot(join(base, "nao-existe")), /not found/);
  });
});

describe("stagePackage and swapInPublished", () => {
  it("the first publication: copies to <staging>/<slug> and places it in <published>/<slug> without archiving anything", () => {
    const published = join(base, `pub-${++n}`);
    const src = pkg("1.0.0", { "knowledge/a.md": "conteúdo" });
    const staged = stagePackage(src, incomingParent(published, "sub1"), "meu-solver");
    assert.equal(staged, join(published, ".incoming", "sub1", "meu-solver"));
    const { archivedTo } = swapInPublished(published, "meu-solver", staged);
    assert.equal(archivedTo, null);
    assert.equal(readFileSync(join(published, "meu-solver", "knowledge", "a.md"), "utf8"), "conteúdo");
    assert.equal(existsSync(staged), false, "the staging copy was moved, not copied");
    assert.equal(existsSync(src), true, "the original extracted folder stays (the submission keeps it)");
  });

  it("the update archives the previous one in _archive/<slug>/<version>/ and the new one becomes active", () => {
    const published = join(base, `pub-${++n}`);
    swapInPublished(published, "meu-solver", stagePackage(pkg("1.0.0"), incomingParent(published, "s1"), "meu-solver"));
    const { archivedTo } = swapInPublished(published, "meu-solver", stagePackage(pkg("1.1.0"), incomingParent(published, "s2"), "meu-solver"));
    assert.equal(archivedTo, join(published, "_archive", "meu-solver", "1.0.0"));
    assert.equal(publishedVersionOf(join(published, "meu-solver")), "1.1.0");
    assert.equal(publishedVersionOf(archivedTo!), "1.0.0");
  });

  it("never overwrites an already archived version (the same version republished gets a suffix)", () => {
    const published = join(base, `pub-${++n}`);
    swapInPublished(published, "meu-solver", stagePackage(pkg("1.0.0"), incomingParent(published, "s1"), "meu-solver"));
    swapInPublished(published, "meu-solver", stagePackage(pkg("1.0.0", { "extra.md": "x" }), incomingParent(published, "s2"), "meu-solver"));
    const { archivedTo } = swapInPublished(published, "meu-solver", stagePackage(pkg("1.0.0", { "extra2.md": "y" }), incomingParent(published, "s3"), "meu-solver"));
    assert.equal(archivedTo, join(published, "_archive", "meu-solver", "1.0.0-1"));
    assert.equal(existsSync(join(published, "_archive", "meu-solver", "1.0.0", "manifest.json")), true);
  });

  it("redoing the staging deletes the previous copy; cleanIncoming cleans everything", () => {
    const published = join(base, `pub-${++n}`);
    const parent = incomingParent(published, "s1");
    stagePackage(pkg("1.0.0", { "velho.md": "x" }), parent, "meu-solver");
    const again = stagePackage(pkg("1.0.0"), parent, "meu-solver");
    assert.equal(existsSync(join(again, "velho.md")), false);
    cleanIncoming(published, "s1");
    assert.equal(existsSync(parent), false);
  });

  it("publishedVersionOf: null for a folder without a readable manifest", () => {
    assert.equal(publishedVersionOf(join(base, "nao-existe")), null);
    const bad = join(base, `bad-${++n}`);
    mkdirSync(bad);
    writeFileSync(join(bad, "manifest.json"), "{ não é json");
    assert.equal(publishedVersionOf(bad), null);
  });
});
