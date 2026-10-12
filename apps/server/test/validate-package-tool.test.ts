import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { z } from "zod";
import { buildPackage, MAX_INPUT_BYTES, summarize, validatePackageTool, ValidatePackageInput } from "../src/runtime/validate-package-tool.js";
import type { SolverPackage } from "../src/runtime/package-loader.js";

// builtin:validate-package tool of the Solver Creator (PACKAGE_SPEC.md 13 and 19). No env or database.

const STEP = `# Receitas do mês

## Objetivo
Somar as receitas do mês do MEI e conferir o limite anual de faturamento, para que o usuário saiba quanto ainda pode faturar sem sair do regime.

## O que perguntar ao usuário
- Quais notas fiscais ou recibos de receita existem neste mês?
- Algum valor entrou por transferência sem nota?

## Como executar
1. Peça a lista de receitas do mês, uma por linha, com data e valor.
2. Some os valores e compare com o limite anual informado na base de conhecimento.
3. Mostre ao usuário o total do mês, o acumulado do ano e quanto resta do limite.

## Erros comuns
- Esquecer receitas recebidas em dinheiro ou por Pix sem nota fiscal emitida.

## Formato do result_summary
Total do mês, acumulado do ano e limite restante, em reais, em uma linha cada.
`;

const manifest = (over: Record<string, unknown> = {}) => ({
  specVersion: 1,
  slug: "fechamento-do-mei",
  name: "Fechamento do MEI",
  tagline: "Fecha o mês do seu MEI sem esquecer o limite de faturamento",
  description:
    "Guia o microempreendedor individual no fechamento mensal: soma as receitas, confere o limite anual de faturamento e monta o relatório do mês. Não faz a declaração anual, não substitui o contador e não calcula impostos de outros regimes.",
  category: "Negócios",
  version: "1.0.0",
  creator: { id: "x", name: "Maria", bio: "Contadora" },
  requirements: [],
  packageContents: ["Método em uma etapa com checklist", "Relatório mensal pronto", "Limite do MEI conferido"],
  steps: [{ file: "steps/01-receitas.md", gate: ["Receitas do mês somadas", "Limite anual conferido"] }],
  pricing: { priceUsdc: 5, royaltyBps: 500 },
  guarantee: { available: false, defaultCriteria: [] },
  terms: { rightsConfirmed: true, sourcesListed: true },
  versions: [{ version: "1.0.0", releasedAt: "2026-10-01", notes: "Primeira versão" }],
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({ manifest: manifest(), steps: [{ file: "steps/01-receitas.md", content: STEP }], ...over });

describe("validatePackageTool: good input", () => {
  it("valid manifest and step: ok, no errors, summary in English and stats", () => {
    const out = validatePackageTool(input());
    assert.deepEqual(out.errors, []);
    assert.equal(out.ok, true);
    assert.equal(out.stats.steps, 1);
    assert.equal(out.stats.specVersion, 1);
    assert.match(out.summary, /Manifest and steps have no errors/);
    assert.match(out.summary, /full validation/);
    // No knowledge or evals in the input: the summary says they were not checked (and does not complain about missing cases).
    assert.match(out.summary, /knowledge base was not sent/);
    assert.match(out.summary, /eval cases were not sent/);
    assert.ok(!out.warnings.some((w) => w.code === "EVAL_TOO_FEW_CASES"));
  });

  it("the response has the shape { ok, errors, warnings, stats, summary }", () => {
    assert.deepEqual(Object.keys(validatePackageTool(input())).sort(), ["errors", "ok", "stats", "summary", "warnings"]);
  });
});

describe("validatePackageTool: errors with code, path, message and fix", () => {
  it("third party without specVersion, with platform and internal tools: errors", () => {
    const out = validatePackageTool(input({ manifest: manifest({ specVersion: undefined, platform: true, tools: [{ name: "validate_package", description: "x", runner: "builtin:validate-package" }] }) }));
    assert.equal(out.ok, false);
    const codes = out.errors.map((e) => e.code);
    assert.ok(codes.includes("MANIFEST_SPEC_VERSION"), codes.join());
    assert.ok(codes.includes("MANIFEST_PLATFORM_FORBIDDEN"), codes.join());
    assert.ok(codes.includes("TOOL_FORBIDDEN_RUNNER"), codes.join());
    for (const e of out.errors) {
      assert.ok(e.code && e.message && e.fix, JSON.stringify(e));
      assert.equal(typeof e.path, "string");
    }
  });

  it("step too short and without sections: one error per section, pointing at the file", () => {
    const out = validatePackageTool(input({ steps: [{ file: "steps/01-receitas.md", content: "# Só um título\n\nPouco texto." }] }));
    assert.equal(out.ok, false);
    const sections = out.errors.filter((e) => e.code === "STEP_SECTION_MISSING");
    assert.equal(sections.length, 3);
    assert.ok(sections.every((e) => e.path === "steps/01-receitas.md"));
    assert.ok(out.errors.some((e) => e.code === "STEP_TOO_SHORT_LONG"));
  });

  it("declared step without its text sent: STEP_FILE_MISSING", () => {
    const out = validatePackageTool(input({ steps: [] }));
    assert.ok(out.errors.some((e) => e.code === "STEP_FILE_MISSING" && e.path.endsWith("steps.0.file")));
  });

  it("reserved slug, forbidden category and price below the minimum", () => {
    const out = validatePackageTool(input({ manifest: manifest({ slug: "criador-de-solvers", category: "Jurídico", pricing: { priceUsdc: 2, royaltyBps: 0 } }) }));
    const codes = out.errors.map((e) => e.code);
    assert.ok(codes.includes("MANIFEST_SLUG_RESERVED"), codes.join());
    assert.ok(codes.includes("MANIFEST_CATEGORY_FORBIDDEN"), codes.join());
    assert.ok(codes.includes("MANIFEST_PRICE_BELOW_MIN"), codes.join());
  });

  it("the summary lists the errors, manifest first, with what to fix", () => {
    const out = validatePackageTool(input({ manifest: manifest({ terms: undefined }), steps: [{ file: "steps/01-receitas.md", content: "curto" }] }));
    assert.match(out.summary, /errors? to fix\. Start with:/);
    assert.match(out.summary, /1\) TERMS_MISSING/);
    assert.match(out.summary, /Fix:/);
    const first = out.summary.split("\n")[1]!;
    assert.match(first, /^1\) /);
  });

  it("unknown manifest field: MANIFEST_UNKNOWN_FIELD with the field path", () => {
    const out = validatePackageTool(input({ manifest: manifest({ inventado: 1 }) }));
    assert.ok(out.errors.some((e) => e.code === "MANIFEST_UNKNOWN_FIELD" && e.path === "manifest.json#inventado"));
  });
});

