import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  declaredTemplates,
  lookupTemplate,
  MAX_TEMPLATE_BYTES,
  readTemplateFile,
  renderTemplate,
  templateProblemText,
  templatesOverview,
  trialTemplateNames,
  visibleTemplates,
  type TemplateDecl,
} from "../src/runtime/templates.js";
import { PackagePathError } from "../src/runtime/package-paths.js";
import { trialAccessLine, trialLimits } from "../src/runtime/trial.js";
import { Manifest } from "../src/runtime/manifest.js";
import { ManifestV1 } from "../src/runtime/validate/schema-v1.js";

// Package templates (PACKAGE_SPEC.md 7): only what is declared, only .md/.txt/.json, in the trial only trial.templates. No env or database.

const root = mkdtempSync(join(tmpdir(), "solvers-tpl-"));
after(() => rmSync(root, { recursive: true, force: true }));

const md: TemplateDecl = { name: "briefing", path: "templates/briefing.md", title: "Briefing", description: "Modelo do briefing" };
const json: TemplateDecl = { name: "caso", path: "templates/caso.json", title: "Caso de eval", description: "Esqueleto de um caso" };
const svg: TemplateDecl = { name: "logo", path: "templates/logo.svg", title: "Logo", description: "Imagem" };
const html: TemplateDecl = { name: "pagina", path: "templates/pagina.html", title: "Página", description: "HTML" };
const decls = [md, json, svg, html];

describe("lookupTemplate", () => {
  it("finds the declared one by name", () => {
    const r = lookupTemplate(decls, "briefing", null);
    assert.equal(r.ok && r.decl.path, "templates/briefing.md");
  });

  it("nothing beyond what is declared: unknown name and a package without templates", () => {
    assert.deepEqual(lookupTemplate(decls, "segredo", null), { ok: false, reason: "unknown" });
    assert.deepEqual(lookupTemplate([], "briefing", null), { ok: false, reason: "none_declared" });
  });

  it("only .md, .txt and .json: declared svg and html are never served", () => {
    assert.deepEqual(lookupTemplate(decls, "logo", null), { ok: false, reason: "type_not_allowed" });
    assert.deepEqual(lookupTemplate(decls, "pagina", null), { ok: false, reason: "type_not_allowed" });
    assert.equal(lookupTemplate(decls, "caso", null).ok, true);
    const txt = { ...md, name: "nota", path: "templates/NOTA.TXT" };
    assert.equal(lookupTemplate([txt], "nota", null).ok, true, "an uppercase extension also works");
  });

  it("in the free trial, only those in trial.templates", () => {
    const trial = { templates: ["briefing"] };
    assert.equal(lookupTemplate(decls, "briefing", trial).ok, true);
    assert.deepEqual(lookupTemplate(decls, "caso", trial), { ok: false, reason: "not_in_trial" });
    // Trial with no template unlocked (the default): none is served.
    assert.deepEqual(lookupTemplate(decls, "briefing", { templates: [] }), { ok: false, reason: "not_in_trial" });
  });
});

