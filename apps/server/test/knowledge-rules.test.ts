import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkMarkdown, chunkPlainText } from "../src/knowledge/chunk.js";
import { isKnowledgeFile, normalizeMeta, parseKnowledgeFile } from "../src/knowledge/file-rules.js";
import { QUOTA_WINDOW_MS, dateText, hitText, hitsText, isStale, quotaExceeded, quotaText, trialFilesOnly } from "../src/knowledge/search-rules.js";

// Pure knowledge rules (PACKAGE_SPEC.md 6): reading .md/.txt, front-matter, validity notice,
// v1 free trial and daily quota. No env or database.

const MD = `---
title: Rotativo do cartão
source: Banco Central do Brasil, Resolução CMN 4.549
source_url: https://www.bcb.gov.br/x
source_date: 2026-09-01
valid_until: 2026-12-31
tags: [juros, cartão]
trial: true
---
# Rotativo

Texto do rotativo.
`;

describe("parseKnowledgeFile .md", () => {
  it("front-matter becomes meta and valid_until; the body does not include the --- block", () => {
    const p = parseKnowledgeFile("knowledge/rotativo.md", MD);
    assert.deepEqual(p.meta, {
      title: "Rotativo do cartão",
      source: "Banco Central do Brasil, Resolução CMN 4.549",
      source_url: "https://www.bcb.gov.br/x",
      source_date: "2026-09-01",
      valid_until: "2026-12-31",
      tags: ["juros", "cartão"],
      trial: true,
    });
    assert.equal(p.validUntil, "2026-12-31");
    assert.equal(p.chunks.length, 1);
    assert.doesNotMatch(p.chunks[0]!, /---|source:/);
    assert.match(p.chunks[0]!, /Texto do rotativo/);
  });

  it("v0 package (no front-matter): chunks identical to chunkMarkdown, no meta", () => {
    const md = "# A\n\ntexto\n\n## B\n\noutro";
    const p = parseKnowledgeFile("a.md", md);
    assert.deepEqual(p.chunks, chunkMarkdown(md));
    assert.equal(p.meta, null);
    assert.equal(p.validUntil, null);
  });

  it("no title: uses the first heading of the text", () => {
    const p = parseKnowledgeFile("a.md", "---\nsource: Fonte X\n---\n# Meu título\n\ncorpo");
    assert.equal(p.meta?.title, "Meu título");
  });

  it("an invalid date is dropped; trial only with true; tags limited to 10", () => {
    const p = parseKnowledgeFile("a.md", "---\nsource: S\nvalid_until: 2026-02-30\ntrial: false\ntags: [a,b,c,d,e,f,g,h,i,j,k,l]\n---\ncorpo");
    assert.equal(p.validUntil, null);
    assert.equal(p.meta?.valid_until, undefined);
    assert.equal(p.meta?.trial, undefined);
    assert.equal(p.meta?.tags?.length, 10);
  });

  it("broken front-matter: the file is ingested without meta (the validator refuses it at publication)", () => {
    const p = parseKnowledgeFile("a.md", "---\nisto não é yaml\n---\ncorpo");
    assert.equal(p.meta, null);
    assert.ok(p.chunks.length >= 1);
  });
});

describe("parseKnowledgeFile .txt", () => {
  it("single section: lines with # do not become headings", () => {
    const txt = "# não é título\nlinha 2\n\n# outra linha\nlinha 4";
    const p = parseKnowledgeFile("a.txt", txt);
    assert.equal(p.chunks.length, 1);
    assert.deepEqual(chunkMarkdown(txt).length, 2); // the .md would have split
  });

  it("metadata comes from .txt.meta.json", () => {
    const p = parseKnowledgeFile("a.txt", "conteúdo", JSON.stringify({ title: "T", source: "Fonte", valid_until: "2026-01-01", trial: true, tags: ["x"] }));
    assert.equal(p.meta?.source, "Fonte");
    assert.equal(p.meta?.trial, true);
    assert.equal(p.validUntil, "2026-01-01");
  });

  it("invalid or missing .meta.json: no meta", () => {
    assert.equal(parseKnowledgeFile("a.txt", "x y z", "{quebrado").meta, null);
    assert.equal(parseKnowledgeFile("a.txt", "x y z").meta, null);
  });

  it("long text is split by size; empty text yields no excerpt", () => {
    const big = Array.from({ length: 40 }, (_, i) => `parágrafo ${i} ${"x".repeat(150)}`).join("\n\n");
    assert.ok(chunkPlainText(big).length > 1);
    assert.deepEqual(chunkPlainText("   \n "), []);
  });

  it("only .md and .txt are ingested; .txt.meta.json and the rest are not", () => {
    assert.equal(isKnowledgeFile("a.md"), true);
    assert.equal(isKnowledgeFile("a.TXT"), true);
    assert.equal(isKnowledgeFile("a.txt.meta.json"), false);
    assert.equal(isKnowledgeFile("a.pdf"), false);
    assert.equal(normalizeMeta({}), null);
  });
});