describe("validatePackageTool: files, knowledge, templates and evals", () => {
  const knowledge = `---\nsource: Receita Federal\nsource_date: 2026-01-10\n---\n# Limite do MEI\n\nO limite anual é de 81 mil reais.`;

  it("knowledge with front-matter passes; without a source it is an error", () => {
    const ok = validatePackageTool(input({ knowledge: [{ path: "knowledge/limite.md", head: knowledge }] }));
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.stats.knowledgeFiles, 1);
    assert.doesNotMatch(ok.summary, /knowledge base was not sent/);
    const bad = validatePackageTool(input({ knowledge: [{ path: "knowledge/limite.md", head: "# Sem fonte\n\ntexto" }] }));
    assert.ok(bad.errors.some((e) => e.code === "KNOWLEDGE_SOURCE_MISSING"));
  });

  it("the chunk cap does not apply to file heads (no way to estimate)", () => {
    const out = validatePackageTool(input({ knowledge: [{ path: "knowledge/limite.md", head: knowledge }], files: [{ path: "knowledge/limite.md", size: 9_000_000 }] }));
    assert.ok(!out.errors.some((e) => e.code === "KNOWLEDGE_TOO_BIG"));
  });

  it("a declared template without a file is an error only when the input says which files exist", () => {
    const m = manifest({ templates: [{ name: "relatorio", path: "templates/relatorio.md", title: "Relatório", description: "Relatório do mês" }] });
    assert.ok(!validatePackageTool(input({ manifest: m })).errors.some((e) => e.code === "TEMPLATE_MISSING"), "without files or templates there is no way to know");
    assert.ok(validatePackageTool(input({ manifest: m, files: [{ path: "manifest.json", size: 100 }] })).errors.some((e) => e.code === "TEMPLATE_MISSING"));
    const ok = validatePackageTool(input({ manifest: m, templates: [{ path: "templates/relatorio.md", content: "# Relatório" }] }));
    assert.ok(!ok.errors.some((e) => e.code === "TEMPLATE_MISSING"));
  });

  it("sent eval cases are checked (invalid is an error); too few cases only counts when evals are sent", () => {
    const bad = validatePackageTool(input({ evals: [{ path: "evals/cases/a.json", content: "{ nao json" }] }));
    assert.ok(bad.errors.some((e) => e.code === "EVAL_CASE_INVALID"));
    assert.ok(bad.errors.some((e) => e.code === "EVAL_TOO_FEW_CASES"), "with evals in the input the minimum applies");
  });

  it("eval or knowledge without the folder in the path: the summary warns they do not count (and with the right path, it does not)", () => {
    const caseJson = JSON.stringify({ id: "a", input: "pedido", checks: [{ type: "contains", value: "x", description: "d" }] });
    const short = validatePackageTool(input({ evals: [{ path: "a.json", content: caseJson }], knowledge: [{ path: "tema.md", head: knowledge }] }));
    assert.match(short.summary, /evals\/cases\/NN-name\.json/);
    assert.match(short.summary, /knowledge\/name\.md/);
    const full = validatePackageTool(input({ evals: [{ path: "evals/cases/a.json", content: caseJson }], knowledge: [{ path: "knowledge/tema.md", head: knowledge }] }));
    assert.doesNotMatch(full.summary, /full path/);
  });

  it("file type outside the Core in the file list: FILE_TYPE_NOT_ALLOWED", () => {
    const out = validatePackageTool(input({ files: [{ path: "manifest.json", size: 10 }, { path: "knowledge/livro.pdf", size: 1000 }] }));
    assert.ok(out.errors.some((e) => e.code === "FILE_TYPE_NOT_ALLOWED" && e.path === "knowledge/livro.pdf"));
  });
});

