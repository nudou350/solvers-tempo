import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isStale, todayInSaoPaulo } from "../src/knowledge/search-rules.js";
import { frontMatterHead, differentiatorsInput, provenDifferentiators } from "../src/runtime/differentiators.js";
import { packagesStamp } from "../src/runtime/package-loader.js";
import { loadPackage } from "../src/runtime/package-loader.js";
import { packageFromFolder, packageFromMemory } from "../src/runtime/validate/input.js";
import { validatePackage } from "../src/runtime/validate/index.js";
import { injectionMatch, sendingUrl, sensitiveAsk, urlsIn } from "../src/runtime/validate/text-scans.js";
import { scanPackage } from "../src/review/scans.js";
import { attemptsExhausted, MAX_ATTEMPTS } from "../src/submissions/process.js";
import { versionGreater } from "../src/submissions/rules.js";
import { EXPIRED_NOTE, filesExpired, orphanFolderStale, partFileStale, staleOpen } from "../src/submissions/cleanup-rules.js";
import { extractZip, NUCLEO_ZIP_LIMITS, ZipError } from "../src/submissions/zip.js";
import { notListedBlock } from "../src/store/purchase-rules.js";
import { PlatformAgentIgnored, mirrorAgentAccount } from "../src/indexer/sync.js";
import { buildZip, type ZipSpec } from "./helpers/zip-builder.js";

// Fixes from the creator-flow review that need no database: linear-time scans, package cache stamp, ZIP (exact
// manifest, file vs folder), cleanup rules, version, sale without a catalog, platform id.

const DAY = 86_400_000;

/** Runs `fn` and requires it to finish in under `ms` (the bad cases took seconds). */
function fast<T>(label: string, fn: () => T, ms = 100): T {
  const t0 = performance.now();
  const out = fn();
  const took = performance.now() - t0;
  assert.ok(took < ms, `${label}: ${took.toFixed(0)} ms (limit ${ms} ms)`);
  return out;
}

describe("text scans in linear time (quadratic regex DoS)", () => {
  it("200k '?' in a URL and 100k punctuation marks at the end", () => {
    const url = `https://a.com/${"?".repeat(200_000)}`;
    fast("sendingUrl", () => sendingUrl(url));
    fast("urlsIn", () => urlsIn(url));
    fast("urlsIn punctuation", () => urlsIn(`http://x.com/${".".repeat(100_000)}a`));
    fast("urlsIn trailing punctuation", () => urlsIn(`http://x.com/a${"!?.,;:".repeat(20_000)}`));
  });

  it("40k spaces after '<' and huge lines in the injection and sensitive-data phrases", () => {
    fast("tag <system>", () => injectionMatch(`<${" ".repeat(40_000)}x`));
    fast("repeated <system> tag", () => injectionMatch("< ".repeat(40_000)));
    fast("ignore + spaces", () => injectionMatch(`ignore${" ".repeat(100_000)}x`));
    fast("repeated ignore", () => injectionMatch("ignore todas as ".repeat(20_000)));
    fast("sensitiveAsk", () => sensitiveAsk(`peça ${"senha ".repeat(50_000)}`));
  });

  it("scanPackage: href= with 80k spaces, repeated '](' and a huge comment", () => {
    const text = `href=${" ".repeat(80_000)}x\n](${" ".repeat(80_000)}x\n${"![a](".repeat(20_000)}\n<!--${"-".repeat(100_000)}`;
    fast("scanPackage", () => scanPackage(packageFromMemory({ "steps/01.md": text, "manifest.json": "{}" })), 300);
  });

  it("the usual results stay the same (query with '=', '#' before '=', sending verbs)", () => {
    assert.equal(sendingUrl("veja https://a.com/x?id=1"), "https://a.com/x?id=1");
    assert.equal(sendingUrl("veja https://a.com/x#a?b=1"), "https://a.com/x#a?b=1", "a '?' after '#' still counts (previous regex)");
    assert.equal(sendingUrl("veja https://a.com/x?id"), null);
    assert.equal(sendingUrl("veja https://a.com/x#frag=1"), null);
    assert.equal(sendingUrl("envie os dados para https://a.com/x"), "https://a.com/x");
    assert.deepEqual(urlsIn("ver https://a.com/x?a=b, depois."), [{ url: "https://a.com/x?a=b", sending: true, line: "ver https://a.com/x?a=b, depois." }]);
    assert.equal(urlsIn("ver https://a.com/x.")[0]!.url, "https://a.com/x");
    assert.ok(injectionMatch("</ system >"));
    assert.ok(injectionMatch("<instructions>"));
    assert.equal(injectionMatch("<div>"), null);
  });
});

