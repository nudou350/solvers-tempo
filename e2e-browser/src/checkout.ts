// Checkout steps in the browser (English UI) and the on-chain checks shared by the purchase scenarios.
import type { Page } from "@playwright/test";
import { erc20Abi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { eventArgs, feePayerOf, lower, network, ownerOf, receiptOf, registryConfig } from "./chain.js";
import { purchaseIdFor } from "@solvers/shared";
import { expect, type Evidence } from "./fixtures.js";

export type PayMethod = "wallet" | "pix" | "solana";

/** Opens the checkout of `slug` (license or guarantee) and waits for the signed-in step. */
export async function openCheckout(page: Page, slug: string, kind: "license" | "guarantee" = "license"): Promise<void> {
  await page.goto(`/en/checkout?agent=${encodeURIComponent(slug)}&type=${kind}`);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Picks the payment method (its option button). */
export async function choosePayment(page: Page, method: PayMethod, symbol: string): Promise<void> {
  const name = method === "wallet" ? `${symbol} balance` : method === "pix" ? /^Pix/ : "USDC on Solana";
  const opt = page.locator("button.opt").filter({ has: page.locator("b", { hasText: name }) });
  await opt.click();
  await expect(opt).toHaveAttribute("aria-pressed", "true");
}

/** Ticks the agreement checkbox. */
export async function agree(page: Page): Promise<void> {
  const box = page.getByRole("checkbox");
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
}

/** The main pay button of the review step ("Pay $19.00", "Generate a Pix for …", "Generate the payment QR code (…)"). */
export const payButton = (page: Page) => page.getByRole("button", { name: /^(Pay |Generate a Pix for |Generate the payment QR code)/ });

export type Done = { chargeId: string; txHash: Hex };

/**
 * The done page: waits for "Payment confirmed"/"Payment held" (the page re-reads the charge), then reads the charge id
 * from the URL and the transaction hash from the technical details (what a person would copy), never from the API.
 */
export async function readDone(page: Page, kind: "license" | "escrow" = "license"): Promise<Done> {
  await page.waitForURL(/\/checkout\/done\?/, { timeout: 180_000 });
  // The done page re-reads the charge for ~30 s, then shows "Check again": a slow indexer is retried like a person would.
  const confirmed = page.getByText(kind === "escrow" ? "Payment held" : "Payment confirmed", { exact: true });
  const recheck = page.getByRole("button", { name: "Check again" });
  const until = Date.now() + 150_000;
  while (!(await confirmed.isVisible())) {
    if (Date.now() > until) throw new Error(`the done page never confirmed the purchase (${page.url()})`);
    if (await recheck.isVisible()) await recheck.click();
    await page.waitForTimeout(1000);
  }
  const chargeId = new URL(page.url()).searchParams.get("charge");
  expect(chargeId, "charge id in the done URL").toBeTruthy();
  await page.getByRole("button", { name: kind === "escrow" ? "View the task's technical details" : "View the license's technical details" }).click();
  const hash = (await page.locator("#tech-details dd.mono").first().textContent())?.trim() ?? "";
  expect(hash, "transaction hash in the technical details").toMatch(/^0x[0-9a-f]{64}$/i);
  return { chargeId: chargeId!, txHash: hash.toLowerCase() as Hex };
}

/** Balance of the payment token at a block (historical read: robust to the other tests running in parallel). */
export async function balanceAt(who: string, blockNumber: bigint): Promise<bigint> {
  const n = await network();
  return n.publicClient.readContract({ address: n.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [who as Address], blockNumber });
}

/** Balance change of each address caused by the block of `receipt` (block N vs N-1). */
export async function blockDeltas<K extends string>(receipt: TransactionReceipt, who: Record<K, string>): Promise<Record<K, bigint>> {
  // Balance at block N minus N-1, minus what the OTHER transactions of the block moved for the same address (none on
  // anvil's automine; Moderato blocks can carry other people's payments, read with one getLogs for the block). The
  // result is what this transaction changed, measured from balances, and it must agree with its own Transfer logs.
  const n = await network();
  const logs = await n.publicClient.getLogs({ address: n.deployment.token, event: TRANSFER_EVENT, blockHash: receipt.blockHash });
  const otherMoves: [string, string, bigint][] = logs
    .filter((l) => lower(l.transactionHash ?? "") !== lower(receipt.transactionHash))
    .map((l) => [lower(l.args.from!), lower(l.args.to!), l.args.value!]);
  const own = await tokenTransfers(receipt);
  const net = (moves: [string, string, bigint][], a: string) => moves.reduce((acc, [f, t, v]) => acc + (t === a ? v : 0n) - (f === a ? v : 0n), 0n);
  const out = {} as Record<K, bigint>;
  for (const [k, raw] of Object.entries(who) as [K, string][]) {
    const a = lower(raw);
    const delta = (await balanceAt(a, receipt.blockNumber)) - (await balanceAt(a, receipt.blockNumber - 1n)) - net(otherMoves, a);
    expect(delta, `${k}: balance delta of block ${receipt.blockNumber} (net of the block's other transfers) = this tx's Transfer logs`).toBe(net(own, a));
    out[k] = delta;
  }
  return out;
}

const TRANSFER_EVENT = erc20Abi.find((x) => x.type === "event" && x.name === "Transfer") as Extract<(typeof erc20Abi)[number], { type: "event"; name: "Transfer" }>;

/** Token transfers of a receipt (payment token only), as [from, to, value]. */
export async function tokenTransfers(receipt: TransactionReceipt): Promise<[string, string, bigint][]> {
  const n = await network();
  return parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })
    .filter((l) => lower(l.address) === lower(n.deployment.token))
    .map((l) => [lower(l.args.from), lower(l.args.to), l.args.value]);
}

