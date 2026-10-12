// Conformance suite of the payment providers (plan §5), parametrised by provider: fake, direct-wallet,
// pix-intermediated (PIX_SIMULATE) and agent-pay (the MPP settlement is a real memo transfer to the float; the HTTP/mppx
// side is covered in payments-routes.db.test.ts). Real contracts on `anvil --tempo`, real ledger in the test database. The indexer is
// not involved: the `SaleAuthorized` handler is called directly with the events of the receipts.
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546) and `anvil` (Foundry).
import { strict as assert } from "node:assert";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { encodeFunctionData, keccak256, toBytes, type Hex, type TransactionReceipt } from "viem";
import { Abis } from "viem/tempo";

import { anvilAvailable } from "@solvers/chain/testing";
import type { Charge, PaymentProvider } from "@solvers/shared";
import { PRICE, PRICE_PER_USE, setupPaymentsChain, type PaymentsChain } from "./helpers/payments-chain.js";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : !anvilAvailable() ? "anvil not installed" : false;

type Mods = {
  chain: typeof import("@solvers/chain");
  shared: typeof import("@solvers/shared");
  ledger: typeof import("../src/payments/ledger.js");
  intent: typeof import("../src/payments/intent.js");
  fulfil: typeof import("../src/payments/fulfil.js");
  hook: typeof import("../src/payments/sale-hook.js");
  fake: typeof import("../src/payments/providers/fake.js");
  dw: typeof import("../src/payments/providers/direct-wallet.js");
  pix: typeof import("../src/pix/provider.js");
  ap: typeof import("../src/agent-pay/provider.js");
  lifecycle: typeof import("../src/payments/lifecycle.js");
  http: typeof import("../src/lib/http.js");
  env: typeof import("../src/env.js");
};

let t: PaymentsChain;
let m: Mods;
const receipts = new Map<string, TransactionReceipt>();

type Harness = {
  name: "fake" | "direct-wallet" | "pix-intermediated" | "agent-pay";
  platform: boolean;
  provider: () => PaymentProvider;
  create: (agentId: string, buyer: number) => Promise<Charge>;
  pay: (c: Charge, buyer: number) => Promise<void>;
  notify: (c: Charge) => Promise<void>;
};

let fakeProvider: InstanceType<Mods["fake"]["FakeProvider"]>;
let dwProvider: InstanceType<Mods["dw"]["DirectWalletProvider"]>;
let pixProvider: InstanceType<Mods["pix"]["PixIntermediatedProvider"]>;
let apProvider: InstanceType<Mods["ap"]["AgentPayProvider"]>;

/** An MPP attribution memo bound to `challengeId` (tag keccak("mpp")[0..3], version 1, nonce keccak(challengeId)[0..6]). */
function mppMemo(challengeId: string): Hex {
  const tag = keccak256(toBytes("mpp")).slice(2, 10);
  const nonce = keccak256(toBytes(challengeId)).slice(2, 16);
  return `0x${tag}01${"0".repeat(40)}${nonce}` as Hex;
}

/** The agent's MPP payment: `transferWithMemo(float, amount, memo bound to the challenge)`. */
function memoTransfer(amount: bigint, challengeId: string) {
  return {
    to: m.env.env.PAYMENT_TOKEN as Hex,
    data: encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [t.platform, amount, mppMemo(challengeId)] } as never),
  };
}

async function prepared(agentId: string, buyer: number) {
  return m.intent.preparePurchase({ kind: "license", agentId }, t.buyers[buyer]!);
}

async function deliverSales(receipt: TransactionReceipt) {
  const events = m.chain.parseSolversEvents(receipt.logs, t.anvil.deployment);
  for (const e of events) {
    if (e.eventName !== "SaleAuthorized") continue;
    await m.hook.handleSaleAuthorized({
      purchaseId: e.args.purchaseId,
      agentId: e.args.agentId,
      buyer: e.args.buyer,
      payer: e.args.payer,
      kind: e.args.kind as 1 | 2 | 3,
      ref: e.args.ref,
      txHash: e.transactionHash!,
      logIndex: e.logIndex!,
      blockNumber: e.blockNumber!,
      siblings: events,
    });
  }
}

function signedMpWebhook(dataId: string) {
  const ts = String(Date.now());
  const rid = `req-${randomBytes(4).toString("hex")}`;
  const v1 = createHmac("sha256", "whsec-payments-test").update(`id:${dataId.toLowerCase()};request-id:${rid};ts:${ts};`).digest("hex");
  return {
    headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": rid },
    query: { "data.id": dataId, type: "order" },
    body: JSON.stringify({ type: "order", data: { id: dataId } }),
  };
}

