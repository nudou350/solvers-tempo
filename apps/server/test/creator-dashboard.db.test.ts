import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// GET /api/creator/dashboard against a real Postgres: every money field is a base-unit string summed with bigint (values
// above 2^63 included, where int8 math and floats break), the per-Solver current terms come from the agents mirror, and
// the live Staking reads fail soft (chainRead false) when the RPC is down. Runs only with TEST_DATABASE_URL (a DISPOSABLE
// migrated database, `apps/server/.env.test`); it creates and deletes rows with the prefix "dashtest". The chain context is
// offline (closed RPC port): nothing leaves the machine.

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "dashtest";
const A = "0".repeat(24) + "dab0a001"; // registered (chain_index set): live reads attempted, RPC down
const B = "0".repeat(24) + "dab0a002"; // not registered: nothing to read
const TWO62 = 2n ** 62n;
const hash = () => `0x${randomBytes(32).toString("hex")}`;
const newWallet = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

describe("creator dashboard with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let drizzle: typeof import("drizzle-orm");
  let server: Server;
  let base = "";
  let cookie: (wallet: string) => Promise<string>;
  const CREATOR = newWallet();
  const BUYER = newWallet();
  const ESCROW = "990000000000000001";

  async function cleanup() {
    await db.delete(schema.chainTxs).where(drizzle.inArray(schema.chainTxs.agentId, [A, B]));
    await db.delete(schema.milestones).where(drizzle.eq(schema.milestones.escrowId, ESCROW));
    await db.delete(schema.escrows).where(drizzle.eq(schema.escrows.id, ESCROW));
    await db.delete(schema.agents).where(drizzle.like(schema.agents.slug, `${PREFIX}%`));
    await db.delete(schema.creators).where(drizzle.like(schema.creators.id, `${PREFIX}%`));
  }

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

  const recent = () => new Date(Date.now() - 3600_000);
  const old = () => new Date(Date.now() - 40 * 86_400_000);
  type TxRow = { kind: string; agentId: string; amount?: bigint | null; creatorAmount?: bigint | null; feeBps?: number | null; blockTime: Date };
  const insertTx = (r: TxRow) =>
    db.insert(schema.chainTxs).values({ txHash: hash(), logIndex: 0, wallet: BUYER, creatorWallet: CREATOR, ...r });

  before(async () => {
    Object.assign(process.env, { DATABASE_URL: url, RPC_URL: "http://127.0.0.1:1" });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    drizzle = await import("drizzle-orm");
    await installOfflineChain();
    const { createApp } = await import("../src/app.js");
    // Only the router under test (the full module list also loads image processing, irrelevant here).
    const { meRouter } = await import("../src/store/me.js");
    const { signSession, SESSION_COOKIE } = await import("../src/auth/jwt.js");
    cookie = async (wallet) => `${SESSION_COOKIE}=${await signSession(wallet)}`;

    await cleanup();
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: CREATOR, name: "Dashboard creator" });
    const common = { tagline: "t", description: "d", category: "Other", creatorId: `${PREFIX}-creator`, version: "1.0.0", versionHash: "ab".repeat(32), status: "active", listed: true };
    await db.insert(schema.agents).values({
      ...common, id: A, slug: `${PREFIX}-a`, name: "Agent A", chainIndex: 990_001, price: 12_000_000n, pricePerUse: 500_000n, royaltyBps: 450, stake: 50_000_000n, totalSales: 3n,
    });
    await db.insert(schema.agents).values({ ...common, id: B, slug: `${PREFIX}-b`, name: "Agent B", price: 5_000_000n, totalSales: 3n });

    // A: two recent sales (one with the executed creator amount, one only with the gross and the fee recorded) and an
    // old credit pack.
    await insertTx({ kind: "purchase", agentId: A, amount: 12_000_000n, creatorAmount: 10_800_000n, feeBps: 1000, blockTime: recent() });
    await insertTx({ kind: "purchase", agentId: A, amount: 12_345_679n, creatorAmount: null, feeBps: 1000, blockTime: recent() });
    await insertTx({ kind: "credits", agentId: A, amount: 2n, creatorAmount: 1n, feeBps: 1000, blockTime: old() });
    // B: old sales above 2^62 each (their sum passes 2^63), one without any recorded fee (the current one applies).
    await insertTx({ kind: "purchase", agentId: B, amount: TWO62, creatorAmount: TWO62, feeBps: 1000, blockTime: old() });
    await insertTx({ kind: "purchase", agentId: B, amount: TWO62, creatorAmount: TWO62, feeBps: 1000, blockTime: old() });
    await insertTx({ kind: "purchase", agentId: B, amount: TWO62, creatorAmount: null, feeBps: null, blockTime: old() });
    // Royalties, guarantee releases (one with nothing for the creator) and a disputed milestone.
    await insertTx({ kind: "royalty", agentId: A, amount: 1_000_000n, creatorAmount: 333_333n, blockTime: recent() });
    await insertTx({ kind: "royalty", agentId: B, amount: 3n, creatorAmount: 1n, blockTime: old() });
    await insertTx({ kind: "release", agentId: A, amount: 6_000_000n, creatorAmount: 5_400_000n, blockTime: recent() });
    await insertTx({ kind: "release", agentId: A, amount: 1n, creatorAmount: 0n, blockTime: recent() });
    await db.insert(schema.escrows).values({ id: ESCROW, agentId: A, buyerWallet: BUYER, creatorWallet: CREATOR, title: "Task", total: 3_000_000n, reviewWindowSecs: 3600, feeBps: 1000 });
    await db.insert(schema.milestones).values({
      escrowId: ESCROW, idx: 0, title: "Step 1", criteria: "", criteriaHash: "00".repeat(32), amount: 3_000_000n, status: "disputed", disputedAt: recent(),
    });

    await new Promise<void>((resolve) => {
      server = createApp([(app) => app.use("/api", meRouter)]).listen(0, "127.0.0.1", () => resolve());
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

  it("money fields are exact base-unit strings summed with bigint; current terms per Solver; live reads fail soft", async () => {
    const { CreatorDashboard } = await import("@solvers/shared");
    const warn = console.warn;
    console.warn = () => undefined; // the offline Registry/Staking reads are logged
    let res: Response;
    try {
      res = await fetch(`${base}/api/creator/dashboard`, { headers: { cookie: await cookie(CREATOR) } });
    } finally {
      console.warn = warn;
    }
    assert.equal(res.status, 200);
    const dash = CreatorDashboard.parse(await res.json());

    // Fee 10% (Registry unreadable -> default 1000 bps), floored like the contract.
    const cutA2 = 12_345_679n - (12_345_679n * 1000n) / 10_000n;
    const cutB3 = TWO62 - (TWO62 * 1000n) / 10_000n;
    const revA = 10_800_000n + cutA2 + 1n;
    const revB = TWO62 + TWO62 + cutB3;
    assert.ok(revB > 2n ** 63n, "the fixture must pass int8");

    const a = dash.agents.find((x) => x.agentId === A)!;
    const b = dash.agents.find((x) => x.agentId === B)!;
    assert.equal(a.revenueUnits, revA.toString());
    assert.equal(b.revenueUnits, revB.toString());
    assert.equal(dash.totals.salesRevenueUnits, (revA + revB).toString());
    assert.equal(dash.totals.royaltiesUnits, "333334");
    assert.equal(dash.last30.revenueUnits, (10_800_000n + cutA2).toString());
    assert.equal(dash.last30.sales, 2);
    const dailySum = dash.daily.reduce((s, d) => s + BigInt(d.revenueUnits), 0n);
    assert.equal(dailySum.toString(), dash.last30.revenueUnits);

    assert.deepEqual(dash.guarantee, {
      earnedUnits: "5400000",
      last30Units: "5400000",
      releases: 1,
      recent: [{ txHash: dash.guarantee!.recent[0]!.txHash, agentId: A, amountUnits: "5400000", at: dash.guarantee!.recent[0]!.at }],
    });
    assert.equal(dash.disputes.length, 1);
    assert.equal(dash.disputes[0]!.amountUnits, "3000000");
    assert.equal(dash.disputes[0]!.result, "open");

    // Current terms from the mirror.
    assert.equal(a.priceUnits, "12000000");
    assert.equal(a.pricePerUseUnits, "500000");
    assert.equal(a.royaltyBps, 450);
    assert.equal(a.stakeUnits, "50000000");
    // Registered with the RPC down: unknown, not "none".
    assert.deepEqual([a.chainRead, a.stakeExit, a.slash, a.metadataUri], [false, null, null, null]);
    // Not registered: nothing on-chain to read.
    assert.deepEqual([b.chainRead, b.stakeExit, b.slash, b.metadataUri], [true, null, null, null]);
    assert.equal(b.stakeUnits, "0");
    assert.equal(b.pricePerUseUnits, "0");

    // No float anywhere in the money fields.
    const moneyKeys = /Units$/;
    const walk = (v: unknown, path: string): void => {
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      else if (moneyKeys.test(path)) assert.equal(typeof v, "string", path);
    };
    walk(dash, "dash");
    assert.doesNotMatch(JSON.stringify(dash), /Usdc"/);
  });

  it("a wallet without a creator profile gets the empty dashboard with zero strings", async () => {
    const res = await fetch(`${base}/api/creator/dashboard`, { headers: { cookie: await cookie(BUYER) } });
    assert.equal(res.status, 200);
    const dash = (await res.json()) as { creator: unknown; totals: { salesRevenueUnits: string }; last30: { revenueUnits: string } };
    assert.equal(dash.creator, null);
    assert.equal(dash.totals.salesRevenueUnits, "0");
    assert.equal(dash.last30.revenueUnits, "0");
  });
});
