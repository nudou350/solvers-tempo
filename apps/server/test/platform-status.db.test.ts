import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { AgentChainState } from "../src/indexer/mirror.js";

// Kill switch and memory access against a real Postgres (PACKAGE_SPEC.md 11.2, 15.4 and P0).
// Runs only with TEST_DATABASE_URL (a DISPOSABLE migrated database: `db:migrate`); skipped without it. Locally that is the
// solvers-tempo-pg container on 5546 (database solvers_tempo_test, see apps/server/.env.test).
//
// NEVER point it at the dev database: the test creates and deletes rows (prefix "p0test", its two agents and wallets).

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "p0test";
const AGENT = "0000000000000000000000000000e0e0";
const OTHER = "11111111111111111111111111111111";
const WALLET = `0x0b0${"0".repeat(36)}1`;
const CREATOR_WALLET = `0x0b0${"0".repeat(36)}2`;

describe("kill switch and memory with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let getSession: typeof import("../src/runtime/engine.js").getSession;
  let assertMemoryAccess: typeof import("../src/mcp/tools.js").assertMemoryAccess;
  let findAgentRow: typeof import("../src/store/catalog.js").findAgentRow;
  let agentMirrorValues: typeof import("../src/indexer/mirror.js").agentMirrorValues;
  let eq: typeof import("drizzle-orm").eq;
  let like: typeof import("drizzle-orm").like;
  let inArray: typeof import("drizzle-orm").inArray;

  const agentRow = (id: string, slug: string) => ({
    id,
    slug,
    name: "Test agent",
    tagline: "t",
    description: "d",
    category: "Other",
    creatorId: `${PREFIX}-creator`,
    version: "1.0.0",
    versionHash: "ab".repeat(32),
    price: 5_000_000n,
    status: "active",
    listed: true,
  });

  async function newSession(id: string, over: Record<string, unknown> = {}) {
    await db.insert(schema.sessions).values({ id, wallet: WALLET, agentId: AGENT, version: "1.0.0", access: "trial", ...over });
  }

  async function cleanup() {
    await db.delete(schema.sessions).where(like(schema.sessions.id, `${PREFIX}%`));
    await db.delete(schema.licenses).where(inArray(schema.licenses.agentId, [AGENT, OTHER]));
    await db.delete(schema.agents).where(like(schema.agents.slug, `${PREFIX}%`));
    await db.delete(schema.creators).where(like(schema.creators.id, `${PREFIX}%`));
  }

  before(async () => {
    // Placeholder chain keys come from fake-env (nothing on-chain is called here).
    Object.assign(process.env, { DATABASE_URL: url });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    ({ getSession } = await import("../src/runtime/engine.js"));
    ({ assertMemoryAccess } = await import("../src/mcp/tools.js"));
    ({ findAgentRow } = await import("../src/store/catalog.js"));
    ({ agentMirrorValues } = await import("../src/indexer/mirror.js"));
    ({ eq, like, inArray } = await import("drizzle-orm"));
    await cleanup();
    await db.insert(schema.agents).values(agentRow(AGENT, `${PREFIX}-agent`));
    await db.insert(schema.agents).values(agentRow(OTHER, `${PREFIX}-other`));
  });

  after(async () => {
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  it("the column starts as 'active'", async () => {
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, AGENT));
    assert.equal(row!.platformStatus, "active");
  });

  it("suspending in the database drops the open session, and an indexer event does not re-activate it", async () => {
    await newSession(`${PREFIX}-s1`);
    assert.equal((await getSession(`${PREFIX}-s1`, WALLET)).id, `${PREFIX}-s1`);

    await db.update(schema.agents).set({ platformStatus: "suspended" }).where(eq(schema.agents.id, AGENT));
    await assert.rejects(getSession(`${PREFIX}-s1`, WALLET), (e: unknown) => (e as { code?: string }).code === "agent_unavailable");

    // On-chain event (UsageRecorded, LicensePurchased...): the indexer applies the agent mirror, status "active".
    const onchain: AgentChainState = {
      agentId: AGENT,
      view: {
        creator: CREATOR_WALLET,
        status: 1,
        royaltyBps: 0,
        totalSales: 1,
        maxSupply: 0,
        price: 5_000_000n,
        pricePerUse: 0n,
        disputesLost: 0,
        index: 900_001,
        stake: 0n,
        versionHash: `0x${"ab".repeat(32)}`,
        version: "1.0.0",
      },
      eval: { measured: false, scoreBps: 0, evalHash: `0x${"00".repeat(32)}` },
      rating: { sum: 0n, count: 0 },
      verifiedUses: 0n,
    };
    await db.update(schema.agents).set(agentMirrorValues(onchain)).where(eq(schema.agents.id, AGENT));

    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, AGENT));
    assert.equal(row!.status, "active");
    assert.equal(row!.platformStatus, "suspended", "the chain mirror cannot re-activate a suspended agent");
    await assert.rejects(getSession(`${PREFIX}-s1`, WALLET), (e: unknown) => (e as { code?: string }).code === "agent_unavailable");

    await db.update(schema.agents).set({ platformStatus: "active" }).where(eq(schema.agents.id, AGENT));
    assert.equal((await getSession(`${PREFIX}-s1`, WALLET)).id, `${PREFIX}-s1`);
  });

  it("a suspended on-chain status also drops the session", async () => {
    await db.update(schema.agents).set({ status: "suspended" }).where(eq(schema.agents.id, AGENT));
    await assert.rejects(getSession(`${PREFIX}-s1`, WALLET), (e: unknown) => (e as { code?: string }).code === "agent_unavailable");
    await db.update(schema.agents).set({ status: "active" }).where(eq(schema.agents.id, AGENT));
  });

  it("memory: refused without a session or license; allowed with an open (trial) session", async () => {
    await db.delete(schema.sessions).where(like(schema.sessions.id, `${PREFIX}%`));
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, AGENT));
    await assert.rejects(assertMemoryAccess(WALLET, row!), (e: unknown) => (e as { code?: string }).code === "memory_no_access");

    await newSession(`${PREFIX}-s2`, { access: "trial" });
    await assert.doesNotReject(assertMemoryAccess(WALLET, row!));
  });

  it("memory: an expired session does not count; a license does; a suspended agent refuses even with a license", async () => {
    await db.delete(schema.sessions).where(like(schema.sessions.id, `${PREFIX}%`));
    await newSession(`${PREFIX}-s3`, { expiresAt: new Date(Date.now() - 60_000) });
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, AGENT));
    await assert.rejects(assertMemoryAccess(WALLET, row!), (e: unknown) => (e as { code?: string }).code === "memory_no_access");

    await db.insert(schema.licenses).values({ id: "92000001", agentId: AGENT, ownerWallet: WALLET, originalPrice: 5_000_000n });
    await assert.doesNotReject(assertMemoryAccess(WALLET, row!));

    await db.update(schema.agents).set({ platformStatus: "suspended" }).where(eq(schema.agents.id, AGENT));
    const [suspended] = await db.select().from(schema.agents).where(eq(schema.agents.id, AGENT));
    await assert.rejects(assertMemoryAccess(WALLET, suspended!), (e: unknown) => (e as { code?: string }).code === "agent_unavailable");
    await db.update(schema.agents).set({ platformStatus: "active" }).where(eq(schema.agents.id, AGENT));
  });

  it("memory: a license of ANOTHER agent does not count", async () => {
    const [other] = await db.select().from(schema.agents).where(eq(schema.agents.id, OTHER));
    await assert.rejects(assertMemoryAccess(WALLET, other!), (e: unknown) => (e as { code?: string }).code === "memory_no_access");
  });

  it("findAgentRow: an id (32 hex) looks up by id, anything else by slug", async () => {
    assert.equal((await findAgentRow(AGENT)).slug, `${PREFIX}-agent`);
    assert.equal((await findAgentRow(`${PREFIX}-other`)).id, OTHER);
    await assert.rejects(findAgentRow(`${PREFIX}-does-not-exist`), (e: unknown) => (e as { status?: number }).status === 404);
  });

  it("listCreators: a creator with only suspended Solvers leaves the list", async () => {
    const { listCreators } = await import("../src/store/catalog.js");
    const ids = async () => (await listCreators()).map((c) => c.id);
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: CREATOR_WALLET, name: "Test creator" });
    assert.ok((await ids()).includes(`${PREFIX}-creator`));

    await db.update(schema.agents).set({ platformStatus: "suspended" }).where(like(schema.agents.slug, `${PREFIX}%`));
    assert.ok(!(await ids()).includes(`${PREFIX}-creator`));

    await db.update(schema.agents).set({ platformStatus: "active" }).where(eq(schema.agents.id, AGENT));
    assert.ok((await ids()).includes(`${PREFIX}-creator`), "one active Solver is enough to list the creator");
  });
});
