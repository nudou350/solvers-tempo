// Mode B (public testnet site, the owner's account; plan §3): buy a Solver the account does not own with the wallet
// balance, and another one with Pix (simulated), each verified on chain; then RESELL each license to a throwaway address
// from "My library" (royalty verified), so the account ends the run owning exactly the licenses it started with.
// Serial: one account, one license per Solver.
import { agentIdToBytes32 } from "@solvers/shared";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainAgent, get, getConfig, isPlatform, licenseCount, lower, ownerOf, receiptOf, tempoTxLink, tokenBalance } from "../../src/chain.js";
import { agree, choosePayment, expectSponsored, openCheckout, payButton, readDone, verifyLicensePurchase } from "../../src/checkout.js";
import { PROD_AUTH_FILE, PROD_WALLET } from "../../src/env.js";
import { expect, test, type Evidence } from "../../src/fixtures.js";
import { transferInLibrary, verifyTransfer } from "../../src/library.js";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

type Row = { id: string; slug: string; name: string; priceUsdc: number; platform: boolean };
type Pick = { slug: string; name: string; id: string; idHex: Hex; price: bigint; creator: string };

let startLicenses = 0n;
let startIds: string[] = [];
const picks: Pick[] = [];
const names = new Map<string, string>();
/** Test Solvers published by the scripts (all named "QA Creator Flow"): never bought in mode B. */
const TEST_SLUG = /^(e2e|qa)-/;

const myLicenses = async (r: { get: (u: string) => Promise<{ ok(): boolean; json(): Promise<unknown> }> }) => {
  const res = await r.get("/api/me/licenses");
  if (!res.ok()) throw new Error("/api/me/licenses refused the owner's session");
  return (await res.json()) as { id: string; agentId: string }[];
};

test.beforeAll(async ({ browser }) => {
  startLicenses = await licenseCount(PROD_WALLET);
  // Paid, active, not sold out, not owned by the account, cheapest first.
  const ctx = await browser.newContext({ storageState: test.info().project.use.storageState as string });
  try {
    startIds = (await myLicenses(ctx.request)).map((l) => l.id).sort();
    const all = await get<Row[]>("/api/agents");
    for (const a of all) names.set(a.id, a.name);
    const rows = all.filter((a) => !a.platform && a.priceUsdc > 0 && !TEST_SLUG.test(a.slug)).sort((a, b) => a.priceUsdc - b.priceUsdc);
    for (const a of rows) {
      const c = await chainAgent(a.id);
      if (c.status !== 1 || (c.maxSupply !== 0 && c.totalSales >= c.maxSupply)) continue;
      // The owner cannot buy a Solver it created (creator_cannot_buy / SelfPurchase).
      if (lower(c.creator) === PROD_WALLET) continue;
      const res = await ctx.request.get(`/api/me/access/${a.slug}`);
      if (!res.ok()) throw new Error(`/api/me/access/${a.slug} answered ${res.status()}: the saved session is not valid`);
      if (((await res.json()) as { license: unknown }).license) continue;
      picks.push({ slug: a.slug, name: a.name, id: a.id, idHex: agentIdToBytes32(a.id) as Hex, price: c.price, creator: lower(c.creator) });
      if (picks.length === 2) break;
    }
  } finally {
    await ctx.close();
  }
  if (picks.length < 2) throw new Error(`the account ${PROD_WALLET} already owns every purchasable paid Solver but ${picks.length}: nothing left to buy in mode B`);
});

/** Resells the license just bought to a throwaway address and checks the account lost it. */
async function resell(page: Page, ev: Evidence, s: Pick, tokenId: bigint) {
  const heir = privateKeyToAccount(generatePrivateKey()).address;
  const before = await tokenBalance(PROD_WALLET);
  const hash = await transferInLibrary(page, { name: s.name, to: heir, tokenId });
  const { total } = await verifyTransfer(ev, { hash, tokenId, from: PROD_WALLET, to: heir, agentId: s.id, relay: null, label: `resale of ${s.slug} to a throwaway address (transferWithRoyalty)` });
  expect(before - (await tokenBalance(PROD_WALLET)), "the account paid exactly the royalty").toBe(total);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/me/access/${s.slug}`)).json()) as { license: unknown }).license, { timeout: 60_000, message: "access after the resale" })
    .toBeNull();
  ev.checked(`resold #${tokenId} to throwaway ${heir}; the account paid the royalty ${total} and no longer has access to ${s.slug}`);
}

