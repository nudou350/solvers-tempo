import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FREE_TRIAL_USES } from "@solvers/shared";
import { escrowGivesAccess, paidAccessLine } from "../src/runtime/access-rules.js";
import { Manifest } from "../src/runtime/manifest.js";
import { myTrial, toolInputSize, trialAccessLine, trialEndText, trialInfo, trialLeft, trialLimits, trialStepLocked, trialToolCapError } from "../src/runtime/trial.js";

// Free trial per specialist (manifest.trial): schema, limits and texts (no env or database).

const base = {
  id: "0".repeat(32),
  slug: "exemplo",
  name: "Exemplo",
  tagline: "t",
  description: "d",
  category: "Desenvolvimento",
  version: "1.0.0",
  creator: { id: "c", name: "C", bio: "" },
  requirements: [],
  packageContents: [],
  steps: [{ file: "1.md" }, { file: "2.md" }, { file: "3.md" }, { file: "4.md" }],
  tools: [
    { name: "run_tests", description: "", runner: "docker:solvers-react-test" },
    { name: "a11y_check", description: "", runner: "node:a11y" },
  ],
  guarantee: { available: false },
  pricing: { priceUsdc: 19, royaltyBps: 500 },
};
const trial = {
  steps: 2,
  searches: 15,
  tools: { run_tests: 1 },
  summary: "Você recebe o plano e o componente.",
  lockedSummary: "a revisão final com testes ilimitados.",
};
const parse = (extra: Record<string, unknown>) => Manifest.parse({ ...base, ...extra });
const pkgOf = (m: Manifest) => ({ manifest: m, steps: m.steps.map((s) => ({ title: s.file, body: "", gate: [] })) });

