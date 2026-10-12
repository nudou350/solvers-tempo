import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { installDeliverable } from "../src/verifier/install.js";
import { withKeyLock } from "../src/verifier/lock.js";
import { evaluateReport, planMarkPassed, type EvalInput } from "../src/verifier/report.js";
import { dirUsage, readRegularFile, readRegularJson } from "../src/verifier/safe-read.js";

// Verifier: safe reading of what comes back from the container, report validation, per-step mutex
// and the mark_passed decision. No Docker, database or env.

const isWin = process.platform === "win32";

describe("readRegularFile / readRegularJson", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "verifier-safe-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a regular file and valid JSON", () => {
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ a: 1 }));
    const r = readRegularFile(join(dir, "ok.json"), 1000);
    assert.ok(r.ok && r.data.toString() === '{"a":1}');
    assert.deepEqual(readRegularJson(join(dir, "ok.json"), 1000), { ok: true, value: { a: 1 } });
  });

  it("a missing file is 'missing', not an exception", () => {
    const r = readRegularFile(join(dir, "nao-existe"), 1000);
    assert.deepEqual(r, { ok: false, reason: "missing" });
  });

  it("refuses a symlink (even to a readable host file)", (t) => {
    const target = join(dir, "segredo.txt");
    writeFileSync(target, "CHAVE-PRIVADA");
    const link = join(dir, "preview.html");
    try {
      symlinkSync(target, link);
    } catch {
      t.skip("no permission to create symlinks in this environment");
      return;
    }
    const r = readRegularFile(link, 1000);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "not_regular");
    assert.equal(readRegularJson(link, 1000).ok, false);
  });

  it("refuses a broken symlink and a symlink to a directory", (t) => {
    try {
      symlinkSync(join(dir, "nada"), join(dir, "quebrado"));
      mkdirSync(join(dir, "sub"));
      symlinkSync(join(dir, "sub"), join(dir, "para-dir"));
    } catch {
      t.skip("no permission to create symlinks in this environment");
      return;
    }
    assert.equal(!readRegularFile(join(dir, "quebrado"), 10).ok, true);
    assert.equal(!readRegularFile(join(dir, "para-dir"), 10).ok, true);
  });

  it("refuses a directory", () => {
    mkdirSync(join(dir, "uma-pasta"), { recursive: true });
    const r = readRegularFile(join(dir, "uma-pasta"), 1000);
    assert.equal(!r.ok && r.reason, "not_regular");
  });

  it("refuses a FIFO without hanging (readFileSync would hang the server)", (t) => {
    if (isWin) {
      t.skip("mkfifo does not exist on Windows");
      return;
    }
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const r = readRegularFile(fifo, 1000);
    assert.equal(!r.ok && r.reason, "not_regular");
  });

  it("refuses a file over the limit without reading it", () => {
    writeFileSync(join(dir, "grande.json"), Buffer.alloc(5000, 0x20));
    const r = readRegularFile(join(dir, "grande.json"), 1000);
    assert.equal(!r.ok && r.reason, "too_large");
    assert.equal(readRegularFile(join(dir, "grande.json"), 5000).ok, true);
  });

  it("invalid JSON becomes a failure, never an exception", () => {
    writeFileSync(join(dir, "ruim.json"), "{ nao eh json");
    const r = readRegularJson(join(dir, "ruim.json"), 1000);
    assert.equal(!r.ok && r.reason, "invalid_json");
    writeFileSync(join(dir, "vazio.json"), "");
    assert.equal(!readRegularJson(join(dir, "vazio.json"), 1000).ok, true);
  });
});

