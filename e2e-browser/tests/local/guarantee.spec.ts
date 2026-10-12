// Scenario 7 (mode A): a task with a result guarantee. (a) Created from the checkout and paid with the wallet balance:
// the escrow on chain holds the milestones and amounts of the offer; the Solver delivers the plan (through the
// connector, as the buyer's AI would); the buyer approves it on /guarantees and the milestone is paid with the fee
// split. (b) Same task, but the buyer disputes the delivered plan on /guarantees.
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { solversEscrowAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, purchaseIdFor } from "@solvers/shared";
import type { Hex } from "viem";
import { agentDetail, chainAgent, eventArgs, fund, getConfig, lower, network, receiptOf, registryConfig, relayAddress, units } from "../../src/chain.js";
import { agree, blockDeltas, choosePayment, expectSponsored, nextConfirmedTx, openCheckout, payButton, readDone, tokenTransfers } from "../../src/checkout.js";
import { deliverPlan, ownEscrow } from "../../src/data.js";
import { expect, signInWithDevWallet, test, type Evidence } from "../../src/fixtures.js";

const SLUG = "frontend-react";
const STATUS = { Pending: 0, Passed: 1, Approved: 2, Disputed: 3, Refunded: 4 } as const;

async function escrowOnChain(escrowId: string) {
  const n = await network();
  const [buyer, agentId, creator, total, feeBps, reviewWindowSecs, deliveryDeadline, milestones] = await n.publicClient.readContract({
    address: n.deployment.escrow,
    abi: solversEscrowAbi,
    functionName: "escrowOf",
    args: [BigInt(escrowId)],
  });
  return { buyer: lower(buyer), agentId: lower(agentId), creator: lower(creator), total, feeBps: Number(feeBps), reviewWindowSecs, deliveryDeadline, milestones };
}

/** Waits until the API mirror shows milestone `index` as passed (the server marked the delivery). */
async function waitPassed(page: Page, escrowId: string, index: number) {
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/me/escrows/${escrowId}`);
      return r.ok() ? ((await r.json()) as { escrow: { milestones: { status: string }[] } }).escrow.milestones[index]?.status : `HTTP ${r.status()}`;
    }, { timeout: 90_000, message: `milestone ${index} passed` })
    .toBe("passed");
}

/** The deliverable of milestone 0 is marked on chain (Passed, deliverable hash set) before the buyer acts on it. */
async function expectPassedOnChain(ev: Evidence, escrowId: string) {
  const e = await escrowOnChain(escrowId);
  expect(e.milestones[0]!.status, "milestone 0 Passed on chain").toBe(STATUS.Passed);
  expect(e.milestones[0]!.deliverableHash, "deliverable hash recorded").not.toBe(`0x${"0".repeat(64)}`);
  ev.checked(`milestone 0 delivered through the connector: Passed on chain, deliverable hash ${e.milestones[0]!.deliverableHash.slice(0, 18)}…`);
}

test("scenario 7a: guaranteed task from the checkout, delivered plan approved on /guarantees (milestone paid)", async ({ page, devWallet, evidence }) => {
  const d = await agentDetail(SLUG);
  // The offer as the API publishes it (scripts' AgentDetail type omits these fields).
  const g = d.guarantee as unknown as { priceUsdc: number; reviewWindowSecs: number; milestones: { amountUsdc: number; criteria: string[] }[] };
  expect(g, `${SLUG} offers a guarantee`).toBeTruthy();
  const onchain = await chainAgent(d.agent.id);
  const cfg = await registryConfig();
  const total = units(g.priceUsdc);
  const amounts = g.milestones.map((m) => units(m.amountUsdc));
  expect(amounts.reduce((a, b) => a + b, 0n), "milestones add up to the guarantee price").toBe(total);
  for (const h of await fund(devWallet.address, total)) await evidence.tempo("test funds for the buyer (anvil funder)", h);

  await signInWithDevWallet(page);
  await openCheckout(page, SLUG, "guarantee");
  await page.locator("#task-title").fill("Login form");
  await page.locator("#task-desc").fill("Login form with e-mail and password, validation on submit and accessible error messages.");
  await choosePayment(page, "wallet", (await getConfig()).paymentToken.symbol);
  await agree(page);
  await payButton(page).click();
  const done = await readDone(page, "escrow");

  const receipt = await receiptOf(done.txHash);
  expect(receipt.status).toBe("success");
  await evidence.tempo("createEscrow (wallet balance, sponsored)", done.txHash);
  expectSponsored(receipt, devWallet.address, relayAddress());
  const created = await eventArgs<{ escrowId: bigint; agentId: Hex; buyer: string; payer: string; total: bigint; feeBps: number; purchaseId: Hex }>(receipt, "EscrowCreated");
  expect(created.length, "EscrowCreated events").toBe(1);
  const c = created[0]!;
  expect([lower(c.agentId), lower(c.buyer), lower(c.payer), c.total, Number(c.feeBps), lower(c.purchaseId)], "EscrowCreated").toEqual([
    lower(agentIdToBytes32(d.agent.id)),
    devWallet.lower,
    devWallet.lower,
    total,
    cfg.feeBps,
    lower(purchaseIdFor(done.chargeId)),
  ]);
  const escrowId = c.escrowId.toString();
  const e = await escrowOnChain(escrowId);
  expect([e.buyer, e.creator, e.total, e.feeBps], "escrowOf(buyer, creator, total, feeBps)").toEqual([devWallet.lower, lower(onchain.creator), total, cfg.feeBps]);
  expect(e.milestones.map((m) => [m.amount, m.status]), "milestones of the offer, all pending").toEqual(amounts.map((a) => [a, STATUS.Pending]));
  expect(Number(e.reviewWindowSecs), "review window of the offer").toBe(g.reviewWindowSecs);
  const n = await network();
  expect(await tokenTransfers(receipt).then((t) => t.filter(([f]) => f === devWallet.lower)), "buyer -> escrow contract, the whole price").toEqual([[devWallet.lower, lower(n.deployment.escrow), total]]);
  expect(await blockDeltas(receipt, { buyer: devWallet.address, escrow: n.deployment.escrow }), "block deltas").toEqual({ buyer: -total, escrow: total });
  evidence.checked(`EscrowCreated #${escrowId} (buyer, total ${total}, feeBps ${cfg.feeBps}, purchaseId of ${done.chargeId}); escrowOf: milestones ${amounts.join(" + ")} pending; buyer -${total}, escrow contract +${total}`);

  // The Solver delivers the plan (milestone 0, manual review) through the connector.
  await deliverPlan(devWallet.account, d.agent.id, escrowId);
  await waitPassed(page, escrowId, 0);
  await expectPassedOnChain(evidence, escrowId);

  // The buyer approves it on /guarantees.
  await page.goto("/en/guarantees");
  const approve = page.getByRole("button", { name: "Approve and release payment" });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  const sent = nextConfirmedTx(page);
  await approve.click();
  const hash = await sent;
  await expect(page.getByText("Step approved", { exact: true }).first()).toBeVisible();

  const r2 = await receiptOf(hash);
  expect(r2.status).toBe("success");
  await evidence.tempo("releaseMilestone(0) (sponsored)", hash);
  expectSponsored(r2, devWallet.address, relayAddress());
  const amount = amounts[0]!;
  const fee = (amount * BigInt(cfg.feeBps)) / 10_000n;
  const paid = await eventArgs<{ escrowId: bigint; index: number; creator: string; amount: bigint; fee: bigint; deferred: boolean }>(r2, "MilestonePaid");
  expect(paid.map((p) => [p.escrowId.toString(), Number(p.index), lower(p.creator), p.amount, p.fee, p.deferred]), "MilestonePaid").toEqual([[escrowId, 0, lower(onchain.creator), amount, fee, false]]);
  expect(await blockDeltas(r2, { creator: onchain.creator, treasury: cfg.treasury, escrow: n.deployment.escrow }), "release deltas").toEqual({ creator: amount - fee, treasury: fee, escrow: -amount });
  const after = await escrowOnChain(escrowId);
  expect(after.milestones.map((m) => m.status), "milestone 0 Approved, milestone 1 still Pending").toEqual([STATUS.Approved, STATUS.Pending]);
  evidence.checked(`release: MilestonePaid(${amount}, fee ${fee}); creator +${amount - fee}, treasury +${fee}, escrow -${amount}; statuses [Approved, Pending]`);
});