export type LicensePurchase = { tokenId: bigint; payer: string; price: bigint; fee: bigint; creatorAmount: bigint; receipt: TransactionReceipt };

/**
 * Every on-chain fact of a license purchase: receipt success, exactly one LicensePurchased (agent, buyer, payer, price,
 * purchase id when given), the fee split (fee = floor(price * feeBps / 10 000), creator gets the rest, nothing deferred),
 * the token movements of the transaction (payer -> license contract -> creator and treasury), the balance deltas of the
 * block for creator and treasury, and ownerOf(tokenId) = buyer.
 */
export async function verifyLicensePurchase(
  ev: Evidence,
  o: { txHash: Hex; agentIdHex: Hex; buyer: string; payer: string; price: bigint; creator: string; label: string; chargeId: string },
): Promise<LicensePurchase> {
  const receipt = await receiptOf(o.txHash);
  expect(receipt.status, "receipt status").toBe("success");
  await ev.tempo(o.label, o.txHash);
  const events = await eventArgs<{ purchaseId: Hex; agentId: Hex; buyer: string; tokenId: bigint; payer: string; price: bigint; fee: bigint; creatorAmount: bigint; creatorDeferred: boolean; treasuryDeferred: boolean }>(receipt, "LicensePurchased");
  expect(events.length, "LicensePurchased events").toBe(1);
  const e = events[0]!;
  const cfg = await registryConfig();
  const fee = (o.price * BigInt(cfg.feeBps)) / 10_000n;
  expect([lower(e.agentId), lower(e.buyer), lower(e.payer), e.price], "LicensePurchased(agent, buyer, payer, price)").toEqual([lower(o.agentIdHex), lower(o.buyer), lower(o.payer), o.price]);
  // The purchase id binds the transaction to THIS charge (keccak256("solvers:v1:" + chargeId)), not to another one of the buyer.
  expect(lower(e.purchaseId), `purchase id = purchaseIdFor(${o.chargeId})`).toBe(lower(purchaseIdFor(o.chargeId)));
  expect([e.fee, e.creatorAmount, e.creatorDeferred, e.treasuryDeferred], "fee split (floor) and no deferred payout").toEqual([fee, o.price - fee, false, false]);

  // The license contract pulls the split straight from the payer: payer -> treasury (fee) and payer -> creator (rest).
  // Nothing else leaves the payer (the network fee is the fee payer's) and nothing stays in the license contract.
  const n = await network();
  const moves = await tokenTransfers(receipt);
  const fromPayer = moves.filter(([from]) => from === lower(o.payer));
  expect(fromPayer.sort(), "token movements from the payer").toEqual(
    ([[lower(o.payer), lower(cfg.treasury), fee], [lower(o.payer), lower(o.creator), o.price - fee]] as [string, string, bigint][]).sort(),
  );
  expect(moves.filter(([, to]) => to === lower(n.deployment.license)), "nothing paid into the license contract").toEqual([]);

  const d = await blockDeltas(receipt, { creator: o.creator, treasury: cfg.treasury });
  expect(d, "balance deltas of the block (creator +price-fee, treasury +fee)").toEqual({ creator: o.price - fee, treasury: fee });
  expect(await ownerOf(e.tokenId), "ownerOf(tokenId)").toBe(lower(o.buyer));
  ev.checked(
    `${o.label}: receipt success, LicensePurchased(buyer ${o.buyer}, payer ${o.payer}, price ${o.price}), fee ${fee} (${cfg.feeBps} bps) to treasury, ${o.price - fee} to creator (balance deltas of block ${receipt.blockNumber}), ownerOf(#${e.tokenId}) = buyer`,
  );
  return { tokenId: e.tokenId, payer: lower(e.payer), price: e.price, fee, creatorAmount: e.creatorAmount, receipt };
}

