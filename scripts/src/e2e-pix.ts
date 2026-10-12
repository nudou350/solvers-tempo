// Pix end to end (decisions.md D10, `pix-intermediated`): one charge buys one license for the session wallet; once the
// (simulated) Pix is paid, the PLATFORM key fulfils it on-chain with `purchaseLicenseFor(buyer, ..., purchaseId)` from
// its float (fee sponsored by RELAY). Replays (simulate again, Mercado Pago webhook replays, in parallel) never produce
// a second transaction. The buyer holds no stablecoin at any point.
//
// Needs a server off mainnet with PIX_SIMULATE (default). For the signed-webhook checks the server and this script need
// the same MP_WEBHOOK_SECRET (env, else read from SERVER_ENV_FILE); without it those checks are skipped and the run
// fails unless E2E_ALLOW_SKIP=1.
//
//   cd scripts && MP_WEBHOOK_SECRET=... npx tsx src/e2e-pix.ts       # API_URL, E2E_SLUG (frontend-react)
import { createHmac, randomBytes } from "node:crypto";
import { solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";
import { purchaseIdFor } from "@solvers/shared";
import type { Hex } from "viem";
import { API_URL, freshAccount, network, serverAccount, serverEnv, tokenBalance } from "./env.js";
import { agentDetail, chainAgent, eventsOf, getConfig, ownerOf, waitFor } from "./lib/flows.js";
import { expectFailure } from "./lib/http.js";
import { assert, assertEq, run } from "./lib/report.js";
import { TestWallet, feePayerOf } from "./lib/wallet.js";

const SLUG = process.env.E2E_SLUG ?? "frontend-react";
const SECRET = process.env.MP_WEBHOOK_SECRET ?? serverEnv().MP_WEBHOOK_SECRET;

type PixCharge = { id: string; provider: string; status: string; kind: string; agentId: string; purchaseId: Hex; amountUnits: string; amountBrl: number; qrCode: string | null; txHash: Hex | null; simulated: boolean };

function signedHeaders(dataId: string, secret: string, requestId = randomBytes(8).toString("hex"), ts = String(Date.now())) {
  const v1 = createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
  return { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId };
}
async function webhook(dataId: string, headers: Record<string, string>) {
  const res = await fetch(`${API_URL}/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}&type=order`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action: "order.processed", type: "order", data: { id: dataId, status: "processed" } }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { ok?: boolean; ignored?: boolean; status?: string } };
}