describe("texts for the AI", () => {
  it("the error lists what exists, and in the trial only the unlocked ones", () => {
    assert.match(templateProblemText("unknown", "x", [md, json]), /Available: briefing, caso/);
    assert.match(templateProblemText("not_in_trial", "caso", [md]), /not part of the free trial.*Available in the trial: briefing/);
    assert.match(templateProblemText("none_declared", "x", []), /has no templates/);
    assert.match(templateProblemText("type_not_allowed", "logo", []), /not a text file/);
  });

  it("the overview lists the templates; in the trial, only the unlocked ones and how many remain for the license", () => {
    const all = templatesOverview([md, json], null).join("\n");
    assert.match(all, /## Available templates \(request the content with get_template\)/);
    assert.match(all, /- briefing: Briefing\. Modelo do briefing/);
    assert.match(all, /- caso: Caso de eval/);

    const trial = templatesOverview([md, json], { templates: ["briefing"] }).join("\n");
    assert.match(trial, /briefing/);
    assert.doesNotMatch(trial, /- caso:/);
    assert.match(trial, /1 more template with the license only/);
  });

  it("without templates (or none unlocked and none locked) the section is omitted", () => {
    assert.deepEqual(templatesOverview([], null), []);
    assert.deepEqual(templatesOverview([], { templates: [] }), []);
  });

  it("visibleTemplates and the manifest fields", () => {
    assert.deepEqual(visibleTemplates(decls, null).length, 4);
    assert.deepEqual(visibleTemplates(decls, { templates: ["caso"] }), [json]);
    assert.deepEqual(declaredTemplates({}), []);
    assert.deepEqual(trialTemplateNames({}), []);
    assert.deepEqual(trialTemplateNames({ trial: { templates: ["a"] } }), ["a"]);
  });
});

describe("renderTemplate", () => {
  it("the content stays intact inside a fence, and the watermark goes outside it", () => {
    const out = renderTemplate(json, '{ "id": "caso-1" }\n', "MARCA");
    assert.match(out, /^# Template: Caso de eval \(caso\)/);
    assert.ok(out.includes('```json\n{ "id": "caso-1" }\n```'));
    assert.ok(out.endsWith("MARCA"));
  });

  it("the fence grows when the content already has backticks", () => {
    const out = renderTemplate(md, "antes\n```js\nx\n```\ndepois", "M");
    assert.ok(out.includes("````\nantes\n```js\nx\n```\ndepois\n````"));
  });
});

describe("readTemplateFile: disk", () => {
  const dir = join(root, "pkg");
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(join(dir, "templates", "briefing.md"), "# Briefing\n\nPreencha aqui.\n");
  writeFileSync(join(dir, "templates", "grande.md"), "x".repeat(MAX_TEMPLATE_BYTES + 1));
  writeFileSync(join(dir, "templates", "binario.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  writeFileSync(join(root, "segredo.md"), "SEGREDO");

  it("reads the template file", () => {
    assert.match(readTemplateFile(dir, md), /Preencha aqui/);
  });

  it("a manifest path that escapes the folder is refused (package-paths)", () => {
    for (const path of ["../segredo.md", "templates/../../segredo.md", "/etc/passwd", "steps/01.md", "templates//briefing.md"]) {
      assert.throws(() => readTemplateFile(dir, { ...md, path }), PackagePathError, path);
    }
  });

  it("a symbolic link inside templates/ is refused (when the system allows creating one)", (t) => {
    try {
      symlinkSync(join(root, "segredo.md"), join(dir, "templates", "atalho.md"));
    } catch {
      t.skip("no permission to create a symbolic link on this system");
      return;
    }
    assert.throws(() => readTemplateFile(dir, { ...md, path: "templates/atalho.md" }), /symbolic link/);
  });

  it("a file that is too large or not UTF-8 is not served", () => {
    assert.throws(() => readTemplateFile(dir, { ...md, path: "templates/grande.md" }), /exceeds/);
    assert.throws(() => readTemplateFile(dir, { ...md, path: "templates/binario.md" }));
  });
});

describe("trial.templates in the manifest", () => {
  const base = {
    id: "0123456789abcdef0123456789abcdef", slug: "meu-solver", name: "Meu Solver", tagline: "Uma frase de valor", description: "Descrição", category: "Outros", version: "1.0.0",
    creator: { id: "c", name: "C", bio: "b" }, requirements: [], packageContents: [], steps: [{ file: "steps/01.md", gate: [] }, { file: "steps/02.md", gate: [] }],
    pricing: { priceUsdc: 5, royaltyBps: 0 }, guarantee: { available: false, defaultCriteria: [] },
  };
  const trial = { uses: 1, steps: 1, searches: 1, tools: {}, summary: "Etapa 1 e um modelo.", lockedSummary: "O restante." };

  it("v1 keeps trial.templates; v0 (old zod) drops it and the trial has no templates", () => {
    const v1 = ManifestV1.parse({ ...base, specVersion: 1, terms: { rightsConfirmed: true, sourcesListed: true }, templates: [md], trial: { ...trial, templates: ["briefing"] } });
    assert.deepEqual(trialLimits(v1 as never)!.templates, ["briefing"]);
    const v0 = Manifest.parse({ ...base, trial: { ...trial, templates: ["briefing"] } });
    assert.deepEqual(trialLimits(v0)!.templates, []);
  });

  it("the trial access line lists the unlocked templates (and only when there are some)", () => {
    const withT = trialLimits({ trial: { available: true, uses: 3, steps: 1, searches: 1, tools: {}, toolLimits: {}, summary: "Etapa 1.", lockedSummary: "O resto.", templates: ["briefing"] } } as never)!;
    const noT = trialLimits({ trial: { available: true, uses: 3, steps: 1, searches: 1, tools: {}, toolLimits: {}, summary: "Etapa 1.", lockedSummary: "O resto." } } as never)!;
    assert.match(trialAccessLine(withT, { use: 1, totalSteps: 2, toolNames: [] }), /Templates available in the trial \(get_template\): briefing/);
    assert.doesNotMatch(trialAccessLine(noT, { use: 1, totalSteps: 2, toolNames: [] }), /Templates available/);
  });
});