const harnesses: Harness[] = [
  {
    name: "fake",
    platform: true,
    provider: () => fakeProvider,
    create: async (agentId, buyer) => {
      const p = await prepared(agentId, buyer);
      return fakeProvider.createCharge(p.intent, { now: new Date(), details: p.details });
    },
    pay: async (c) => fakeProvider.pay(c.id),
    notify: async (c) => {
      await fakeProvider.replayWebhook(c.id);
    },
  },
  {
    name: "direct-wallet",
    platform: false,
    provider: () => dwProvider,
    create: async (agentId, buyer) => {
      const p = await prepared(agentId, buyer);
      return dwProvider.createCharge(p.intent, { now: new Date(), details: p.details });
    },
    pay: async (c, buyer) => {
      receipts.set(c.id, await t.sendAs(t.buyerKeys[buyer]!, c.calls!, { sponsored: true }));
    },
    notify: async (c) => {
      const r = receipts.get(c.id);
      if (r) await deliverSales(r);
    },
  },
  {
    name: "pix-intermediated",
    platform: true,
    provider: () => pixProvider,
    create: async (agentId, buyer) => {
      const p = await prepared(agentId, buyer);
      return pixProvider.createCharge(p.intent, { now: new Date(), details: p.details });
    },
    // The buyer pays the (simulated) Pix: only the provider side changes; nothing is confirmed until a notification.
    pay: async (c) => {
      await m.ledger.patchCharge(c.id, { payload: { simulatedPaid: true } });
    },
    notify: async (c) => {
      const row = (await m.ledger.loadCharge(c.id))!;
      await pixProvider.handleWebhook(signedMpWebhook(row.providerChargeId!));
    },
  },
  {
    name: "agent-pay",
    platform: true,
    provider: () => apProvider,
    // An order (the payer is unknown until it pays) and one challenge, as the 402 response would record it.
    create: async (agentId) => {
      const { readAgent } = await import("../src/payments/chain.js");
      const row = await apProvider.openOrder({ agentId, price: (await readAgent(agentId))!.price, ip: null });
      await apProvider.recordChallenge(row.id, `conformance-${row.id}`);
      return apProvider.view(await load(row.id));
    },
    pay: async (c, buyer) => {
      receipts.set(c.id, await t.sendAs(t.buyerKeys[buyer]!, [memoTransfer(c.amount, `conformance-${c.id}`)], { sponsored: true }));
    },
    // mppx's success hook (the same settlement again on a replay).
    notify: async (c) => {
      const r = receipts.get(c.id);
      if (r) await apProvider.markSettled(c.id, r.transactionHash);
    },
  },
];

const load = async (id: string) => (await m.ledger.loadCharge(id))!;
const sentCount = async (c: Charge) => (await t.lanes.sentTxsFor(m.fulfil.fulfilKind(c.provider), c.id)).length;
const rowsFor = async (purchaseId: string) => {
  const { eq } = await import("drizzle-orm");
  return t.db.db.select().from(t.db.schema.paymentLedger).where(eq(t.db.schema.paymentLedger.purchaseId, purchaseId.toLowerCase()));
};
const makeStale = async (id: string) => {
  const { eq } = await import("drizzle-orm");
  await t.db.db
    .update(t.db.schema.paymentLedger)
    .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(t.db.schema.paymentLedger.id, id));
};
const refOnChain = (payer: string, purchaseId: string) =>
  import("../src/payments/chain.js").then((c) => c.readPurchaseRef(payer, purchaseId));