describe("validatePackageTool: invalid input", () => {
  it("extra field, wrong types and a repeated path are refused", () => {
    assert.throws(() => validatePackageTool({ ...input(), extra: 1 }), z.ZodError);
    assert.throws(() => validatePackageTool({ manifest: "texto", steps: [] }), z.ZodError);
    assert.throws(() => validatePackageTool({ steps: [] }), z.ZodError);
    assert.throws(
      () => validatePackageTool(input({ steps: [{ file: "steps/01-receitas.md", content: STEP }], templates: [{ path: "steps/01-receitas.md", content: "x" }] })),
      (e: unknown) => (e as { status?: number }).status === 400 && /more than once/.test((e as Error).message),
    );
  });

  it("above 1 MB: 400 with the reason", () => {
    const big = "x".repeat(190_000);
    const steps = Array.from({ length: 6 }, (_, i) => ({ file: `steps/0${i}.md`, content: big }));
    assert.throws(() => validatePackageTool({ manifest: manifest(), steps }), (e: unknown) => (e as { status?: number }).status === 400 && new RegExp(String(MAX_INPUT_BYTES)).test((e as Error).message));
  });

  it("ValidatePackageInput accepts only the contract (manifest, steps, files, knowledge, templates, evals)", () => {
    assert.equal(ValidatePackageInput.safeParse(input({ files: [{ path: "a.md", size: 1 }], knowledge: [], templates: [], evals: [] })).success, true);
    assert.equal(ValidatePackageInput.safeParse(input({ files: [{ path: "a.md", size: -1 }] })).success, false);
  });
});

describe("buildPackage", () => {
  it("the file size comes from files when present; otherwise from the content", () => {
    const pkg = buildPackage(ValidatePackageInput.parse(input({ files: [{ path: "steps/01-receitas.md", size: 777 }] })));
    assert.equal(pkg.entries.find((e) => e.path === "steps/01-receitas.md")!.size, 777);
    const noFiles = buildPackage(ValidatePackageInput.parse(input()));
    assert.equal(noFiles.entries.find((e) => e.path === "steps/01-receitas.md")!.size, Buffer.byteLength(STEP));
    assert.ok(noFiles.read("manifest.json"));
    assert.equal(noFiles.read("nao-existe.md"), undefined);
  });
});

describe("summarize", () => {
  const e = (code: string) => ({ code: code as never, path: "p", message: "m", fix: "f" });
  it("shows at most 5 and says how many are left", () => {
    const s = summarize(Array.from({ length: 8 }, () => e("STEP_SECTION_MISSING")), []);
    assert.match(s, /8 errors to fix/);
    assert.match(s, /5\) /);
    assert.doesNotMatch(s, /6\) /);
    assert.match(s, /3 left/);
  });
  it("no errors and some warnings: counts the warnings", () => {
    assert.match(summarize([], [e("TEXT_HIDDEN_CHARS"), e("TEXT_HIDDEN_CHARS")]), /There are 2 warnings/);
    assert.match(summarize([], [e("TEXT_HIDDEN_CHARS")]), /There is 1 warning /);
  });
});

describe("runServerTool: builtin:validate-package only runs in a platform package", () => {
  let runServerTool: typeof import("../src/runtime/tools.js").runServerTool;
  before(async () => {
    // tools.ts imports the verifier, which reads the server env: fake values are enough (nothing is called here).
    Object.assign(process.env, {
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
    });
    ({ runServerTool } = await import("../src/runtime/tools.js"));
  });

  const pkg = (source: "agents" | "published"): SolverPackage =>
    ({
      manifest: { id: "c71ad0a50f750e75c71ad0a50f750e75", slug: "criador-de-solvers", tools: [{ name: "validate_package", description: "d", runner: "builtin:validate-package" }] } as never,
      dir: "/x",
      steps: [],
      versionHash: "",
      evalReport: null,
      usesMemory: false,
      translations: {},
      source,
    }) as unknown as SolverPackage;

  it("a platform package runs it", async () => {
    const out = (await runServerTool(pkg("agents"), "validate_package", input())) as { ok: boolean };
    assert.equal(out.ok, true);
  });

  it("a creator package with the same runner is refused", async () => {
    await assert.rejects(runServerTool(pkg("published"), "validate_package", input()), (e: unknown) => (e as { status?: number }).status === 400 && /not available/.test((e as Error).message));
  });

  it("invalid input becomes 400 with the reason (not 500)", async () => {
    await assert.rejects(runServerTool(pkg("agents"), "validate_package", { steps: [] }), (e: unknown) => (e as { status?: number }).status === 400 && /Invalid input/.test((e as Error).message));
  });
});