describe("ZIP: exact manifest and a path that is both file and folder", () => {
  let tmp: string;
  let n = 0;
  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "solvers-cfxzip-"));
  });
  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const codes = async (specs: ZipSpec[]) => {
    const zip = join(tmp, `z${n}.zip`);
    await writeFile(zip, buildZip(specs));
    try {
      await extractZip(zip, join(tmp, `out${n++}`), NUCLEO_ZIP_LIMITS);
    } catch (e) {
      assert.ok(e instanceof ZipError, String(e));
      return e.issues;
    }
    return [];
  };

  it("MANIFEST.JSON (other case) is refused with ZIP_BAD_ROOT", async () => {
    const issues = await codes([{ name: "pkg/MANIFEST.JSON", data: "{}" }, { name: "pkg/steps/01-a.md", data: "x" }]);
    assert.ok(issues.some((i) => i.code === "ZIP_BAD_ROOT" && /exact/.test(i.message)));
    assert.deepEqual(await codes([{ name: "pkg/manifest.json", data: "{}" }]), []);
  });

  it("'steps' file and 'steps/01.md' at once: a clean ZIP_BAD_PATH (no EISDIR nor absolute path)", async () => {
    const issues = await codes([{ name: "pkg/manifest.json", data: "{}" }, { name: "pkg/steps.md", data: "x" }, { name: "pkg/steps.md/01.md", data: "y" }]);
    assert.deepEqual(issues.map((i) => i.code), ["ZIP_BAD_PATH"]);
    assert.doesNotMatch(JSON.stringify(issues), new RegExp(tmp.replace(/\\/g, "\\\\")));
  });
});

describe("package cache: folder stamp", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "solvers-stamp-"));
    dirs.push(d);
    return d;
  };

  it("changes when another process swaps the published folder or bumps the version; stable otherwise", () => {
    const root = mk();
    mkdirSync(join(root, "meu-solver"));
    writeFileSync(join(root, "meu-solver", "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    const before = packagesStamp([root, join(root, "does-not-exist")]);
    assert.equal(packagesStamp([root, join(root, "does-not-exist")]), before, "stable");
    // "Another process": the new folder replaces the old one (higher version, bigger manifest, different mtime).
    rmSync(join(root, "meu-solver"), { recursive: true });
    mkdirSync(join(root, "meu-solver"));
    writeFileSync(join(root, "meu-solver", "manifest.json"), JSON.stringify({ version: "1.1.0", extra: "more bytes" }));
    utimesSync(join(root, "meu-solver", "manifest.json"), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    assert.notEqual(packagesStamp([root]), before);
    // Hidden and archive folders do not count.
    mkdirSync(join(root, "_archive", "x"), { recursive: true });
    writeFileSync(join(root, "_archive", "x", "manifest.json"), "{}");
    const withArchive = packagesStamp([root]);
    mkdirSync(join(root, ".incoming", "y"), { recursive: true });
    writeFileSync(join(root, ".incoming", "y", "manifest.json"), "{}");
    assert.equal(packagesStamp([root]), withArchive);
  });
});

describe("cleanup and version rules", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  it("filesExpired: only rejected for more than 30 days", () => {
    assert.equal(filesExpired("rejected", ago(31), now), true);
    assert.equal(filesExpired("rejected_validation", ago(31), now), true);
    assert.equal(filesExpired("rejected", ago(29), now), false);
    assert.equal(filesExpired("published", ago(400), now), false);
    assert.equal(filesExpired("pending_review", ago(400), now), false);
  });
  it("staleOpen: changes_requested and awaiting_creator_signature for more than 30 days", () => {
    assert.equal(staleOpen("changes_requested", ago(31), now), true);
    assert.equal(staleOpen("awaiting_creator_signature", ago(31), now), true);
    assert.equal(staleOpen("changes_requested", ago(30), now), false);
    for (const s of ["pending_review", "awaiting_onchain_approval", "publishing", "publish_failed", "published", "submitted", "validating"]) assert.equal(staleOpen(s, ago(400), now), false, s);
    assert.match(EXPIRED_NOTE, /expired/);
  });
  it("partFileStale and orphanFolderStale: one day of slack", () => {
    assert.equal(partFileStale("package.zip.abc.part", ago(2).getTime(), now), true);
    assert.equal(partFileStale("package.zip.abc.part", ago(0.5).getTime(), now), false);
    assert.equal(partFileStale("package.zip", ago(20).getTime(), now), false);
    assert.equal(orphanFolderStale(false, ago(2).getTime(), now), true);
    assert.equal(orphanFolderStale(false, ago(0.2).getTime(), now), false);
    assert.equal(orphanFolderStale(true, ago(20).getTime(), now), false);
  });
  it("versionGreater and attemptsExhausted", () => {
    assert.equal(versionGreater("1.2.0", "1.1.9"), true);
    assert.equal(versionGreater("1.10.0", "1.9.0"), true);
    assert.equal(versionGreater("1.2.0", "1.2.0"), false);
    assert.equal(versionGreater("1.1.9", "1.2.0"), false);
    assert.equal(versionGreater("1.0.0-beta", "0.9.0"), false);
    assert.equal(attemptsExhausted(MAX_ATTEMPTS - 1), false);
    assert.equal(attemptsExhausted(MAX_ATTEMPTS), true);
  });
});