test("scenario 7b: the buyer disputes a delivered milestone on /guarantees (criterion + reason, on chain)", async ({ page, devWallet, evidence }) => {
  const d = await agentDetail(SLUG);
  const { escrowId } = await ownEscrow(evidence, devWallet.account, SLUG);
  await signInWithDevWallet(page);
  await deliverPlan(devWallet.account, d.agent.id, escrowId);
  await waitPassed(page, escrowId, 0);
  await expectPassedOnChain(evidence, escrowId);

  await page.goto("/en/guarantees");
  await page.getByRole("button", { name: "Dispute", exact: true }).click();
  const criterion = d.guarantee!.milestones[0]!.criteria[0]!;
  await page.getByRole("button", { name: criterion }).click();
  const reason = "The plan does not list the loading state of the submit button.";
  await page.getByLabel("What was missing?").fill(reason);
  const sent = nextConfirmedTx(page);
  await page.getByRole("button", { name: "Send dispute" }).click();
  const hash = await sent;
  await expect(page.getByText("Dispute sent", { exact: true }).first()).toBeVisible();

  const receipt = await receiptOf(hash);
  expect(receipt.status).toBe("success");
  await evidence.tempo("openDispute(0) (sponsored)", hash);
  expectSponsored(receipt, devWallet.address, relayAddress());
  const upd = await eventArgs<{ escrowId: bigint; index: number; status: number; by: string; hash: Hex }>(receipt, "MilestoneUpdated");
  expect(upd.map((u) => [u.escrowId.toString(), Number(u.index), Number(u.status), lower(u.by)]), "MilestoneUpdated(Disputed by the buyer)").toEqual([[escrowId, 0, STATUS.Disputed, devWallet.lower]]);
  // The reason hash commits to the chosen criterion and the text typed in the form (server: sha256(criterion + "\n" + reason)).
  expect(lower(upd[0]!.hash), "dispute reason hash = sha256(criterion + newline + reason)").toBe(`0x${createHash("sha256").update(`${criterion}\n${reason}`).digest("hex")}`);
  const e = await escrowOnChain(escrowId);
  expect([e.milestones[0]!.status, lower(e.milestones[0]!.disputeReasonHash)], "milestone 0 on chain").toEqual([STATUS.Disputed, lower(upd[0]!.hash)]);
  const n = await network();
  const status = await n.publicClient.readContract({ address: n.deployment.escrow, abi: solversEscrowAbi, functionName: "statusOf", args: [BigInt(escrowId)] });
  expect(status, "escrow status Disputed").toBe(2);
  expect(await tokenTransfers(receipt).then((t) => t.filter(([f, to]) => f === lower(n.deployment.escrow) || to === lower(n.deployment.escrow))), "no money moves on a dispute").toEqual([]);
  evidence.checked(`openDispute: MilestoneUpdated(Disputed, by buyer, reason hash = sha256 of the chosen criterion and the typed reason), escrow #${escrowId} status Disputed, no token moved`);
});
