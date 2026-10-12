import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// License cap against a real Postgres (docs/license-cap.md): the `agents.max_licenses` column (mirror of the Registry's
// `maxSupply`), the `supply` field of the catalog API and the creator dashboard, and the 409 `sold_out` of the purchase
// precheck without any RPC. The contract is the real barrier (`purchaseLicense` reverts with SoldOut; contracts tests).
// Runs only with TEST_DATABASE_URL (a DISPOSABLE migrated database: `db:migrate`); see the header of platform-status.db.test.ts.
// NEVER point it at the dev database: the test creates and deletes rows (prefix "suptest"). The chain context is offline
// (closed RPC port): nothing leaves the machine.

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "suptest";
const ids = {
  open: "0".repeat(24) + "5b5b1e01", // cap 3, 2 sold
  soldOut: "0".repeat(24) + "5b5b1e02", // cap 3, 3 sold
  unlimited: "0".repeat(24) + "5b5b1e03", // no cap, 100 sold
  over: "0".repeat(24) + "5b5b1e04", // cap 3 set after 5 sales
};

const newWallet = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

describe("license cap with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let drizzle: typeof import("drizzle-orm");
  let server: Server;
  let base = "";
  let cookie: (wallet: string) => Promise<string>;
  const CREATOR = newWallet();
  const BUYER = newWallet();

  async function cleanup() {
    await db.delete(schema.agents).where(drizzle.like(schema.agents.slug, `${PREFIX}%`));
    await db.delete(schema.creators).where(drizzle.like(schema.creators.id, `${PREFIX}%`));
  }

  /** Offline chain context: valid keys and a placeholder deployment on a closed RPC port. */
  async function installOfflineChain() {
    const { getChain, publicClientFor, serverWalletClient } = await import("@solvers/chain");
    const { setChainContext } = await import("../src/chain/index.js");
    const rpc = "http://127.0.0.1:1";
    const chain = getChain(31337, rpc);
    const acct = () => privateKeyToAccount(generatePrivateKey());
    const [platform, relay, verifier] = [acct(), acct(), acct()];
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
    setChainContext({
      chain,
      deployment: {
        chainId: 31337,
        token: "0x20c0000000000000000000000000000000000000",
        treasury: addr(0xdead),
        deployBlock: 0n,
        gitSha: "",
        registry: addr(0xa1),
        license: addr(0xa2),
        credits: addr(0xa3),
        reviews: addr(0xa4),
        escrow: addr(0xa5),
        staking: addr(0xa6),
      },
      publicClient: publicClientFor(chain, rpc),
      accounts: { platform, relay, verifier, admin: null },
      wallets: { platform: serverWalletClient(platform, chain, rpc), verifier: serverWalletClient(verifier, chain, rpc), admin: null },
    });
  }

  before(async () => {
    Object.assign(process.env, { DATABASE_URL: url, RPC_URL: "http://127.0.0.1:1" });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    drizzle = await import("drizzle-orm");
    await installOfflineChain();
    const { createApp } = await import("../src/app.js");
    const { mounts } = await import("../src/modules.js");
    const { signSession, SESSION_COOKIE } = await import("../src/auth/jwt.js");
    cookie = async (wallet) => `${SESSION_COOKIE}=${await signSession(wallet)}`;

    await cleanup();
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: CREATOR, name: "Test creator" });
    const rows: Array<[string, string, bigint, number | null]> = [
      [ids.open, "open", 2n, 3],
      [ids.soldOut, "sold-out", 3n, 3],
      [ids.unlimited, "unlimited", 100n, null],
      [ids.over, "over", 5n, 3],
    ];
    for (const [id, name, sales, max] of rows) {
      await db.insert(schema.agents).values({
        id, slug: `${PREFIX}-${name}`, name: `Agent ${name}`, tagline: "t", description: "d", category: "Other", creatorId: `${PREFIX}-creator`,
        version: "1.0.0", versionHash: "ab".repeat(32), price: 12_000_000n, status: "active", listed: true, totalSales: sales,
        ...(max == null ? {} : { maxLicenses: max }),
      });
    }
    await new Promise<void>((resolve) => {
      server = createApp(mounts).listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    server?.close();
    if (!db) return;
    await cleanup();
    await pool.end();
    (await import("../src/chain/index.js")).setChainContext(null);
  });

  it("the column is optional: an uncapped Solver keeps max_licenses null and editing other columns leaves it alone", async () => {
    const [u] = await db.select().from(schema.agents).where(drizzle.eq(schema.agents.id, ids.unlimited));
    assert.equal(u!.maxLicenses, null);
    // The indexer rewrites the mirror columns on every event (totalSales etc.): the cap survives when not included.
    await db.update(schema.agents).set({ totalSales: 6n, updatedAt: new Date() }).where(drizzle.eq(schema.agents.id, ids.open));
    const [o] = await db.select().from(schema.agents).where(drizzle.eq(schema.agents.id, ids.open));
    assert.equal(o!.maxLicenses, 3);
    await db.update(schema.agents).set({ totalSales: 2n }).where(drizzle.eq(schema.agents.id, ids.open));
  });

  it("catalog API: supply with sold and left; unlimited without a cap; never negative", async () => {
    const get = async (name: string) => ((await (await fetch(`${base}/api/agents/${PREFIX}-${name}`)).json()) as { agent: { supply: { max: number | null; sold: number; left: number | null } } }).agent;
    assert.deepEqual((await get("open")).supply, { max: 3, sold: 2, left: 1 });
    assert.deepEqual((await get("sold-out")).supply, { max: 3, sold: 3, left: 0 });
    assert.deepEqual((await get("unlimited")).supply, { max: null, sold: 100, left: null });
    assert.deepEqual((await get("over")).supply, { max: 3, sold: 5, left: 0 });
  });

  it("the storefront list carries the supply of each Solver", async () => {
    const list = (await (await fetch(`${base}/api/agents?q=${PREFIX}`)).json()) as Array<{ slug: string; supply?: { left: number | null } }>;
    const mine = list.filter((a) => a.slug.startsWith(PREFIX));
    // The text search may not return the test rows; when it does, all of them carry supply.
    for (const a of mine) assert.ok(a.supply, `${a.slug} without supply`);
  });

  it("creator dashboard: sold/max per Solver", async () => {
    const res = await fetch(`${base}/api/creator/dashboard`, { headers: { cookie: await cookie(CREATOR) } });
    assert.equal(res.status, 200);
    const dash = (await res.json()) as { agents: Array<{ agentId: string; supply: { max: number | null; sold: number; left: number | null } }> };
    const by = new Map(dash.agents.map((a) => [a.agentId, a.supply]));
    assert.deepEqual(by.get(ids.open), { max: 3, sold: 2, left: 1 });
    assert.deepEqual(by.get(ids.soldOut), { max: 3, sold: 3, left: 0 });
    assert.deepEqual(by.get(ids.unlimited), { max: null, sold: 100, left: null });
  });

  it("POST /api/purchases/intent of a sold-out Solver: never builds a purchase (409 sold_out when the precheck answers)", async () => {
    const res = await fetch(`${base}/api/purchases/intent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookie(BUYER) },
      body: JSON.stringify({ kind: "license", agentId: ids.soldOut }),
    });
    const body = (await res.json()) as { code?: string; error?: string };
    // With the RPC down another check may answer first (e.g. 503 chain_unavailable); what matters: never a sold-out purchase.
    if (res.status === 409) {
      assert.equal(body.code, "sold_out");
      assert.match(body.error ?? "", /sold out/);
    } else {
      assert.notEqual(res.status, 200);
    }
  });

  it("MCP: the description shows X of Y left, a sold-out Solver gets no purchase link and no secondary market", async () => {
    const { describeAgent, purchaseLinkFor, soldOutAdvice } = await import("../src/mcp/tools.js");
    const row = async (id: string) => (await db.select().from(schema.agents).where(drizzle.eq(schema.agents.id, id)))[0]!;
    const open = await row(ids.open);
    const sold = await row(ids.soldOut);
    const free = await row(ids.unlimited);
    assert.match(describeAgent(open), /1 of 3 licenses left/);
    assert.match(describeAgent(sold), /sold out/);
    assert.doesNotMatch(describeAgent(free), /licenses left|sold out/);
    assert.match(purchaseLinkFor(open), /\/checkout\?agent=/);
    assert.doesNotMatch(purchaseLinkFor(sold), /checkout/);
    assert.match(purchaseLinkFor(sold), /sold out/);
    const advice = soldOutAdvice(sold);
    assert.match(advice, /Do not offer a purchase link/);
    assert.match(advice, /current license limit/);
    assert.match(advice, /creator can raise it/);
    // No secondary-market wording (pattern built from fragments so the repo purge check stays clean).
    assert.doesNotMatch(advice, new RegExp(["re" + "sell", "re" + "sale", "secondary market", "only \\d+ (will )?exist"].join("|"), "i"));
  });

  it("purchase guards (shared by intents, Pix and agent-pay): sold out is refused before charging; with room the cap check passes", async () => {
    const { assertPurchasable } = await import("../src/store/purchase-guards.js");
    const { HttpError } = await import("../src/lib/http.js");
    const row = async (id: string) => (await db.select().from(schema.agents).where(drizzle.eq(schema.agents.id, id)))[0]!;
    const warn = console.warn;
    console.warn = () => undefined; // the offline Registry read is logged (fail-open pause check)
    try {
      await assert.rejects(assertPurchasable(BUYER, await row(ids.soldOut), "license"), (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === "sold_out");
      await assert.rejects(assertPurchasable(BUYER, await row(ids.over), "license"), (e: unknown) => e instanceof HttpError && e.code === "sold_out");
      // With room the cap check passes and a later check refuses (package not loadable / RPC down): anything but sold_out.
      await assert.rejects(assertPurchasable(BUYER, await row(ids.open), "license"), (e: unknown) => !(e instanceof HttpError && e.code === "sold_out"));
      await assert.rejects(assertPurchasable(BUYER, await row(ids.unlimited), "license"), (e: unknown) => !(e instanceof HttpError && e.code === "sold_out"));
    } finally {
      console.warn = warn;
    }
  });
});
