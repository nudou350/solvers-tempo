import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Knowledge ingestion, versions and quota against a real Postgres (PACKAGE_SPEC.md 6). Only runs with
// TEST_DATABASE_URL (a DISPOSABLE, already migrated database). No embeddings model (SEARCH_MODE=fts): null vector, full-text search.

const url = process.env.TEST_DATABASE_URL;
const AGENT = "0".repeat(24) + "kn000001";
const WALLET = "kntest-wallet";

describe("knowledge with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let eq: typeof import("drizzle-orm").eq;
  let ingest: typeof import("../src/knowledge/ingest.js");
  let search: typeof import("../src/knowledge/search.js");
  let quota: typeof import("../src/knowledge/quota.js");
  let rules: typeof import("../src/knowledge/search-rules.js");
  let sha256Hex: typeof import("../src/lib/crypto.js").sha256Hex;
  let root = "";
  let pkgDir = "";

  const rows = (version: string) =>
    db.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.agentId, AGENT)).then((r) => r.filter((x) => x.version === version));

  const write = (rel: string, text: string) => writeFileSync(join(pkgDir, "knowledge", rel), text);

  before(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url,
      SEARCH_MODE: "fts",
      JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
      SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
    });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    ({ eq } = await import("drizzle-orm"));
    ingest = await import("../src/knowledge/ingest.js");
    search = await import("../src/knowledge/search.js");
    quota = await import("../src/knowledge/quota.js");
    rules = await import("../src/knowledge/search-rules.js");
    ({ sha256Hex } = await import("../src/lib/crypto.js"));

    root = mkdtempSync(join(tmpdir(), "kn-test-"));
    pkgDir = join(root, "pkg");
    mkdirSync(join(pkgDir, "knowledge", "sub"), { recursive: true });
    writeFileSync(join(pkgDir, "manifest.json"), "{}");
    write(
      "rotativo.md",
      "---\ntitle: Rotativo do cartão\nsource: Banco Central, Res. 4.549\nsource_date: 2026-09-01\nvalid_until: 2026-12-31\ntrial: true\n---\n# Rotativo\n\nO rotativo do cartão cobra juros altos.\n",
    );
    write("sub/planilha.txt", "Planilha de orçamento: guarde dez por cento da renda.\n\n# isto não é título\nmais texto.");
    write("sub/planilha.txt.meta.json", JSON.stringify({ title: "Orçamento", source: "Guia interno", valid_until: "2020-01-01" }));
    write("legado.md", "# Legado\n\nTexto de pacote antigo sobre reserva de emergência.\n");
    write("ignorado.pdf", "não entra");
    await cleanup();
  });

  async function cleanup() {
    await db.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.agentId, AGENT));
    await db.delete(schema.usageEvents).where(eq(schema.usageEvents.wallet, WALLET));
  }

  after(async () => {
    if (!db) return;
    await cleanup();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("ingests .md and .txt (package root): meta, valid_until, relative source, .pdf and .meta.json left out", async () => {
    const progress: [number, number, number][] = [];
    const r = await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir, onFile: (d, t, c) => void progress.push([d, t, c]) });
    // One chunk per file (the "# isto não é título" in the .txt does not split it).
    assert.deepEqual(r, { files: 3, chunks: 3 });
    assert.deepEqual(progress.map((p) => p.slice(0, 2)), [[1, 3], [2, 3], [3, 3]]);
    assert.equal(progress.at(-1)![2], r.chunks);
    const all = await rows("staging:abc");
    const sources = [...new Set(all.map((x) => x.source))].sort();
    assert.deepEqual(sources, ["knowledge/legado.md", "knowledge/rotativo.md", "knowledge/sub/planilha.txt"]);
    const rot = all.find((x) => x.source === "knowledge/rotativo.md")!;
    assert.equal(rot.validUntil, "2026-12-31");
    assert.equal((rot.meta as { trial?: boolean }).trial, true);
    assert.doesNotMatch(rot.content, /source:/);
    const txt = all.filter((x) => x.source === "knowledge/sub/planilha.txt");
    assert.equal(txt[0]!.validUntil, "2020-01-01");
    assert.equal((txt[0]!.meta as { source?: string }).source, "Guia interno");
    const legado = all.find((x) => x.source === "knowledge/legado.md")!;
    assert.equal(legado.meta, null);
    assert.equal(legado.validUntil, null);
  });

  it("idempotent: repeating or resuming midway does not duplicate chunks", async () => {
    const before = (await rows("staging:abc")).length;
    const progress: number[] = [];
    const again = await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir, resumeFromFile: 1, onFile: (d) => void progress.push(d) });
    assert.equal(again.chunks, before);
    assert.deepEqual(progress, [2, 3]);
    const full = await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir });
    assert.equal(full.chunks, before);
    assert.equal((await rows("staging:abc")).length, before);
    // resumeFromFile beyond the total: nothing to do, nothing disappears.
    assert.equal((await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir, resumeFromFile: 99 })).chunks, before);
  });

  it("accepts the knowledge folder itself as dir (same source)", async () => {
    await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:dir", dir: join(pkgDir, "knowledge") });
    assert.deepEqual([...new Set((await rows("staging:dir")).map((x) => x.source))].sort(), ["knowledge/legado.md", "knowledge/rotativo.md", "knowledge/sub/planilha.txt"]);
    assert.equal(await ingest.deleteKnowledgeVersion(AGENT, "staging:dir") > 0, true);
  });

  it("a package root without knowledge/ does not read the rest as knowledge", async () => {
    const other = join(root, "vazio");
    mkdirSync(join(other, "steps"), { recursive: true });
    writeFileSync(join(other, "manifest.json"), "{}");
    writeFileSync(join(other, "steps", "01.md"), "# etapa\n\nnão é conhecimento");
    assert.deepEqual(await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:vazio", dir: other }), { files: 0, chunks: 0 });
  });

  it("a file removed from the folder leaves the version on reingestion", async () => {
    mkdirSync(join(pkgDir, "knowledge", "tmp"), { recursive: true });
    write("tmp/efemero.md", "# Efêmero\n\nvai embora");
    await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir });
    assert.ok((await rows("staging:abc")).some((x) => x.source === "knowledge/tmp/efemero.md"));
    rmSync(join(pkgDir, "knowledge", "tmp"), { recursive: true });
    await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:abc", dir: pkgDir });
    assert.ok(!(await rows("staging:abc")).some((x) => x.source === "knowledge/tmp/efemero.md"));
  });

  it("searches the staging version (reviewer) with no quota or trial", async () => {
    const hits = await ingest.searchKnowledgeInVersion(AGENT, "staging:abc", "rotativo cartão juros", 5);
    assert.ok(hits.length >= 1);
    assert.deepEqual(Object.keys(hits[0]!).sort(), ["content", "score", "source"]);
    assert.match(hits[0]!.source, /^knowledge\//);
  });

  it("renames staging to the real version without recomputing (same ids) and the staging version disappears", async () => {
    const ids = (await rows("staging:abc")).map((x) => x.id).sort();
    const moved = await ingest.renameKnowledgeVersion(AGENT, "staging:abc", "1.0.0");
    assert.equal(moved, ids.length);
    assert.equal((await rows("staging:abc")).length, 0);
    assert.deepEqual((await rows("1.0.0")).map((x) => x.id).sort(), ids);
    // Empty source: nothing is touched (the target version stays).
    assert.equal(await ingest.renameKnowledgeVersion(AGENT, "staging:inexistente", "1.0.0"), 0);
    assert.equal((await rows("1.0.0")).length, ids.length);
  });

  it("renaming onto an existing version replaces it (no duplicate chunks)", async () => {
    await ingest.ingestKnowledgeDir({ agentId: AGENT, version: "staging:2", dir: pkgDir });
    const expected = (await rows("staging:2")).length;
    await ingest.renameKnowledgeVersion(AGENT, "staging:2", "1.0.0");
    assert.equal((await rows("1.0.0")).length, expected);
  });

  it("search: a chunk with an expired valid_until comes with validUntil; the v1 free trial only returns trial:true files", async () => {
    const all = await search.searchKnowledge(AGENT, "1.0.0", "planilha orçamento renda", 5);
    const planilha = all.find((h) => h.source === "knowledge/sub/planilha.txt")!;
    assert.equal(planilha.validUntil, "2020-01-01");
    const text = rules.hitsText([planilha], new Date("2026-10-02T00:00:00Z"), "MARCA");
    assert.match(text, /may be out of date \(valid until 2020-01-01\)/);
    assert.match(text, /Cite the source/);

    const trial = await search.searchKnowledge(AGENT, "1.0.0", "planilha orçamento renda", 5, { trialOnly: true });
    assert.ok(trial.length >= 1);
    assert.ok(trial.every((h) => (h.meta as { trial?: boolean } | null)?.trial === true));
    assert.ok(trial.every((h) => h.source === "knowledge/rotativo.md"));
  });

  it("ingestPackage (publish/seed): replaces the whole version and returns the count", async () => {
    const pkg = { manifest: { id: AGENT, version: "9.9.9" }, dir: pkgDir } as unknown as Parameters<typeof ingest.ingestPackage>[0];
    const n = await ingest.ingestPackage(pkg);
    assert.equal(n, (await rows("9.9.9")).length);
    assert.ok(n >= 3);
    assert.equal(await ingest.ingestPackage(pkg), n); // again: replaces, does not duplicate
    assert.equal((await rows("9.9.9")).length, n);
  });

  it("deleteKnowledgeVersion deletes only the requested version", async () => {
    const gone = await ingest.deleteKnowledgeVersion(AGENT, "9.9.9");
    assert.ok(gone >= 3);
    assert.equal((await rows("9.9.9")).length, 0);
    assert.ok((await rows("1.0.0")).length > 0);
  });

  describe("search_knowledge daily quota", () => {
    const event = (n: number, text: string, ago = 0) =>
      db.insert(schema.usageEvents).values(
        Array.from({ length: n }, () => ({ wallet: WALLET, agentId: AGENT, tool: "search_knowledge", responseHash: sha256Hex(text), createdAt: new Date(Date.now() - ago) })),
      );

    it("below the quota passes; at the limit returns 'daily limit reached'", async () => {
      await db.delete(schema.usageEvents).where(eq(schema.usageEvents.wallet, WALLET));
      await event(2, "resposta qualquer");
      assert.equal(await quota.searchQuotaBlock(WALLET, AGENT, 3), null);
      await event(1, "outra resposta");
      assert.match((await quota.searchQuotaBlock(WALLET, AGENT, 3))!, /Daily limit reached/);
    });

    it("quota 0 turns it off", async () => {
      assert.equal(await quota.searchQuotaBlock(WALLET, AGENT, 0), null);
    });

    it("'limit reached' responses do not extend the block", async () => {
      await db.delete(schema.usageEvents).where(eq(schema.usageEvents.wallet, WALLET));
      await event(2, "r1");
      await event(50, rules.quotaText(3));
      assert.equal(await quota.searchesInWindow(WALLET, AGENT, 3), 2);
      assert.equal(await quota.searchQuotaBlock(WALLET, AGENT, 3), null);
    });

    it("only counts the last 24 hours, this wallet, this specialist and this tool", async () => {
      await db.delete(schema.usageEvents).where(eq(schema.usageEvents.wallet, WALLET));
      await event(5, "velho", 25 * 3600 * 1000);
      await db.insert(schema.usageEvents).values([
        { wallet: WALLET, agentId: "0".repeat(24) + "outro001", tool: "search_knowledge", responseHash: "h" },
        { wallet: WALLET, agentId: AGENT, tool: "next_step", responseHash: "h" },
        { wallet: "kntest-outra", agentId: AGENT, tool: "search_knowledge", responseHash: "h" },
      ]);
      assert.equal(await quota.searchesInWindow(WALLET, AGENT, 3), 0);
      await db.delete(schema.usageEvents).where(eq(schema.usageEvents.wallet, "kntest-outra"));
    });
  });
});