describe("payment providers: conformance", { skip }, () => {
  let agentA: string;

  before(async () => {
    t = await setupPaymentsChain();
    m = {
      chain: await import("@solvers/chain"),
      shared: await import("@solvers/shared"),
      ledger: await import("../src/payments/ledger.js"),
      intent: await import("../src/payments/intent.js"),
      fulfil: await import("../src/payments/fulfil.js"),
      hook: await import("../src/payments/sale-hook.js"),
      fake: await import("../src/payments/providers/fake.js"),
      dw: await import("../src/payments/providers/direct-wallet.js"),
      pix: await import("../src/pix/provider.js"),
      ap: await import("../src/agent-pay/provider.js"),
      lifecycle: await import("../src/payments/lifecycle.js"),
      http: await import("../src/lib/http.js"),
      env: await import("../src/env.js"),
    };
    assert.equal(m.env.env.PIX_SIMULATE, true);
    fakeProvider = new m.fake.FakeProvider();
    dwProvider = new m.dw.DirectWalletProvider();
    pixProvider = new m.pix.PixIntermediatedProvider();
    apProvider = new m.ap.AgentPayProvider();
    agentA = await t.newAgent();
  });

  after(async () => {
    await t?.stop();
  });

  for (const h of harnesses) {
    describe(h.name, () => {
      let main: Charge;
      // One agent per provider: fulfilments are indexed at once (D9), so a buyer who already holds this agent's license
      // could not buy it again through the next provider.
      let agentA: string;
      before(async () => {
        agentA = await t.newAgent();
      });

      it("create -> confirm x2 -> fulfill x2: one transaction, one ledger row", async () => {
        main = await h.create(agentA, 0);
        assert.equal(main.status, "pending_payment");
        assert.equal(main.purchaseId, m.shared.purchaseIdFor(main.id));
        if (!h.platform) assert.equal(main.calls?.length, 2, "direct-wallet returns [approve, purchase]");
        const float0 = await t.balance(t.platform);
        const buyer0 = await t.balance(t.buyers[0]!);
        await h.pay(main, 0);
        const c1 = await h.provider().confirm(main.id);
        const c2 = await h.provider().confirm(main.id);
        assert.equal(c1.status, h.platform ? "confirmed" : "fulfilled");
        assert.equal(c2.status, c1.status);
        const [f1, f2] = await Promise.all([h.provider().fulfill(main.id), h.provider().fulfill(main.id)]);
        await h.provider().fulfill(main.id);
        assert.ok([f1.status, f2.status].includes("fulfilled") || (await load(main.id)).status === "fulfilled");
        const row = await load(main.id);
        assert.equal(row.status, "fulfilled");
        assert.equal((await rowsFor(main.purchaseId)).length, 1);
        if (h.platform) {
          assert.equal(await sentCount(main), 1, "exactly one fulfilment transaction");
          if (h.name === "agent-pay") {
            assert.equal(await t.balance(t.platform), float0, "settlement in, purchase out: the float is unchanged");
            assert.equal(buyer0 - (await t.balance(t.buyers[0]!)), PRICE, "the agent paid the price once");
            assert.equal(row.buyerWallet, t.buyers[0], "bound to the wallet that paid");
          } else {
            assert.equal(float0 - (await t.balance(t.platform)), PRICE, "the float paid the price once");
            assert.equal(await t.balance(t.buyers[0]!), buyer0, "the buyer paid nothing on-chain");
          }
          assert.ok(row.txHash, "tx hash on the ledger");
          assert.equal(row.gross, PRICE);
          assert.equal(row.fee, PRICE / 10n);
          assert.equal(row.creatorAmount, PRICE - PRICE / 10n);
          assert.notEqual(await refOnChain(t.platform, main.purchaseId), 0n);
        } else {
          assert.equal(buyer0 - (await t.balance(t.buyers[0]!)), PRICE, "the buyer paid the price");
          assert.notEqual(await refOnChain(t.buyers[0]!, main.purchaseId), 0n);
          assert.ok(row.ref);
        }
      });

      it("webhook / indexer replays are harmless", async () => {
        await h.notify(main);
        const first = await load(main.id);
        await h.notify(main);
        await h.notify(main);
        const again = await load(main.id);
        assert.equal(again.status, "fulfilled");
        assert.ok(again.txHash, "tx hash recorded");
        assert.equal(again.txHash, first.txHash);
        assert.equal(again.logIndex, first.logIndex);
        assert.equal((await rowsFor(main.purchaseId)).length, 1);
        if (h.platform) assert.equal(await sentCount(main), 1);
      });

      it("crash after the purchase landed: reconcile finishes via purchaseRef, no second purchase", async () => {
        const c = await h.create(agentA, 1);
        await h.pay(c, 1);
        if (h.platform) {
          await h.provider().confirm(c.id);
          // The crashed process had claimed the charge and broadcast the purchase, then died before recording it.
          const claimed = (await m.ledger.transition(c.id, ["confirmed"], "fulfilling"))!;
          const sent = await t.lanes.sendServerCalls({
            signer: "platform",
            lane: "platform",
            calls: m.fulfil.callsFor(claimed, PRICE),
            kind: m.fulfil.fulfilKind(h.name),
            ref: c.id,
          });
          await makeStale(c.id);
          await h.provider().reconcile(new Date());
          const row = await load(c.id);
          assert.equal(row.status, "fulfilled");
          assert.equal(row.txHash, sent.hash.toLowerCase());
          assert.equal(await sentCount(c), 1, "no second purchase");
        } else {
          // The wallet sent the batch but the sale was never delivered by the indexer.
          await h.provider().reconcile(new Date());
          assert.equal((await load(c.id)).status, "fulfilled");
          await h.notify(c);
          assert.ok((await load(c.id)).txHash);
        }
      });

      if (h.platform) {
        it("crash before the broadcast: reconcile sends exactly once", async () => {
          const c = await h.create(agentA, 2);
          await h.pay(c, 2);
          await h.provider().confirm(c.id);
          await m.ledger.transition(c.id, ["confirmed"], "fulfilling");
          await h.provider().reconcile(new Date()); // not stale yet: untouched
          assert.equal((await load(c.id)).status, "fulfilling");
          await makeStale(c.id);
          await h.provider().reconcile(new Date());
          assert.equal((await load(c.id)).status, "fulfilled");
          assert.equal(await sentCount(c), 1);
        });
      }

      it("price raised after the charge: refunded (platform) / never fulfilled and expired (wallet)", async () => {
        const agent = await t.newAgent();
        const c = await h.create(agent, 0);
        await t.setPrice(agent, PRICE + 1_000_000n);
        if (h.platform) {
          await h.pay(c, 0);
          await h.provider().confirm(c.id);
          const float0 = await t.balance(t.platform);
          await h.provider().fulfill(c.id);
          const row = await load(c.id);
          assert.equal(row.status, "refunded");
          assert.equal(row.error, "price_changed");
          if (h.name === "agent-pay") assert.equal(float0 - (await t.balance(t.platform)), PRICE, "the settlement went back to the agent");
          else assert.equal(await t.balance(t.platform), float0, "the float paid nothing");
          assert.equal(await sentCount(c), 0);
          if (h.name === "fake") assert.equal(fakeProvider.refunds.get(c.id), "price_changed");
          if (h.name === "pix-intermediated") assert.equal(m.ledger.payloadOf(row).refund, "simulated");
          if (h.name === "agent-pay") assert.equal(m.ledger.payloadOf(row).refund, "onchain");
        } else {
          await assert.rejects(h.pay(c, 0), (e: unknown) => m.chain.decodeSolversError(e).name === "PriceChanged");
          await h.provider().reconcile(new Date(Date.now() + 31 * 60_000));
          assert.equal((await load(c.id)).status, "expired");
        }
      });

      it("an unpaid charge expires", async () => {
        const c = await h.create(agentA, 3);
        await h.provider().reconcile(new Date());
        assert.equal((await load(c.id)).status, "pending_payment");
        await h.provider().reconcile(new Date(Date.now() + 31 * 60_000));
        assert.equal((await load(c.id)).status, "expired");
      });

      it("sold out: no new charge; a charge already paid is refunded (platform)", async () => {
        const agent = await t.newAgent({ maxSupply: 1 });
        const c = h.platform ? await h.create(agent, 0) : null;
        if (c) {
          await h.pay(c, 0);
          await h.provider().confirm(c.id);
        }
        // Someone else takes the last license directly.
        await t.sendAs(
          t.buyerKeys[4]!,
          m.chain.purchaseLicenseCalls(t.anvil.deployment, {
            agentId: m.shared.agentIdToBytes32(agent),
            price: PRICE,
            purchaseId: keccak256(toBytes(`direct-${agent}`)),
          }),
        );
        await assert.rejects(prepared(agent, 1), (e: unknown) => e instanceof m.http.HttpError && e.code === "sold_out");
        if (c) {
          await h.provider().fulfill(c.id);
          const row = await load(c.id);
          assert.equal(row.status, "refunded");
          assert.equal(row.error, "sold_out");
        }
      });

      it("paused: no new charge; a paid charge waits and completes after the unpause", async () => {
        const c = await h.create(agentA, 4);
        await t.admin("setPause", [1]);
        try {
          await assert.rejects(prepared(agentA, 0), (e: unknown) => e instanceof m.http.HttpError && e.code === "platform_paused");
          if (h.platform) {
            await h.pay(c, 4);
            await h.provider().confirm(c.id);
            await h.provider().fulfill(c.id);
            const row = await load(c.id);
            assert.equal(row.status, "confirmed", "paused is transient: no refund");
            assert.equal(row.error, "paused");
          } else {
            await assert.rejects(h.pay(c, 4), (e: unknown) => m.chain.decodeSolversError(e).name === "Paused");
          }
        } finally {
          await t.admin("setPause", [0]);
        }
        if (h.platform) {
          await h.provider().reconcile(new Date());
        } else {
          await h.pay(c, 4);
          await h.notify(c);
        }
        assert.equal((await load(c.id)).status, "fulfilled");
      });

      it("an on-chain duplicate of the purchase is mapped to fulfilled", async () => {
        const c = await h.create(agentA, 1);
        if (h.platform) {
          await h.pay(c, 1);
          await h.provider().confirm(c.id);
          const row = await load(c.id);
          // The purchase exists on-chain already (sent outside the fulfilment path, e.g. by an operator).
          const oob = await t.lanes.sendServerCalls({ signer: "platform", lane: "platform", calls: m.fulfil.callsFor(row, PRICE), kind: "test-oob", ref: `oob-${c.id}` });
          // The contract refuses the same purchase id again.
          await assert.rejects(
            t.lanes.sendServerCalls({ signer: "platform", lane: "platform", calls: m.fulfil.callsFor(row, PRICE), kind: "test-oob-again" }),
            (e: unknown) => m.chain.decodeSolversError(e).name === "DuplicatePurchase",
          );
          await h.provider().fulfill(c.id);
          const after = await load(c.id);
          assert.equal(after.status, "fulfilled");
          assert.ok(after.ref);
          assert.equal(await sentCount(c), 0, "the fulfilment sent nothing");
          await deliverSales(oob.receipt);
          assert.equal((await load(c.id)).txHash, oob.hash.toLowerCase());
        } else {
          await h.pay(c, 1);
          await assert.rejects(t.sendAs(t.buyerKeys[1]!, c.calls!), (e: unknown) => m.chain.decodeSolversError(e).name === "DuplicatePurchase");
          await h.notify(c);
          assert.equal((await load(c.id)).status, "fulfilled");
          assert.equal((await rowsFor(c.purchaseId)).length, 1);
        }
      });
    });
  }

  describe("SaleAuthorized handler", () => {
    it("an unsolicited purchase (no intent) gets a direct-wallet ledger row", async () => {
      const purchaseId = keccak256(toBytes(`unsolicited-${randomBytes(4).toString("hex")}`));
      const receipt = await t.sendAs(
        t.buyerKeys[2]!,
        m.chain.purchaseLicenseCalls(t.anvil.deployment, { agentId: m.shared.agentIdToBytes32(agentA), price: PRICE, purchaseId }),
      );
      await deliverSales(receipt);
      await deliverSales(receipt); // replay
      const rows = await rowsFor(purchaseId);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.provider, "direct-wallet");
      assert.equal(row.status, "fulfilled");
      assert.equal(row.buyerWallet, t.buyers[2]);
      assert.equal(row.payerWallet, t.buyers[2]);
      assert.equal(row.agentId, agentA);
      assert.equal(row.tokenAmount, PRICE);
      assert.equal(row.txHash, receipt.transactionHash.toLowerCase());
    });

    it("another payer reusing one of our purchase ids does not touch the charge (ids are scoped by payer)", async () => {
      const c = await harnesses[0]!.create(agentA, 0); // fake, platform-paid
      const receipt = await t.sendAs(
        t.buyerKeys[3]!,
        m.chain.purchaseLicenseCalls(t.anvil.deployment, { agentId: m.shared.agentIdToBytes32(agentA), price: PRICE, purchaseId: c.purchaseId }),
      );
      await deliverSales(receipt);
      const row = await load(c.id);
      assert.equal(row.status, "pending_payment");
      assert.equal(row.txHash, null);
      // ... and the platform can still fulfil it with the same id.
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      await fakeProvider.fulfill(c.id);
      assert.equal((await load(c.id)).status, "fulfilled");
    });
  });

  describe("kinds and failures", () => {
    it("credits through the fake provider", async () => {
      const p = await m.intent.preparePurchase({ kind: "credits", agentId: agentA, amount: 7 }, t.buyers[1]!);
      assert.equal(p.amount, PRICE_PER_USE * 7n);
      const c = await fakeProvider.createCharge(p.intent, { now: new Date(), details: p.details });
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      await fakeProvider.fulfill(c.id);
      const row = await load(c.id);
      assert.equal(row.status, "fulfilled");
      assert.equal(row.gross, PRICE_PER_USE * 7n);
      const { decodePurchaseRef } = await import("../src/payments/lifecycle.js");
      assert.equal(decodePurchaseRef(row.ref as Hex).kind, 2);
    });

    it("a guarantee (escrow) through Pix, milestones from the creator's template", async () => {
      const p = await m.intent.preparePurchase(
        { kind: "escrow", agentId: agentA, task: { title: "Build the form", description: "A login form with tests" } },
        t.buyers[0]!,
      );
      assert.equal(p.amount, 20_000_000n);
      const c = await pixProvider.createCharge(p.intent, { now: new Date(), details: p.details });
      const created = await load(c.id);
      assert.equal(created.amountBrlCents, 10_800n, "20 USD at 5.40");
      assert.equal(created.fxRate, "5.40000000");
      await pixProvider.simulatePayment(c.id);
      const row = await load(c.id);
      assert.equal(row.status, "fulfilled");
      const { decodePurchaseRef } = await import("../src/payments/lifecycle.js");
      assert.equal(decodePurchaseRef(row.ref as Hex).kind, 3);
      assert.equal(row.gross, 20_000_000n);
    });

    it("acceptance tests are refused by the default planner", async () => {
      await assert.rejects(
        m.intent.preparePurchase(
          { kind: "escrow", agentId: agentA, task: { title: "x", description: "y", acceptanceTests: [{ "a.test.ts": "x" }] } },
          t.buyers[0]!,
        ),
        (e: unknown) => e instanceof m.http.HttpError && e.code === "acceptance_tests_unavailable",
      );
    });

    it("failFulfillOnce: a transient failure leaves the charge confirmed and the reconcile job completes it", async () => {
      const c = await harnesses[0]!.create(agentA, 2);
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      fakeProvider.failFulfillOnce();
      await assert.rejects(fakeProvider.fulfill(c.id), /injected/);
      assert.equal((await load(c.id)).status, "confirmed");
      await fakeProvider.reconcile(new Date());
      assert.equal((await load(c.id)).status, "fulfilled");
      assert.equal(await sentCount(c), 1);
    });

    it("pix webhook with a bad signature is refused", async () => {
      const c = await harnesses[2]!.create(agentA, 1);
      const row = await load(c.id);
      const req = signedMpWebhook(row.providerChargeId!);
      await assert.rejects(
        pixProvider.handleWebhook({ ...req, headers: { ...req.headers, "x-signature": "ts=1,v1=" + "0".repeat(64) } }),
        (e: unknown) => e instanceof m.http.HttpError && e.status === 401,
      );
      assert.equal(await pixProvider.handleWebhook(signedMpWebhook("ORD-UNKNOWN")), null);
    });

    it("refund idempotency: the request path and two reconcile ticks racing on one refunding charge refund once", async () => {
      const c = await harnesses[0]!.create(agentA, 3);
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      await m.ledger.transition(c.id, ["confirmed"], "refunding", { error: "test_refund" });
      // Fresh: the reconcile job leaves it to the request path that is (supposedly) sending it.
      await fakeProvider.reconcile(new Date());
      assert.equal(fakeProvider.refundCalls.get(c.id) ?? 0, 0);
      await makeStale(c.id);
      fakeProvider.refundDelayMs = 300;
      const later = new Date(Date.now() + 10 * 60_000);
      try {
        await Promise.all([fakeProvider.reconcile(later), fakeProvider.reconcile(later), fakeProvider.refund(c.id, "test_refund")]);
      } finally {
        fakeProvider.refundDelayMs = 0;
      }
      assert.equal(fakeProvider.refundCalls.get(c.id), 1, "returnPayment ran once");
      assert.equal((await load(c.id)).status, "refunded");
      await fakeProvider.reconcile(later);
      await fakeProvider.refund(c.id, "again");
      assert.equal(fakeProvider.refundCalls.get(c.id), 1);
    });

    it("refund after a late sale: the chain is read again, the charge becomes fulfilled and nothing is refunded", async () => {
      const c = await harnesses[0]!.create(agentA, 4);
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      const row = await load(c.id);
      await t.lanes.sendServerCalls({ signer: "platform", lane: "platform", calls: m.fulfil.callsFor(row, PRICE), kind: "test-late", ref: `late-${c.id}` });
      await fakeProvider.refund(c.id, "manual");
      assert.equal((await load(c.id)).status, "fulfilled");
      assert.equal(fakeProvider.refundCalls.get(c.id) ?? 0, 0);
    });

    it("an unknown deterministic revert is retried a bounded number of times, then the admins are alerted and the buyer refunded", async () => {
      const c = await harnesses[0]!.create(await t.newAgent(), 2); // own agent: buyer 2 already holds agentA (indexed at once)
      // A contract that cannot receive an ERC-721: every purchaseLicenseFor reverts, with an error no list knows.
      await m.ledger.patchCharge(c.id, { buyerWallet: t.anvil.deployment.registry.toLowerCase() });
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      for (let i = 1; i < m.lifecycle.MAX_FULFIL_ATTEMPTS; i++) {
        const r = await fakeProvider.fulfill(c.id);
        assert.equal(r.status, "confirmed", `attempt ${i} stays confirmed`);
        assert.equal(m.ledger.payloadOf(await load(c.id)).fulfilAttempts, i);
      }
      const last = await fakeProvider.fulfill(c.id);
      assert.equal(last.status, "refunded");
      assert.match(fakeProvider.refunds.get(c.id) ?? "", /^unfulfillable:/);
      assert.equal(await sentCount(c), 0, "nothing was ever broadcast");
    });

    it("SaleAuthorized: unknown kind or non-package agent id is skipped; alerts are returned for after the commit", async () => {
      const junk = await m.hook.handleSaleAuthorized({
        purchaseId: keccak256(toBytes(`junk-${randomBytes(4).toString("hex")}`)),
        agentId: keccak256(toBytes("not-a-package-id")),
        buyer: t.buyers[0]!,
        payer: t.buyers[0]!,
        kind: 9,
        ref: `0x${"0".repeat(63)}1`,
        txHash: keccak256(toBytes("junk-tx")),
        logIndex: 0,
        blockNumber: 1n,
        siblings: [],
      });
      assert.equal(junk.after?.length ?? 0, 0);
      // A sale of a charge that was already refunded: the alert is deferred, not sent inside the indexer transaction.
      const c = await harnesses[0]!.create(agentA, 1);
      fakeProvider.pay(c.id);
      await fakeProvider.confirm(c.id);
      await fakeProvider.refund(c.id, "manual");
      const res = await m.hook.handleSaleAuthorized({
        purchaseId: c.purchaseId,
        agentId: m.shared.agentIdToBytes32(agentA),
        buyer: t.buyers[1]!,
        payer: t.platform,
        kind: 1,
        ref: `0x${"0".repeat(63)}1`,
        txHash: keccak256(toBytes(`late-sale-${c.id}`)),
        logIndex: 0,
        blockNumber: 1n,
        siblings: [],
      });
      assert.equal(res.after?.length, 1, "one deferred admin alert");
      assert.match((await load(c.id)).error ?? "", /sale seen on-chain while refunded/);
    });

    it("guarantee texts: only the escrow recorded on the payer's ledger row gets them, never another wallet's escrow with the same purchase id", async () => {
      const p = await m.intent.preparePurchase({ kind: "escrow", agentId: agentA, task: { title: "Secret task", description: "Private details" } }, t.buyers[2]!);
      const c = await pixProvider.createCharge(p.intent, { now: new Date(), details: p.details });
      await pixProvider.simulatePayment(c.id);
      const row = await load(c.id);
      assert.equal(row.status, "fulfilled");
      const escrowId = String(m.ledger.payloadOf(row).escrowId);
      assert.match(escrowId, /^\d+$/, "the escrow id is recorded on the ledger row");
      const { escrows, milestones } = t.db.schema;
      const { eq, inArray } = await import("drizzle-orm");
      const attackerId = `9${Date.now()}${randomBytes(2).readUInt16BE(0)}`;
      const base = { agentId: agentA, creatorWallet: t.buyers[4]!, purchaseId: c.purchaseId.toLowerCase(), total: 20_000_000n, reviewWindowSecs: 60, feeBps: 1000 };
      // The indexer would mirror these from EscrowCreated; the attacker reused the public purchase id in its own createEscrow.
      await t.db.db
        .insert(escrows)
        .values([
          { ...base, id: escrowId, buyerWallet: t.buyers[2]! },
          { ...base, id: attackerId, buyerWallet: t.buyers[3]! },
        ])
        .onConflictDoNothing();
      // The record the store's planner writes (`intent.task`, EscrowIntentRecord), with the planned criteria hashes.
      const planned = (row.intent as { milestones: { criteriaHash: string; amount: string }[] }).milestones;
      const task = {
        title: "Secret task",
        description: "Private details",
        deliveryDays: 0,
        reviewWindowSecs: 60,
        milestones: planned.map((ms, idx) => ({
          title: `Step ${idx}`,
          criteria: "private criteria",
          verify: "tests",
          amountUnits: ms.amount,
          criteriaHash: ms.criteriaHash,
          acceptancePath: `/private/acceptance-${idx}`,
          acceptanceHash: "ab".repeat(32),
        })),
      };
      await t.db.db.update(t.db.schema.paymentLedger).set({ intent: { ...row.intent, task } }).where(eq(t.db.schema.paymentLedger.id, c.id));
      for (const id of [escrowId, attackerId]) {
        await t.db.db
          .insert(milestones)
          .values(planned.map((ms, idx) => ({ escrowId: id, idx, title: "", criteria: "", criteriaHash: ms.criteriaHash.toLowerCase(), amount: BigInt(ms.amount) })))
          .onConflictDoNothing();
      }
      try {
        const { fillEscrowTexts } = await import("../src/store/escrow.js");
        assert.equal(await fillEscrowTexts(attackerId), 0, "the attacker's escrow is not filled");
        assert.equal(await fillEscrowTexts(escrowId), 1);
        const [mine] = await t.db.db.select().from(escrows).where(eq(escrows.id, escrowId));
        const [theirs] = await t.db.db.select().from(escrows).where(eq(escrows.id, attackerId));
        assert.equal(mine!.title, "Secret task");
        assert.equal(theirs!.title, "");
        await fillEscrowTexts();
        const [still] = await t.db.db.select().from(escrows).where(eq(escrows.id, attackerId));
        assert.equal(still!.title, "", "the sweep never fills the attacker's escrow");
        const theirMs = await t.db.db.select().from(milestones).where(eq(milestones.escrowId, attackerId));
        assert.ok(theirMs.every((x) => x.criteria === "" && x.acceptancePath === null));
      } finally {
        await t.db.db.delete(milestones).where(inArray(milestones.escrowId, [escrowId, attackerId]));
        await t.db.db.delete(escrows).where(inArray(escrows.id, [escrowId, attackerId]));
      }
    });

    it("pix simulation: refused for expired charges and on real Mercado Pago charges", async () => {
      const c = await harnesses[2]!.create(agentA, 3);
      await m.ledger.patchCharge(c.id, { payload: { mode: "mercadopago" } });
      await assert.rejects(pixProvider.simulatePayment(c.id), (e: unknown) => e instanceof m.http.HttpError && e.code === "pix_not_simulated");
      await m.ledger.patchCharge(c.id, { payload: { mode: "simulated", expiresAt: new Date(Date.now() - 1000).toISOString() } });
      await assert.rejects(pixProvider.simulatePayment(c.id), (e: unknown) => e instanceof m.http.HttpError && e.code === "pix_expired");
    });
  });

  describe("agent-pay settlements", () => {
    const ap = () => harnesses.find((h) => h.name === "agent-pay")!;
    const dupRefunds = (hash: string) => t.lanes.sentTxsFor(m.ap.DUPLICATE_REFUND_KIND, hash.toLowerCase());

    it("a second settlement of a paid order (another wallet) is refunded once, even with concurrent hooks", async () => {
      const c = await ap().create(agentA, 0);
      await ap().pay(c, 0);
      await apProvider.confirm(c.id);
      await apProvider.fulfill(c.id);
      assert.equal((await load(c.id)).status, "fulfilled");
      const other = t.buyers[1]!;
      const before = await t.balance(other);
      const dup = await t.sendAs(t.buyerKeys[1]!, [memoTransfer(PRICE, `conformance-${c.id}`)], { sponsored: true });
      assert.equal(before - (await t.balance(other)), PRICE);
      await Promise.all([apProvider.markSettled(c.id, dup.transactionHash), apProvider.markSettled(c.id, dup.transactionHash)]);
      await apProvider.markSettled(c.id, dup.transactionHash);
      const row = await load(c.id);
      const d = (m.ledger.payloadOf(row).duplicates as Record<string, { refundTx: string | null; from: string }>)[dup.transactionHash.toLowerCase()];
      assert.ok(d?.refundTx, "duplicate refunded");
      assert.equal(d.from, other);
      assert.equal(row.status, "fulfilled", "the order itself is untouched");
      assert.equal(row.buyerWallet, t.buyers[0], "still bound to its first payer");
      assert.equal((await dupRefunds(dup.transactionHash)).length, 1, "one refund transaction");
      assert.equal(await t.balance(other), before, "the second payer got the money back");
    });

    it("an unpaid order paid by two wallets: the reconcile scan binds the first settlement and refunds the other", async () => {
      const c = await ap().create(agentA, 0);
      const a = await t.sendAs(t.buyerKeys[2]!, [memoTransfer(PRICE, `conformance-${c.id}`)], { sponsored: true });
      const bBefore = await t.balance(t.buyers[3]!);
      const b = await t.sendAs(t.buyerKeys[3]!, [memoTransfer(PRICE, `conformance-${c.id}`)], { sponsored: true });
      // No success hook ran: one scan per tick finds both, binds the first and refunds the second.
      await apProvider.reconcile(new Date());
      const row = await load(c.id);
      assert.equal(row.status, "fulfilled");
      assert.equal(row.buyerWallet, t.buyers[2]);
      assert.equal(m.ledger.payloadOf(row).settlementTx, a.transactionHash.toLowerCase());
      assert.equal((await dupRefunds(b.transactionHash)).length, 1);
      assert.equal(await t.balance(t.buyers[3]!), bBefore);
      await apProvider.reconcile(new Date());
      assert.equal((await dupRefunds(b.transactionHash)).length, 1, "a later tick sends nothing more");
    });

    it("claimOrder: one live claim per order, and never for a second wallet", async () => {
      const c = await ap().create(agentA, 0);
      const row = await load(c.id);
      const [x, y] = await Promise.all([apProvider.claimOrder(row, t.buyers[0]!, "ch-x"), apProvider.claimOrder(row, t.buyers[0]!, "ch-y")]);
      assert.equal([x, y].filter(Boolean).length, 1, "a retry with another transaction is refused while the first is in flight");
      assert.equal(await apProvider.claimOrder(row, t.buyers[1]!, "ch-z", new Date(Date.now() + 10 * 60_000)), null, "bound to the first wallet");
      assert.ok(await apProvider.claimOrder(row, t.buyers[0]!, "ch-w", new Date(Date.now() + 10 * 60_000)), "the same wallet may retry after the lock");
    });

    it("a refund whose journal row is still inside its validity window (even marked failed) is never sent again", async () => {
      const c = await ap().create(agentA, 4);
      await ap().pay(c, 4);
      await apProvider.confirm(c.id);
      await t.db.db.insert(t.db.schema.sentTxs).values({
        account: t.platform,
        lane: 1,
        nonce: 999_999n,
        txHash: keccak256(toBytes(`ghost-${c.id}`)),
        kind: m.ap.SETTLEMENT_REFUND_KIND,
        ref: c.id,
        status: "failed",
        validBefore: new Date(Date.now() + 60_000),
      });
      await assert.rejects(apProvider.refund(c.id, "manual"), /in flight/);
      assert.equal((await load(c.id)).status, "refunding");
      assert.equal((await t.lanes.sentTxsFor(m.ap.SETTLEMENT_REFUND_KIND, c.id)).length, 1, "nothing new was sent");
    });
  });
});