describe("dirUsage", () => {
  it("sums files without following symlinks and stops at the entry limit", () => {
    const d = mkdtempSync(join(tmpdir(), "verifier-usage-"));
    try {
      writeFileSync(join(d, "a"), Buffer.alloc(3000));
      mkdirSync(join(d, "x"));
      writeFileSync(join(d, "x", "b"), Buffer.alloc(2000));
      const u = dirUsage(d, 100);
      assert.ok(u.bytes >= 5000 && !u.truncated);
      for (let i = 0; i < 20; i++) writeFileSync(join(d, `f${i}`), "");
      assert.equal(dirUsage(d, 10).truncated, true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("dirUsage: incremental reading and symlinks", () => {
  it("does not follow a symlink to a folder (does not count what is outside)", (t) => {
    const out = mkdtempSync(join(tmpdir(), "verifier-out-"));
    const d = mkdtempSync(join(tmpdir(), "verifier-in-"));
    try {
      writeFileSync(join(out, "enorme"), Buffer.alloc(100_000));
      try {
        symlinkSync(out, join(d, "atalho"));
      } catch {
        t.skip("no permission to create symlinks in this environment");
        return;
      }
      const u = dirUsage(d);
      assert.ok(u.bytes < 50_000, `counted ${u.bytes} bytes through the symlink`);
      assert.equal(u.truncated, false);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("stops at the entry cap of a large folder", () => {
    const d = mkdtempSync(join(tmpdir(), "verifier-many-"));
    try {
      for (let i = 0; i < 300; i++) writeFileSync(join(d, `f${i}`), "");
      const u = dirUsage(d, 50);
      assert.equal(u.truncated, true);
      assert.equal(u.entries, 51); // stopped right after the cap, without counting all 300
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("missing folder: zero, no exception", () => {
    assert.deepEqual(dirUsage(join(tmpdir(), "nao-existe-verifier-xyz")), { bytes: 0, entries: 0, truncated: false });
  });
});

describe("installDeliverable (install with undo)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const mk = () => mkdtempSync(join(tmpdir(), "verifier-install-"));

  it("installs from scratch and commit leaves no leftovers", () => {
    const m = mk();
    try {
      const i = installDeliverable(m, { "A.tsx": "a", "sub/B.tsx": "b" }, "<p>1</p>");
      assert.equal(i.dir, join(m, "files"));
      assert.equal(read(join(m, "files", "sub", "B.tsx")), "b");
      assert.equal(read(join(m, "preview.html")), "<p>1</p>");
      i.commit();
      assert.deepEqual(readdirSync(m).sort(), ["files", "preview.html"]);
    } finally {
      rmSync(m, { recursive: true, force: true });
    }
  });

  it("fully replaces the previous deliverable and commit removes the backup", () => {
    const m = mk();
    try {
      installDeliverable(m, { "Velho.tsx": "velho", "Outro.tsx": "x" }, "<p>velha</p>").commit();
      const i = installDeliverable(m, { "Novo.tsx": "novo" }, null);
      assert.deepEqual(readdirSync(join(m, "files")), ["Novo.tsx"]);
      assert.equal(existsSync(join(m, "preview.html")), false); // without a new preview, the old one does not stay
      i.commit();
      assert.deepEqual(readdirSync(m).sort(), ["files"]);
    } finally {
      rmSync(m, { recursive: true, force: true });
    }
  });

  it("undo restores exactly the previous deliverable and preview", () => {
    const m = mk();
    try {
      installDeliverable(m, { "A.tsx": "de-A" }, "<p>A</p>").commit();
      const b = installDeliverable(m, { "B.tsx": "de-B" }, "<p>B</p>");
      assert.equal(read(join(m, "files", "B.tsx")), "de-B");
      b.undo();
      assert.deepEqual(readdirSync(join(m, "files")), ["A.tsx"]);
      assert.equal(read(join(m, "files", "A.tsx")), "de-A");
      assert.equal(read(join(m, "preview.html")), "<p>A</p>");
      assert.deepEqual(readdirSync(m).filter((n) => n.startsWith(".")), []);
    } finally {
      rmSync(m, { recursive: true, force: true });
    }
  });

  it("undoing the first install leaves the step without a deliverable", () => {
    const m = mk();
    try {
      installDeliverable(m, { "A.tsx": "a" }, "<p>A</p>").undo();
      assert.equal(existsSync(join(m, "files")), false);
      assert.equal(existsSync(join(m, "preview.html")), false);
    } finally {
      rmSync(m, { recursive: true, force: true });
    }
  });
});

// ---------- Report validation ----------

const pass = (title: string) => ({ fullName: title, title, status: "passed", failureMessages: [] });
const fail = (title: string, msg = "boom") => ({ fullName: title, title, status: "failed", failureMessages: [msg] });
const file = (name: string, assertionResults: unknown[], status = "passed") => ({ name: `/work/${name}`, status, assertionResults });

function input(over: Partial<EvalInput> & { json: unknown }): EvalInput {
  return { exitCode: 0, out: "", acceptanceFiles: null, durationMs: 1, ...over };
}

describe("evaluateReport", () => {
  it("passes: exit code 0, tests passing, no acceptance suite", () => {
    const r = evaluateReport(input({ json: { success: true, testResults: [file("src/A.test.tsx", [pass("a")])] } }));
    assert.equal(r.passed, true);
    assert.equal(r.numTests, 1);
    assert.equal(r.acceptance, null);
  });

  it("requires exit code 0 even with a 'perfect' report (forged report)", () => {
    const forged = { success: true, testResults: [file("src/acceptance.A.test.tsx", [pass("fake")])] };
    const r = evaluateReport(input({ json: forged, exitCode: 1, acceptanceFiles: ["acceptance.A.test.tsx"] }));
    assert.equal(r.passed, false);
    assert.match(r.failures[0]!.message, /code 1/);
  });

  it("timeout and report overflow fail", () => {
    const ok = { testResults: [file("src/A.test.tsx", [pass("a")])] };
    assert.equal(evaluateReport(input({ json: ok, exitCode: 137, timedOut: true })).passed, false);
    assert.equal(evaluateReport(input({ json: ok, overflow: true })).passed, false);
  });

  it("a missing or invalid report becomes an execution failure", () => {
    const r = evaluateReport(input({ json: null, jsonProblem: "O relatório de testes não é um JSON válido" }));
    assert.equal(r.passed, false);
    assert.equal(r.failures[0]!.test, "execution");
    assert.match(r.failures[0]!.message, /JSON válido/);
    assert.equal(evaluateReport(input({ json: [1, 2] })).passed, false);
    assert.equal(evaluateReport(input({ json: "texto" })).passed, false);
  });

  it("zero tests fails", () => {
    assert.equal(evaluateReport(input({ json: { testResults: [] } })).passed, false);
    assert.equal(evaluateReport(input({ json: { testResults: [file("src/A.test.tsx", [])] } })).passed, false);
  });

  it("a failing test fails and lists the failure", () => {
    const r = evaluateReport(input({ json: { testResults: [file("src/A.test.tsx", [pass("a"), fail("b", "x")])] }, exitCode: 1 }));
    assert.equal(r.passed, false);
    assert.equal(r.numFailed, 1);
    assert.deepEqual(r.failures.map((f) => f.test), ["b"]);
  });

  it("a skipped or todo test does not count as passed", () => {
    const skipped = { fullName: "s", title: "s", status: "skipped", failureMessages: [] };
    assert.equal(evaluateReport(input({ json: { testResults: [file("src/A.test.tsx", [pass("a"), skipped])] } })).passed, false);
  });

  it("a test file that did not load (import error) fails", () => {
    const r = evaluateReport(
      input({ json: { testResults: [file("src/A.test.tsx", [pass("a")]), { name: "/work/src/B.test.tsx", status: "failed", message: "Cannot find module", assertionResults: [] }] } }),
    );
    assert.equal(r.passed, false);
    assert.equal(r.failures[0]!.test, "src/B.test.tsx");
  });

  it("the helper preview test does not count (exact path)", () => {
    const r = evaluateReport(input({ json: { testResults: [file("src/A.test.tsx", [pass("a")]), file("src/__preview__.test.tsx", [fail("__preview__")])] } }));
    assert.equal(r.numTests, 1);
    assert.equal(r.passed, true);
  });

  it("a deliverable file with '__preview__' in its name DOES count and can fail", () => {
    const r = evaluateReport(input({ json: { testResults: [file("src/A.test.tsx", [pass("a")]), file("src/x__preview__.test.tsx", [fail("ruim")])] }, exitCode: 1 }));
    assert.equal(r.passed, false);
  });

  describe("acceptance suite", () => {
    const acc = ["acceptance.A.test.tsx", "acceptance.B.test.tsx"];

    it("passes when every expected file ran and passed", () => {
      const json = { testResults: [file("src/acceptance.A.test.tsx", [pass("a1"), pass("a2")]), file("src/acceptance.B.test.tsx", [pass("b1")]), file("src/A.test.tsx", [pass("own")])] };
      const r = evaluateReport(input({ json, acceptanceFiles: acc }));
      assert.equal(r.passed, true);
      assert.deepEqual(r.acceptance, { numTests: 3, numPassed: 3 });
      assert.equal(r.numTests, 4);
    });

    it("fails if an expected suite file is missing from the report", () => {
      const json = { testResults: [file("src/acceptance.A.test.tsx", [pass("a1")]), file("src/A.test.tsx", [pass("own")])] };
      const r = evaluateReport(input({ json, acceptanceFiles: acc }));
      assert.equal(r.passed, false);
      assert.ok(r.failures.some((f) => f.test === "acceptance.B.test.tsx"));
    });

    it("fails if the expected file ran with no tests", () => {
      const json = { testResults: [file("src/acceptance.A.test.tsx", [pass("a1")]), file("src/acceptance.B.test.tsx", [])] };
      assert.equal(evaluateReport(input({ json, acceptanceFiles: acc })).passed, false);
    });

    it("fails if a suite test failed", () => {
      const json = { testResults: [file("src/acceptance.A.test.tsx", [pass("a1"), fail("a2")]), file("src/acceptance.B.test.tsx", [pass("b1")])] };
      const r = evaluateReport(input({ json, acceptanceFiles: acc, exitCode: 1 }));
      assert.equal(r.passed, false);
      assert.deepEqual(r.acceptance, { numTests: 3, numPassed: 2 });
    });

    it("a deliverable in an 'acceptance.x/' folder is not counted as the suite (exact path)", () => {
      const json = { testResults: [file("src/acceptance.A.test.tsx", [pass("a1")]), file("src/acceptance.B.test.tsx", [pass("b1")]), file("src/acceptance.d/fake.test.tsx", [pass("f1"), pass("f2")])] };
      const r = evaluateReport(input({ json, acceptanceFiles: acc }));
      assert.equal(r.passed, true);
      assert.deepEqual(r.acceptance, { numTests: 2, numPassed: 2 });
    });

    it("the deliverable's own passing tests do not replace a missing suite", () => {
      const json = { testResults: [file("src/Own.test.tsx", [pass("trivial")])] };
      assert.equal(evaluateReport(input({ json, acceptanceFiles: acc })).passed, false);
    });
  });
});

// ---------- Idempotent mark_passed ----------

describe("planMarkPassed", () => {
  const h = "ab".repeat(32);
  it("pending or unknown state: sends", () => {
    assert.equal(planMarkPassed({ status: 0, deliverableHash: "00".repeat(32) }, h), "send");
    assert.equal(planMarkPassed(null, h), "send");
  });
  it("already Passed with the same hash: does not resend", () => {
    assert.equal(planMarkPassed({ status: 1, deliverableHash: h }, h), "already");
    assert.equal(planMarkPassed({ status: 1, deliverableHash: h.toUpperCase() }, h), "already");
  });
  it("Passed with another hash, or in another state: conflict", () => {
    assert.equal(planMarkPassed({ status: 1, deliverableHash: "cd".repeat(32) }, h), "conflict");
    assert.equal(planMarkPassed({ status: 2, deliverableHash: h }, h), "conflict");
    assert.equal(planMarkPassed({ status: 3, deliverableHash: h }, h), "conflict");
  });
});

// ---------- Per-step mutex ----------

describe("withKeyLock", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("serializes the same key (no overlap, in order)", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await sleep(ms);
      log.push(`${name}:end`);
      return name;
    };
    const res = await Promise.all([withKeyLock("e:0", job("A", 30)), withKeyLock("e:0", job("B", 5)), withKeyLock("e:0", job("C", 1))]);
    assert.deepEqual(res, ["A", "B", "C"]);
    assert.deepEqual(log, ["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]);
  });

  it("different keys run in parallel", async () => {
    const log: string[] = [];
    await Promise.all([
      withKeyLock("e:1", async () => {
        log.push("1:start");
        await sleep(20);
        log.push("1:end");
      }),
      withKeyLock("e:2", async () => {
        log.push("2:start");
        await sleep(1);
        log.push("2:end");
      }),
    ]);
    assert.deepEqual(log, ["1:start", "2:start", "2:end", "1:end"]);
  });

  it("an error in one run does not block the key's queue", async () => {
    const a = withKeyLock("e:3", async () => {
      await sleep(5);
      throw new Error("falhou");
    });
    const b = withKeyLock("e:3", async () => "b");
    await assert.rejects(a, /falhou/);
    assert.equal(await b, "b");
  });
});