describe("manifest.trial", () => {
  it("no trial or available=false: no free trial", () => {
    assert.equal(trialLimits(parse({})), null);
    assert.equal(trialLimits(parse({ trial: { ...trial, available: false } })), null);
    assert.equal(trialInfo(pkgOf(parse({}))), null);
  });

  it("defaults: available true, uses = FREE_TRIAL_USES, tools {}", () => {
    const t = trialLimits(parse({ trial: { ...trial, tools: undefined } }))!;
    assert.equal(t.uses, FREE_TRIAL_USES);
    assert.deepEqual(t.tools, {});
  });

  it("pricePerUseUsdc from an old manifest is ignored", () => {
    const m = parse({ pricing: { priceUsdc: 19, pricePerUseUsdc: 0.9, royaltyBps: 500 } });
    assert.deepEqual(m.pricing, { priceUsdc: 19, royaltyBps: 500 });
  });

  it("rejects steps beyond the method, a nonexistent tool and uses outside 1..10", () => {
    assert.throws(() => parse({ trial: { ...trial, steps: 5 } }), /trial.steps/);
    assert.throws(() => parse({ trial: { ...trial, steps: 0 } }));
    assert.throws(() => parse({ trial: { ...trial, tools: { deploy: 1 } } }), /deploy/);
    assert.throws(() => parse({ trial: { ...trial, uses: 11 } }));
    assert.throws(() => parse({ trial: { ...trial, uses: 0 } }));
    assert.throws(() => parse({ trial: { ...trial, searches: -1 } }));
  });

  it("trialInfo for the storefront: total steps and only the unlocked tools", () => {
    const info = trialInfo(pkgOf(parse({ trial: { ...trial, tools: { run_tests: 1, a11y_check: 0 } } })));
    assert.deepEqual(info, {
      uses: 3,
      steps: 2,
      totalSteps: 4,
      searches: 15,
      tools: [{ name: "run_tests", limit: 1 }],
      scope: null,
      summary: trial.summary,
      lockedSummary: trial.lockedSummary,
    });
  });

  it("toolLimits and scope: optional, only apply to an unlocked, existing tool", () => {
    const t = trialLimits(parse({ trial: { ...trial, tools: { run_tests: 1 }, toolLimits: { run_tests: { maxFiles: 3, maxBytes: 30000 }, a11y_check: { maxFiles: 1 } }, scope: "1 componente por uso" } }))!;
    assert.deepEqual(t.toolCaps, { run_tests: { maxFiles: 3, maxBytes: 30000 } });
    assert.equal(t.scope, "1 componente por uso");
    assert.deepEqual(trialLimits(parse({ trial }))!.toolCaps, {});
    assert.equal(trialLimits(parse({ trial }))!.scope, null);
    assert.throws(() => parse({ trial: { ...trial, toolLimits: { deploy: { maxFiles: 1 } } } }), /toolLimits/);
    assert.throws(() => parse({ trial: { ...trial, toolLimits: { run_tests: { maxFiles: 0 } } } }));
  });

  it("the manifests published in agents/ are valid", () => {
    const root = join(import.meta.dirname, "..", "..", "..", "agents");
    for (const name of readdirSync(root)) {
      const file = join(root, name, "manifest.json");
      if (!existsSync(file)) continue;
      const r = Manifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
      assert.ok(r.success, `${name}: ${r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
  });
});

describe("trial limits", () => {
  const t = trialLimits(parse({ trial }))!;

  it("locked step: index >= steps, except the closing one", () => {
    assert.equal(trialStepLocked(t, 0, 4), false);
    assert.equal(trialStepLocked(t, 1, 4), false);
    assert.equal(trialStepLocked(t, 2, 4), true);
    assert.equal(trialStepLocked(t, 3, 4), true);
    assert.equal(trialStepLocked(t, 4, 4), false);
    const all = trialLimits(parse({ trial: { ...trial, steps: 4 } }))!;
    assert.equal(trialStepLocked(all, 3, 4), false);
  });

  it("balance for the whole trial (never negative)", () => {
    assert.deepEqual(trialLeft(t, null), { searchesLeft: 15, toolsLeft: { run_tests: 1 } });
    assert.deepEqual(trialLeft(t, { searchesUsed: 20, toolRuns: { run_tests: 1, a11y_check: 3 } }), { searchesLeft: 0, toolsLeft: { run_tests: 0 } });
  });
});

describe("tool input cap in the trial", () => {
  const cap = { maxFiles: 3, maxBytes: 30_000 };
  const link = "https://x/compra";
  const arr = (n: number, content = "x") => ({ files: Array.from({ length: n }, (_, i) => ({ path: `F${i}.tsx`, content })) });

  it("measures files and bytes in both formats of files", () => {
    assert.deepEqual(toolInputSize(arr(2, "abc")), { files: 2, bytes: 2 * (6 + 3) });
    assert.deepEqual(toolInputSize({ files: { "A.tsx": "abc", "B.tsx": "é" } }), { files: 2, bytes: 5 + 3 + 5 + 2 });
  });

  it("input without files: only the JSON bytes", () => {
    assert.deepEqual(toolInputSize({ colors: ["#fff"] }), { files: null, bytes: Buffer.byteLength('{"colors":["#fff"]}') });
    assert.deepEqual(toolInputSize(null), { files: null, bytes: 4 });
  });

  it("fits the cap: null", () => {
    assert.equal(trialToolCapError("run_tests", cap, arr(3), link), null);
    assert.equal(trialToolCapError("run_tests", undefined, arr(40), link), null);
    assert.equal(trialToolCapError("run_tests", { maxFiles: 1 }, { files: { "A.tsx": "x".repeat(100_000) } }, link), null);
  });

  it("over the cap: message without spending balance, with what was sent and the link", () => {
    const many = trialToolCapError("run_tests", cap, arr(5), link)!;
    assert.match(many, /^Nothing was run and no free-trial balance was spent\./);
    assert.match(many, /run_tests accepts up to 3 files and 30 KB per run \(you sent 5 files, 1 KB\)/);
    assert.match(many, /Buy: https:\/\/x\/compra$/);
    const big = trialToolCapError("a11y_check", cap, arr(1, "x".repeat(31_000)), link)!;
    assert.match(big, /you sent 1 file, 32 KB/); // 31,000 of content + the path, rounded up
    // Over by less than 1 KB: the amount sent must not show up equal to the cap.
    const barely = trialToolCapError("run_tests", cap, arr(1, "x".repeat(30_400)), link)!;
    assert.match(barely, /accepts up to 3 files and 30 KB per run \(you sent 1 file, 31 KB\)/);
    assert.ok(trialToolCapError("run_tests", { maxBytes: 10 }, { anything: "x".repeat(50) }, link));
  });

  it("a files-only or bytes-only limit shows up without the other", () => {
    assert.match(trialToolCapError("run_tests", { maxFiles: 1 }, arr(2), link)!, /accepts up to 1 file per run/);
    assert.match(trialToolCapError("run_tests", { maxBytes: 1000 }, arr(1, "x".repeat(2000)), link)!, /accepts up to 1 KB per run/);
  });
});

describe("trial texts", () => {
  const t = trialLimits(parse({ trial }))!;

  it("end of trial: name, what it unlocks, what only the license gives and the link", () => {
    assert.equal(
      trialEndText("Exemplo", t, "https://x/checkout"),
      "The free trial of Exemplo ends here: Você recebe o plano e o componente. With the lifetime license you also get: a revisão final com testes ilimitados. Buy: https://x/checkout",
    );
  });

  it("access line: steps, searches, tools and notice", () => {
    const line = trialAccessLine(t, { use: 1, totalSteps: 4, toolNames: ["run_tests", "a11y_check"] });
    assert.equal(
      line,
      "Free trial (use 1 of 3): unlocks steps 1 to 2 of 4, up to 15 knowledge base searches, and run_tests 1 time in total. After this one, 2 free uses are left. License only: a11y_check. Você recebe o plano e o componente. Tell the user about these limits before you start.",
    );
  });

  it("access line: tool cap and scope when the manifest defines them", () => {
    const capped = trialLimits(parse({ trial: { ...trial, tools: { run_tests: 1, a11y_check: 3 }, toolLimits: { run_tests: { maxFiles: 3, maxBytes: 30000 }, a11y_check: { maxFiles: 3 } }, scope: "1 componente por uso." } }))!;
    const line = trialAccessLine(capped, { use: 1, totalSteps: 4, toolNames: ["run_tests", "a11y_check"] });
    assert.match(line, /Size limit per run in the trial: run_tests accepts up to 3 files and 30 KB and a11y_check accepts up to 3 files\. Você recebe o plano e o componente\. Trial scope: 1 componente por uso\. Tell the user/);
  });

  it("access line: remaining balance, single step and no searches", () => {
    const one = trialLimits(parse({ trial: { ...trial, steps: 1, searches: 0, tools: { run_tests: 2 } } }))!;
    const line = trialAccessLine(one, { use: 2, totalSteps: 4, toolNames: ["run_tests"], usage: { searchesUsed: 0, toolRuns: { run_tests: 1 } } });
    assert.match(line, /^Free trial \(use 2 of 3\): unlocks step 1 of 4, no knowledge base searches, and run_tests 2 times \(1 left\) in total\./);
    const all = trialLimits(parse({ trial: { ...trial, steps: 4 } }))!;
    assert.match(trialAccessLine(all, { use: 1, totalSteps: 4, toolNames: [] }), /unlocks all 4 steps, up to 15 knowledge base searches/);
  });

  it("access line: remaining uses and last-use notice", () => {
    const at = (use: number) => trialAccessLine(t, { use, totalSteps: 4, toolNames: [] });
    assert.match(at(2), /After this one, 1 free use is left\./);
    assert.match(at(3), /This is the last free use\./);
  });

  it("library summary: remaining uses, searches and tools", () => {
    const at = new Date("2026-09-30T12:00:00Z");
    assert.deepEqual(myTrial("a1", t, 2, { searchesUsed: 5, toolRuns: { run_tests: 1 } }, at), {
      agentId: "a1",
      uses: 3,
      usesLeft: 1,
      searches: 15,
      searchesLeft: 10,
      tools: [{ name: "run_tests", limit: 1, left: 0 }],
      lastUsedAt: "2026-09-30T12:00:00.000Z",
    });
    assert.equal(myTrial("a1", t, 3, { searchesUsed: 0, toolRuns: {} }, at).usesLeft, 0);
  });
});

describe("paid access", () => {
  it("a guarantee gives access only while open (confirmed, not approved, refunded or closed)", () => {
    assert.equal(escrowGivesAccess({ status: "active", closed: false }), true);
    assert.equal(escrowGivesAccess({ status: "disputed", closed: false }), true);
    assert.equal(escrowGivesAccess({ status: "pending", closed: false }), false);
    assert.equal(escrowGivesAccess({ status: "approved", closed: false }), false);
    assert.equal(escrowGivesAccess({ status: "refunded", closed: false }), false);
    assert.equal(escrowGivesAccess({ status: "active", closed: true }), false);
  });

  it("paid access line", () => {
    assert.equal(paidAccessLine("license"), "Access: lifetime license.");
    assert.equal(paidAccessLine("guarantee"), "Access: guaranteed task (no limits while the guarantee is open).");
  });
});