test("mode B scenarios 3 + 6: buy with the wallet balance, then resell the license", async ({ page, evidence }) => {
  test.setTimeout(480_000);
  const s = picks[0]!;
  const cfg = await getConfig();
  expect(await tokenBalance(PROD_WALLET) >= s.price, "the owner wallet holds the price (prepared from the faucet)").toBe(true);
  await openCheckout(page, s.slug);
  await choosePayment(page, "wallet", cfg.paymentToken.symbol);
  await agree(page);
  const before = await tokenBalance(PROD_WALLET);
  await payButton(page).click();
  const done = await readDone(page);
  const link = await page.locator("#tech-details a[href*='/tx/']").getAttribute("href");
  expect(link, "the done page links the transaction on the Tempo testnet explorer").toBe(await tempoTxLink(done.txHash));
  const p = await verifyLicensePurchase(evidence, { txHash: done.txHash, agentIdHex: s.idHex, buyer: PROD_WALLET, payer: PROD_WALLET, price: s.price, creator: s.creator, label: `purchaseLicense of ${s.slug} (wallet balance)`, chargeId: done.chargeId });
  expectSponsored(p.receipt, PROD_WALLET, null);
  expect(before - (await tokenBalance(PROD_WALLET)), "the account paid exactly the price").toBe(s.price);
  evidence.checked(`fee sponsored (fee payer is not the buyer); the account paid exactly ${s.price}`);
  await resell(page, evidence, s, p.tokenId);
});

test("mode B scenarios 4 + 6: buy with Pix (simulated), then resell the license", async ({ page, evidence }) => {
  test.setTimeout(480_000);
  const s = picks[1]!;
  const cfg = await getConfig();
  expect(cfg.pix.simulate, "Pix is simulated on the testnet site").toBe(true);
  await openCheckout(page, s.slug);
  await choosePayment(page, "pix", cfg.paymentToken.symbol);
  await agree(page);
  const before = await tokenBalance(PROD_WALLET);
  await payButton(page).click();
  await page.getByRole("button", { name: "Simulate payment (test)" }).click();
  const done = await readDone(page);
  const sender = lower((await receiptOf(done.txHash)).from);
  expect(await isPlatform(sender), "fulfilment sent by a PLATFORM_ROLE key").toBe(true);
  const p = await verifyLicensePurchase(evidence, { txHash: done.txHash, agentIdHex: s.idHex, buyer: PROD_WALLET, payer: sender, price: s.price, creator: s.creator, label: `purchaseLicenseFor of ${s.slug} (Pix, PLATFORM float)`, chargeId: done.chargeId });
  expectSponsored(p.receipt, sender, null);
  expect(await tokenBalance(PROD_WALLET), "the account spent no stablecoin on the Pix purchase").toBe(before);
  evidence.checked(`sent by ${sender} (PLATFORM_ROLE on chain), fee sponsored, the account's balance unchanged`);
  await resell(page, evidence, s, p.tokenId);
});

test.afterAll(async ({ browser }) => {
  // Whatever failed above, the account must end as it started: any license it gained in this run is resold to a
  // throwaway address here (and checked), then the set of licenses is compared with the start.
  const ctx = await browser.newContext({ storageState: PROD_AUTH_FILE });
  try {
    const page = await ctx.newPage();
    const extra = (await myLicenses(page.request)).filter((l) => !startIds.includes(l.id));
    for (const l of extra) {
      if ((await ownerOf(BigInt(l.id))) !== PROD_WALLET) continue;
      const heir = privateKeyToAccount(generatePrivateKey()).address;
      const name = names.get(l.agentId) ?? "";
      console.log(`[e2e-browser] cleanup: reselling license #${l.id} (${name}) left by a failed test`);
      const hash = await transferInLibrary(page, { name, to: heir, tokenId: BigInt(l.id) });
      expect(await ownerOf(BigInt(l.id)), `cleanup transfer ${hash}`).toBe(lower(heir));
    }
    await expect
      .poll(async () => (await myLicenses(page.request)).map((l) => l.id).sort(), { timeout: 60_000, message: "the account's licenses after the run" })
      .toEqual(startIds);
  } finally {
    await ctx.close();
  }
  expect(await licenseCount(PROD_WALLET), "licenses held by the account on chain after the run").toBe(startLicenses);
});