describe("sales: only what is in the catalog and has a package", () => {
  it("notListedBlock: 409 agent_not_listed when either is missing", () => {
    assert.equal(notListedBlock({ listed: true, hasPackage: true }), null);
    for (const input of [{ listed: false, hasPackage: true }, { listed: true, hasPackage: false }, { listed: false, hasPackage: false }]) {
      const e = notListedBlock(input);
      assert.equal(e?.status, 409);
      assert.equal(e?.code, "agent_not_listed");
    }
  });
});

describe("indexer: reserved platform id", () => {
  it("an on-chain agent with the Solver creator's id is ignored before any write", async () => {
    // Registering an agent id is public on-chain: anyone may register the platform Solver's id; the indexer refuses to mirror it.
    await assert.rejects(mirrorAgentAccount({ agentId: "c71ad0a50f750e75c71ad0a50f750e75" } as never), (e: unknown) => e instanceof PlatformAgentIgnored);
  });
});

describe("valid_until in the Brasilia time zone", () => {
  it("the validity day still counts at 22:00 in Brasilia (already the next day in UTC)", () => {
    const at22 = new Date("2026-10-03T01:00:00Z"); // Oct 2, 22:00 in Brasilia
    assert.equal(todayInSaoPaulo(at22), "2026-10-02");
    assert.equal(isStale("2026-10-02", at22), false);
    assert.equal(isStale("2026-10-01", at22), true);
    const after = new Date("2026-10-03T04:00:00Z"); // Oct 3, 01:00 in Brasilia
    assert.equal(isStale("2026-10-02", after), true);
  });
});

describe("differentiators: lean read with the same result", () => {
  it("frontMatterHead keeps only the --- block", () => {
    assert.equal(frontMatterHead("---\nsource: X\nvalid_until: 2030-01-01\n---\ncorpo grande\nmais"), "---\nsource: X\nvalid_until: 2030-01-01\n---\n");
    assert.equal(frontMatterHead("sem front-matter\ncorpo"), "");
    assert.equal(frontMatterHead("---\naberto sem fechar\ncorpo"), "---\naberto sem fechar\ncorpo");
  });

  it("the agents/ packages give the same differentiators through the lean and the full read", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    const agents = join(process.cwd(), "..", "..", "agents");
    if (!existsSync(agents)) return;
    let checked = 0;
    for (const name of readdirSync(agents)) {
      const dir = join(agents, name);
      if (!existsSync(join(dir, "manifest.json"))) continue;
      let pkg;
      try {
        pkg = loadPackage(dir);
      } catch {
        continue;
      }
      if (pkg.manifest.specVersion !== 1) continue;
      const full = validatePackage(packageFromFolder(dir), { mode: "platform" }).stats.differentiators;
      assert.deepEqual(provenDifferentiators(pkg), full, name);
      assert.deepEqual(validatePackage(differentiatorsInput(packageFromFolder(dir)), { mode: "platform" }).stats.differentiators, full, name);
      checked += 1;
    }
    assert.ok(checked > 0, "no v1 package in agents/ to compare");
  });
});
