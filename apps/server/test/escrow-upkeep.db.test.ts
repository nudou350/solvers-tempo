import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Guaranteed tasks bought through a payment intent, against a real Postgres (no chain):
// - the guarantee limit holds across concurrent intents (the hold is written in the locked transaction; the ledger row
//   is written later by the payments area);
// - a delivery is never checked while the step's agreed texts are missing (placeholder rows of the indexer);
// - acceptance suites of intents that never became an escrow (`DELIVERABLES_DIR/plan-*`) are cleaned up.
// Runs only with TEST_DATABASE_URL (a DISPOSABLE migrated database). Rows: prefix "upktest", escrow ids 99100000x.

const url = process.env.TEST_DATABASE_URL;
const PREFIX = "upktest";
const AGENT = "0".repeat(24) + "0bce0001";
const deliverables = mkdtempSync(join(tmpdir(), "solvers-upkeep-"));
const newWallet = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const H = (c: string) => `0x${c.repeat(64)}`;

describe("escrow upkeep with a database", { skip: url ? false : "set TEST_DATABASE_URL (disposable migrated database)" }, () => {
  let db: typeof import("../src/db/index.js").db;
  let schema: typeof import("../src/db/index.js").schema;
  let pool: typeof import("../src/db/index.js").pool;
  let d: typeof import("drizzle-orm");
  const BUYER = newWallet();
  const CREATOR = newWallet();
  const escrowIds = ["991000001", "991000002", "991000003"];

  async function cleanup() {
    const s = schema;
    await db.delete(s.milestones).where(d.inArray(s.milestones.escrowId, escrowIds));
    await db.delete(s.escrows).where(d.inArray(s.escrows.id, escrowIds));
    await db.delete(s.paymentLedger).where(d.like(s.paymentLedger.id, `${PREFIX}%`));
    await db.delete(s.paymentLedger).where(d.eq(s.paymentLedger.buyerWallet, BUYER));
    await db.delete(s.kv).where(d.sql`${s.kv.value}->>'wallet' = ${BUYER}`);
    await db.delete(s.agents).where(d.eq(s.agents.id, AGENT));
    await db.delete(s.creators).where(d.like(s.creators.id, `${PREFIX}%`));
  }

  before(async () => {
    Object.assign(process.env, { DATABASE_URL: url, DELIVERABLES_DIR: deliverables, GUARANTEE_MIN_SALES: "10", GUARANTEE_MIN_RATING: "4" });
    ({ db, schema, pool } = await import("../src/db/index.js"));
    d = await import("drizzle-orm");
    await cleanup();
    await db.insert(schema.creators).values({ id: `${PREFIX}-creator`, wallet: CREATOR, name: "Upkeep" });
    await db.insert(schema.agents).values({
      id: AGENT,
      slug: `${PREFIX}-solver`,
      name: "Upkeep Solver",
      tagline: "t",
      description: "d",
      category: "code",
      creatorId: `${PREFIX}-creator`,
      version: "1.0.0",
      versionHash: "ab".repeat(32),
      price: 10_000_000n,
      status: "active",
      listed: true,
      guaranteeAvailable: true,
      totalSales: 10n,
      ratingSum: 5n,
      ratingCount: 1,
      details: {
        guaranteeTemplate: {
          priceUsdc: 12,
          milestones: [
            { title: "Plan", criteria: ["lists the cases"], sharePct: 50, verify: "manual" },
            { title: "Component", criteria: ["renders the form"], sharePct: 50, verify: "tests" },
          ],
        },
      },
    });
  });

  after(async () => {
    rmSync(deliverables, { recursive: true, force: true });
    if (!db) return;
    await cleanup();
    await pool.end();
  });

  const ledgerRow = (id: string, purchaseId: string, extra: Partial<typeof schema.paymentLedger.$inferInsert> = {}) => ({
    id: `${PREFIX}-${id}`,
    provider: "direct-wallet",
    purchaseId,
    kind: "escrow",
    buyerWallet: BUYER,
    payerWallet: BUYER,
    agentId: AGENT,
    tokenAddress: "0x20c0000000000000000000000000000000000000",
    tokenAmount: 12_000_000n,
    status: "created",
    ...extra,
  });

  describe("guarantee limit across concurrent intents (hold in the locked transaction)", () => {
    it("two concurrent plans of 12 with a limit of 20: exactly one passes; the hold gives way to the ledger row", async () => {
      const { planEscrowPurchase, guaranteeStatus } = await import("../src/store/escrow.js");
      const { findAgentRow } = await import("../src/store/catalog.js");
      const { heldGuaranteeUnits } = await import("../src/store/guarantee-holds.js");
      const agent = await findAgentRow(AGENT);
      const task = { title: "Login form", description: "E-mail and password." };
      const results = await Promise.allSettled([planEscrowPurchase({ agent, buyer: BUYER, task }), planEscrowPurchase({ agent, buyer: BUYER, task })]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(ok.length, 1, "only one intent fits the limit");
      assert.equal((refused[0]!.reason as { code?: string }).code, "guarantee_limit");
      assert.equal(await heldGuaranteeUnits(BUYER), 12_000_000n, "the winner's hold counts until its ledger row exists");
      assert.equal((await guaranteeStatus(BUYER)).openUsdc, 12);

      // The payments area writes the ledger row with the plan as `intent.task`: the hold stops counting, the row counts.
      const plan = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof planEscrowPurchase>>>).value;
      assert.match(plan.details.planKey ?? "", /^plan-[0-9a-f]{24}$/);
      await db.insert(schema.paymentLedger).values(ledgerRow("hold", H("1"), { intent: { task: plan.details } }));
      assert.equal(await heldGuaranteeUnits(BUYER), 0n);
      assert.equal((await guaranteeStatus(BUYER)).openUsdc, 12, "counted once (ledger), not twice");
      await assert.rejects(planEscrowPurchase({ agent, buyer: BUYER, task }), (e: { code?: string }) => e.code === "guarantee_limit");
    });

    it("an expired hold no longer counts and is dropped by the cleanup", async () => {
      const { placeHold, heldGuaranteeUnits, dropExpiredHolds, HOLD_PREFIX } = await import("../src/store/guarantee-holds.js");
      await placeHold(db, BUYER, `plan-${"e".repeat(24)}`, 5_000_000n);
      assert.equal(await heldGuaranteeUnits(BUYER), 5_000_000n);
      await db.update(schema.kv).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(d.eq(schema.kv.key, `${HOLD_PREFIX}plan-${"e".repeat(24)}`));
      assert.equal(await heldGuaranteeUnits(BUYER), 0n);
      assert.ok((await dropExpiredHolds()) >= 1);
      await db.delete(schema.paymentLedger).where(d.eq(schema.paymentLedger.id, `${PREFIX}-hold`));
    });
  });

  describe("a delivery is never checked while the agreed texts are missing", () => {
    const [E1, E2] = escrowIds as [string, string];
    const record = (criteriaHash: string) => ({
      title: "Login form",
      description: "E-mail and password.",
      deliveryDays: 14,
      reviewWindowSecs: 3600,
      milestones: [{ title: "Component", criteria: "renders the form", verify: "tests", amountUnits: "6000000", criteriaHash, acceptancePath: null, acceptanceHash: null }],
    });
    const placeholder = async (id: string, purchaseId: string, criteriaHash: string) => {
      await db.insert(schema.escrows).values({ id, agentId: AGENT, buyerWallet: BUYER, creatorWallet: CREATOR, purchaseId, total: 6_000_000n, reviewWindowSecs: 3600, feeBps: 1000 });
      // What the indexer writes from EscrowCreated: placeholder title, no criteria, verify defaults to "tests".
      await db.insert(schema.milestones).values({ escrowId: id, idx: 0, title: "Step 1", criteria: "", criteriaHash, amount: 6_000_000n });
    };
    const code = async (id: string) => {
      const { assertMilestoneTexts } = await import("../src/store/escrow-upkeep.js");
      return assertMilestoneTexts(id, 0).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "?",
      );
    };

    it("no record at all (escrow created without an intent): refused, no_agreed_criteria", async () => {
      await placeholder(E1, H("2"), H("a"));
      assert.equal(await code(E1), "no_agreed_criteria");
    });

    it("record of ANOTHER buyer with the same purchase id: still no record for this escrow", async () => {
      await db.insert(schema.paymentLedger).values(ledgerRow("other", H("2"), { buyerWallet: newWallet(), intent: { task: record(H("a")) } }));
      assert.equal(await code(E1), "no_agreed_criteria");
      await db.delete(schema.paymentLedger).where(d.eq(schema.paymentLedger.id, `${PREFIX}-other`));
    });

    it("record exists but not copied yet (charge still fulfilling): refused, guarantee_texts_pending", async () => {
      await db.insert(schema.paymentLedger).values(ledgerRow("t1", H("2"), { status: "fulfilling", intent: { task: record(H("a")) } }));
      assert.equal(await code(E1), "guarantee_texts_pending");
    });

    it("once the charge is fulfilled for this escrow, the texts are copied and the check proceeds; openGuarantees shows them", async () => {
      await db
        .update(schema.paymentLedger)
        .set({ status: "fulfilled", providerPayload: { escrowId: E1 } })
        .where(d.eq(schema.paymentLedger.id, `${PREFIX}-t1`));
      assert.equal(await code(E1), "ok");
      const [m] = await db.select().from(schema.milestones).where(d.eq(schema.milestones.escrowId, E1));
      assert.equal(m!.criteria, "renders the form");
      const { openGuarantees } = await import("../src/runtime/guarantees.js");
      const open = await openGuarantees(BUYER, AGENT);
      assert.equal(open.find((t) => t.id === E1)?.title, "Login form");
    });

    it("on-chain criteria hash differs from the planned one: refused, guarantee_texts_mismatch", async () => {
      await placeholder(E2, H("3"), H("b"));
      await db.insert(schema.paymentLedger).values(ledgerRow("t2", H("3"), { status: "fulfilled", providerPayload: { escrowId: E2 }, intent: { task: record(H("c")) } }));
      assert.equal(await code(E2), "guarantee_texts_mismatch");
    });

    it("openGuarantees fills texts itself for a placeholder whose record exists", async () => {
      await db.update(schema.escrows).set({ title: "" }).where(d.eq(schema.escrows.id, E1));
      const { openGuarantees } = await import("../src/runtime/guarantees.js");
      const open = await openGuarantees(BUYER, AGENT);
      assert.equal(open.find((t) => t.id === E1)?.title, "Login form");
    });
  });

  describe("acceptance plans cleanup", () => {
    const old = (Date.now() - 48 * 3600_000) / 1000;
    const plan = (c: string) => `plan-${c.repeat(24)}`;
    const mk = (name: string, age = old) => {
      const dir = join(deliverables, name, "1", "acceptance");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.test.tsx"), "test");
      utimesSync(join(deliverables, name), age, age);
    };

    it("removes old plans whose intent is dead or missing; keeps live ones, referenced ones and recent ones", async () => {
      mk(plan("1")); // no ledger row
      mk(plan("2")); // live intent
      mk(plan("3")); // expired intent
      mk(plan("4")); // referenced by a milestone (escrow exists)
      mk(plan("5"), Date.now() / 1000); // recent
      mkdirSync(join(deliverables, "991000003"), { recursive: true }); // an escrow folder is never touched
      await db.insert(schema.paymentLedger).values([
        ledgerRow("p2", H("4"), { status: "pending_payment", intent: { task: { planKey: plan("2") } } }),
        ledgerRow("p3", H("5"), { status: "expired", intent: { task: { planKey: plan("3") } } }),
      ]);
      await db.update(schema.milestones).set({ acceptancePath: join(deliverables, plan("4"), "1", "acceptance") }).where(d.eq(schema.milestones.escrowId, escrowIds[1]!));

      const { cleanupAcceptancePlansOnce } = await import("../src/store/escrow-upkeep.js");
      const removed = await cleanupAcceptancePlansOnce();
      assert.deepEqual(removed.sort(), [plan("1"), plan("3")]);
      assert.equal(existsSync(join(deliverables, plan("1"))), false);
      assert.equal(existsSync(join(deliverables, plan("3"))), false);
      for (const kept of [plan("2"), plan("4"), plan("5"), "991000003"]) assert.ok(existsSync(join(deliverables, kept)), kept);
    });
  });
});