await run(`e2e-pix (${API_URL})`, async (r) => {
  const n = await network();
  r.setExplorer(n.explorer);
  await r.step("Pix is enabled in simulated mode", async () => {
    const c = await getConfig();
    assert(c.pix.enabled && c.pix.simulate, `pix config: ${JSON.stringify(c.pix)}`);
  });
  const detail = await agentDetail(SLUG);
  const agentBefore = await chainAgent(detail.agent.id);
  const buyer = await new TestWallet(freshAccount(), "buyer").login();
  const platform = serverAccount("PLATFORM_PRIVATE_KEY").address.toLowerCase();

  const charge = (await r.step("charge for ONE license, priced at the on-chain price", async (note) => {
    const c = await buyer.post<PixCharge>("/api/pix/charges", { kind: "license", agentId: detail.agent.id });
    assertEq([c.status, c.kind, c.agentId, c.provider], ["pending_payment", "license", detail.agent.id, "simulated"], "charge");
    assertEq(BigInt(c.amountUnits), agentBefore.price, "amount");
    assertEq(c.purchaseId, purchaseIdFor(c.id), "purchase id = keccak(solvers:v1: + chargeId)");
    assert(c.qrCode && c.amountBrl > 0, "no Pix code / BRL amount");
    note(`${c.id}: R$ ${c.amountBrl} for ${c.amountUnits} units`);
    return c;
  }))!;
  await r.step("another wallet cannot read the charge (404)", async () => {
    const stranger = await new TestWallet(freshAccount(), "stranger").login();
    await expectFailure(stranger.get(`/api/pix/charges/${charge.id}`), 404);
  });
  const providerId = `sim_${charge.id}`;
  if (SECRET) {
    await r.step("signed webhook before payment changes nothing", async () => {
      const w = await webhook(providerId, signedHeaders(providerId, SECRET));
      assertEq(w.status, 200, "status");
      const c = await buyer.get<PixCharge>(`/api/pix/charges/${charge.id}`);
      assertEq([c.status, c.txHash], ["pending_payment", null], "charge");
    });
  } else r.skip("signed webhook before payment", "MP_WEBHOOK_SECRET not available to the script");

  const paid = (await r.step("simulated payment -> PLATFORM fulfils purchaseLicenseFor on-chain", async () => {
    const c = await buyer.post<PixCharge>(`/api/pix/charges/${charge.id}/simulate`);
    assertEq(c.status, "fulfilled", "status");
    assert(c.txHash, "no fulfilment tx");
    r.tx("pix fulfilment (purchaseLicenseFor)", c.txHash);
    return c;
  }))!;
  await r.step(
    "the license is in the API mirror as soon as the charge is fulfilled (D9: server-sent txs are indexed at once)",
    async () => {
      const mine = await buyer.get<{ id: string }[]>("/api/me/licenses");
      assert(mine.length > 0, "GET /api/me/licenses is empty right after the fulfilled answer (the fulfilment tx waits for the poller)");
    },
    { critical: false },
  );
  const tokenId = (await r.step("the license is minted to the buyer, paid by the PLATFORM float, fee sponsored", async () => {
    const receipt = await n.publicClient.getTransactionReceipt({ hash: paid.txHash! });
    assertEq(receipt.from.toLowerCase(), platform, "sender = PLATFORM key");
    assert(feePayerOf(receipt) && feePayerOf(receipt) !== platform, `fee payer ${feePayerOf(receipt)}`);
    const ev = (await eventsOf(receipt)).find((e) => e.eventName === "LicensePurchased");
    assert(ev, "no LicensePurchased");
    const a = ev.args as { buyer: string; payer: string; tokenId: bigint; purchaseId: Hex; price: bigint };
    assertEq([a.buyer.toLowerCase(), a.payer.toLowerCase(), a.purchaseId, a.price], [buyer.lower, platform, charge.purchaseId, agentBefore.price], "LicensePurchased");
    assertEq(await ownerOf(a.tokenId), buyer.lower, "ownerOf");
    assertEq(await tokenBalance(buyer.address), 0n, "buyer stablecoin balance (never needed)");
    return a.tokenId;
  }))!;

  await r.step("replays (simulate x2 in parallel + signed webhooks x2) produce no second transaction", async () => {
    const replays: Promise<string | null>[] = [
      buyer.post<PixCharge>(`/api/pix/charges/${charge.id}/simulate`).then((c) => c.txHash),
      buyer.post<PixCharge>(`/api/pix/charges/${charge.id}/simulate`).then((c) => c.txHash),
    ];
    if (SECRET) {
      replays.push(webhook(providerId, signedHeaders(providerId, SECRET)).then((w) => (w.status === 200 ? paid.txHash : `webhook ${w.status}`)));
      replays.push(webhook(providerId, signedHeaders(providerId, SECRET)).then((w) => (w.status === 200 ? paid.txHash : `webhook ${w.status}`)));
    } else r.skip("signed webhook replays", "MP_WEBHOOK_SECRET not available to the script");
    const hashes = await Promise.all(replays);
    for (const h of hashes) assertEq(h?.toLowerCase(), paid.txHash!.toLowerCase(), "tx hash after replay");
    const c = await buyer.get<PixCharge>(`/api/pix/charges/${charge.id}`);
    assertEq([c.status, c.txHash?.toLowerCase()], ["fulfilled", paid.txHash!.toLowerCase()], "charge after replays");
    const balance = await n.publicClient.readContract({ address: n.deployment.license, abi: solversLicenseAbi, functionName: "balanceOf", args: [buyer.address] });
    assertEq(balance, 1n, "licenses held by the buyer");
    const agentAfter = await chainAgent(detail.agent.id);
    assertEq(agentAfter.totalSales - agentBefore.totalSales, 1, "sales counted (exactly one for the charge and its replays)");
    const ref = await n.publicClient.readContract({ address: n.deployment.registry, abi: solversRegistryAbi, functionName: "purchaseRef", args: [platform as Hex, charge.purchaseId] });
    assert(BigInt(ref) !== 0n, "purchaseRef(PLATFORM, purchaseId) empty");
    return `${hashes.length} replays -> 1 tx, buyer holds 1 license (#${tokenId})`;
  });
  // D9: the server indexes every transaction it sends right away, so the license should be listed as soon as the charge
  // says "fulfilled" (checked as soon as the fulfilment answered, before the replays above could give the poller time).
  await r.step("the buyer sees the license in the API (polled, up to 60 s)", async (note) => {
    const t0 = Date.now();
    await waitFor("the license in /api/me/licenses", async () => (await buyer.get<{ id: string }[]>("/api/me/licenses")).some((l) => l.id === tokenId.toString()), 60_000, 1000);
    note(`listed after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  });
  await r.step("webhook without / with a wrong signature -> 401; a signature reused for another id -> 401", async () => {
    const orderId = `ORD${randomBytes(12).toString("hex").toUpperCase()}`;
    const none = await webhook(orderId, {});
    const bad = await webhook(orderId, { "x-signature": `ts=${Date.now()},v1=${"0".repeat(64)}`, "x-request-id": "e2e" });
    assertEq([none.status, bad.status], [401, 401], "statuses");
    if (SECRET) {
      const h = signedHeaders(orderId, SECRET);
      const ok = await webhook(orderId, h);
      assertEq([ok.status, ok.body.ignored], [200, true], "valid signature, unknown order");
      const swapped = await webhook(`${orderId}X`, h);
      assertEq(swapped.status, 401, "reused signature");
    }
  });
  if (!SECRET) r.skip("valid signature for an unknown order; signature reused for another id", "MP_WEBHOOK_SECRET not available to the script");
  await r.step("at most 3 open Pix charges per wallet (429 pix_pending_limit)", async () => {
    const w = await new TestWallet(freshAccount(), "pending-limit").login();
    for (let i = 0; i < 3; i++) await w.post("/api/pix/charges", { kind: "license", agentId: detail.agent.id });
    await expectFailure(w.post("/api/pix/charges", { kind: "license", agentId: detail.agent.id }), 429, "pix_pending_limit");
  });
});