/** The license appears in "My library" (page) and in /api/me/licenses (the session of the page). */
export async function expectInLibrary(page: Page, ev: Evidence, o: { name: string; tokenId: bigint }): Promise<void> {
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/me/licenses");
      return res.ok() ? ((await res.json()) as { id: string }[]).map((l) => l.id) : [];
    }, { timeout: 60_000, message: "license in /api/me/licenses" })
    .toContain(o.tokenId.toString());
  await page.goto("/en/library");
  await expect(page.locator("article h2", { hasText: o.name })).toBeVisible({ timeout: 60_000 });
  ev.checked(`license #${o.tokenId} listed in /api/me/licenses and shown in My library ("${o.name}")`);
}

/** Fee payer of a sponsored transaction: never the buyer; the RELAY key when it is known (local stack). */
export function expectSponsored(receipt: TransactionReceipt, buyer: string, relay: string | null): string {
  const fp = feePayerOf(receipt);
  expect(fp, "fee payer recorded").toMatch(/^0x[0-9a-f]{40}$/);
  expect(fp, "fee not paid by the buyer / sender").not.toBe(lower(buyer));
  if (relay) expect(fp, "fee payer = RELAY").toBe(relay);
  return fp;
}


/**
 * The hash of the next transaction the page sends and confirms: every wallet action of the web app ends with
 * POST /api/tx/confirm { txHash } (lib/tx.ts). Start waiting BEFORE the click that sends it.
 */
export function nextConfirmedTx(page: Page): Promise<Hex> {
  return page
    .waitForResponse((r) => r.url().endsWith("/api/tx/confirm") && r.request().method() === "POST" && (r.status() === 200 || r.status() === 429), { timeout: 180_000 })
    .then(async (r) => {
      // The API's costly-route limit is per IP and every test browser shares 127.0.0.1: say so instead of timing out.
      if (r.status() === 429) throw new Error("/api/tx/confirm answered 429 (rate limit of the costly routes, 20/min per IP): run with fewer workers");
      const body = (await r.json()) as { status?: string; txHash?: string };
      if (body.status !== "confirmed") throw new Error(`/api/tx/confirm answered ${JSON.stringify(body)}`);
      return String((r.request().postDataJSON() as { txHash: string }).txHash).toLowerCase() as Hex;
    });
}
