import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AgentTranslations,
  creatorBioFor,
  langFromAcceptLanguage,
  localeFilePath,
  overlayCatalogTexts,
  PackageLocale,
  parseCatalogLang,
  resolveCatalogLang,
  type CatalogTexts,
} from "./index.js";

const base: CatalogTexts & { id: string } = {
  id: "a1",
  name: "Frontend Builder",
  tagline: "Ship clean React screens",
  description: "English description",
  packageContents: ["Method", "Knowledge base", "Templates"],
  requirements: [
    { type: "client", key: "any", label: "Claude or ChatGPT" },
    { type: "plan", key: "paid", label: "Paid plan recommended", optional: true },
    { type: "connector", label: "No key" },
  ],
};

const pt = PackageLocale.parse({
  name: "Construtor de Front",
  tagline: "Telas React limpas",
  description: "Descrição em português",
  packageContents: ["Método", "Base de conhecimento"],
  requirements: [{ key: "any", label: "Claude ou ChatGPT" }],
  searchPhrases: ["quero um site bonito"],
  creatorBio: "Bio em português",
});

describe("PackageLocale (locales/pt.json)", () => {
  it("accepts the full file and defaults missing requirements", () => {
    const min = PackageLocale.parse({ name: "N", tagline: "T", description: "D", packageContents: ["x"] });
    assert.deepEqual(min.requirements, []);
    assert.equal(min.searchPhrases, undefined);
    assert.equal(pt.requirements[0]!.key, "any");
  });

  it("recusa campo desconhecido, campo vazio e lista vazia", () => {
    assert.equal(PackageLocale.safeParse({ ...pt, extra: 1 }).success, false);
    assert.equal(PackageLocale.safeParse({ ...pt, name: "  " }).success, false);
    assert.equal(PackageLocale.safeParse({ ...pt, packageContents: [] }).success, false);
    assert.equal(PackageLocale.safeParse({ ...pt, requirements: [{ label: "sem key" }] }).success, false);
    assert.equal(PackageLocale.safeParse({ ...pt, searchPhrases: ["ab"] }).success, false);
  });

  it("AgentTranslations only accepts the pt language", () => {
    assert.equal(AgentTranslations.safeParse({}).success, true);
    assert.equal(AgentTranslations.safeParse({ pt }).success, true);
    assert.equal(AgentTranslations.safeParse({ es: pt }).success, false);
    assert.equal(localeFilePath("pt"), "locales/pt.json");
  });
});

describe("catalog language", () => {
  it("parseCatalogLang understands region variants and rejects the rest", () => {
    assert.equal(parseCatalogLang("pt"), "pt");
    assert.equal(parseCatalogLang("pt-BR"), "pt");
    assert.equal(parseCatalogLang("PT_br"), "pt");
    assert.equal(parseCatalogLang("en-US"), "en");
    assert.equal(parseCatalogLang("fr"), undefined);
    assert.equal(parseCatalogLang(undefined), undefined);
    assert.equal(parseCatalogLang(42), undefined);
  });

  it("Accept-Language honors q and ignores languages not served", () => {
    assert.equal(langFromAcceptLanguage("pt-BR,pt;q=0.9,en;q=0.8"), "pt");
    assert.equal(langFromAcceptLanguage("en-US,en;q=0.9,pt;q=0.8"), "en");
    assert.equal(langFromAcceptLanguage("fr-FR,fr;q=0.9,pt;q=0.5"), "pt");
    assert.equal(langFromAcceptLanguage("en;q=0.3, pt;q=0.9"), "pt");
    assert.equal(langFromAcceptLanguage("pt;q=0, en"), "en");
    assert.equal(langFromAcceptLanguage("*"), "en");
    assert.equal(langFromAcceptLanguage("de"), "en");
    assert.equal(langFromAcceptLanguage(""), "en");
    assert.equal(langFromAcceptLanguage(undefined), "en");
  });

  it("?lang wins over the header; an invalid value falls back to the header; with neither, English", () => {
    assert.equal(resolveCatalogLang("en", "pt-BR"), "en");
    assert.equal(resolveCatalogLang("pt", "en"), "pt");
    assert.equal(resolveCatalogLang("xx", "pt-BR"), "pt");
    assert.equal(resolveCatalogLang(undefined, undefined), "en");
  });
});

describe("overlayCatalogTexts", () => {
  it("English returns the object itself, even with a translation", () => {
    assert.equal(overlayCatalogTexts(base, { pt }, "en"), base);
  });

  it("pt without a translation falls back to English (same object)", () => {
    assert.equal(overlayCatalogTexts(base, {}, "pt"), base);
    assert.equal(overlayCatalogTexts(base, null, "pt"), base);
    assert.equal(overlayCatalogTexts(base, undefined, "pt"), base);
  });

  it("pt replaces name, tagline, description and the contents list", () => {
    const out = overlayCatalogTexts(base, { pt }, "pt");
    assert.equal(out.name, "Construtor de Front");
    assert.equal(out.tagline, "Telas React limpas");
    assert.equal(out.description, "Descrição em português");
    assert.deepEqual(out.packageContents, ["Método", "Base de conhecimento"]);
    assert.equal(out.id, "a1"); // the rest of the object does not change
  });

  it("requirements: only the label changes, by key; without a key in the translation or the manifest it stays in English", () => {
    const out = overlayCatalogTexts(base, { pt }, "pt");
    assert.deepEqual(out.requirements[0], { type: "client", key: "any", label: "Claude ou ChatGPT" });
    assert.deepEqual(out.requirements[1], base.requirements[1]); // "paid" is not in the translation
    assert.deepEqual(out.requirements[2], base.requirements[2]); // no key
    assert.equal(out.requirements[1]!.optional, true);
  });

  it("does not mutate the input object", () => {
    const copy = structuredClone(base);
    overlayCatalogTexts(base, { pt }, "pt");
    assert.deepEqual(base, copy);
  });
});

describe("creatorBioFor", () => {
  it("pt uses the first translated creatorBio; en and no translation keep the original", () => {
    assert.equal(creatorBioFor("Bio", [{}, { pt }], "pt"), "Bio em português");
    assert.equal(creatorBioFor("Bio", [{ pt }], "en"), "Bio");
    assert.equal(creatorBioFor("Bio", [{}, null, undefined], "pt"), "Bio");
    assert.equal(creatorBioFor("Bio", [{ pt: { ...pt, creatorBio: undefined } }], "pt"), "Bio");
  });
});