describe("validity notice and excerpt text", () => {
  const meta = { title: "Rotativo", source: "BCB, Res. 4.549", source_url: "https://bcb.gov.br/x", source_date: "2026-09-01" };

  it("dateBr and isStale (the valid_until day is still valid)", () => {
    assert.equal(dateText("2026-12-31"), "2026-12-31");
    assert.equal(dateText(null), "");
    assert.equal(isStale("2026-10-01", new Date("2026-10-02T12:00:00Z")), true);
    assert.equal(isStale("2026-10-02", new Date("2026-10-02T23:59:00Z")), false);
    // The day is Brasília's: 10 p.m. on 10/02 there is already 10/03 in UTC, and the validity day still holds.
    assert.equal(isStale("2026-10-02", new Date("2026-10-03T01:00:00Z")), false);
    assert.equal(isStale("2026-10-02", new Date("2026-10-03T04:00:00Z")), true);
    assert.equal(isStale(null, new Date()), false);
  });

  it("an expired excerpt shows 'may be out of date (valid until YYYY-MM-DD)'", () => {
    const t = hitText({ source: "knowledge/a.md", content: "corpo", meta, validUntil: "2026-10-01" }, 1, new Date("2026-10-05T00:00:00Z"));
    assert.match(t, /may be out of date \(valid until 2026-10-01\)/);
    assert.match(t, /Source: BCB, Res\. 4\.549/);
    assert.match(t, /source date: 2026-09-01/);
    assert.match(t, /### Excerpt 1: Rotativo/);
  });

  it("an excerpt within its validity shows no notice", () => {
    const t = hitText({ source: "knowledge/a.md", content: "corpo", meta, validUntil: "2026-12-31" }, 1, new Date("2026-10-05T00:00:00Z"));
    assert.doesNotMatch(t, /out of date/);
  });

  it("v0 package (no meta): old header, no instruction to cite", () => {
    const hits = [{ source: "knowledge/a.md", content: "corpo", meta: null, validUntil: null }];
    assert.equal(hitText(hits[0]!, 2, new Date()), "### Excerpt 2 (knowledge/a.md)\ncorpo");
    const all = hitsText(hits, new Date(), "MARCA");
    assert.doesNotMatch(all, /Cite the source/);
    assert.ok(all.endsWith("\n\nMARCA"));
  });

  it("with a source: instruction to cite, at most what came back, and the watermark at the end", () => {
    const hits = [{ source: "knowledge/a.md", content: "corpo", meta, validUntil: "2026-01-01" }];
    const all = hitsText(hits, new Date("2026-10-05T00:00:00Z"), "MARCA");
    assert.match(all, /Cite the source of each excerpt/);
    assert.match(all, /suggesting confirming it at the source|suggest confirming it at the source/);
    assert.ok(all.endsWith("\n\nMARCA"));
  });
});

describe("free trial and quota", () => {
  it("free trial: only v1 filters by trial:true; v0 keeps the whole base; a license does not filter", () => {
    assert.equal(trialFilesOnly({ specVersion: 1, accessIsTrial: true }), true);
    assert.equal(trialFilesOnly({ specVersion: undefined, accessIsTrial: true }), false);
    assert.equal(trialFilesOnly({ specVersion: 1, accessIsTrial: false }), false);
  });

  it("quota: 0 turns it off; at the limit it blocks; below it passes", () => {
    assert.equal(quotaExceeded(10_000, 0), false);
    assert.equal(quotaExceeded(299, 300), false);
    assert.equal(quotaExceeded(300, 300), true);
    assert.match(quotaText(300), /Daily limit reached/);
    assert.equal(QUOTA_WINDOW_MS, 86_400_000);
  });
});
