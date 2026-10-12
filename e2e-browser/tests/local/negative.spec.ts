// Scenario 11 (mode A): negative paths. A sold-out and a suspended Solver block the checkout without charging anything;
// expired Pix and Solana charges offer "create a new one"; a second wallet cannot see someone else's charge.
// Charges are expired by moving their expiry back in the disposable QA database (waiting 30 minutes is not an option);
// everything else is the app's own behaviour.
import { getConfig, chainAgent, licenseCount } from "../../src/chain.js";
import { agree, choosePayment, openCheckout, payButton } from "../../src/checkout.js";
import { expect, injectDevWallet, signInWithDevWallet, test } from "../../src/fixtures.js";
import { qaFixtures } from "../../src/prepare.js";
import { qaSql } from "../../src/stack.js";

/** Moves a charge's expiry `seconds` into the past (QA database only; the id is checked before it reaches SQL). */
function expireCharge(chargeId: string, seconds: number): void {
  if (!/^(pix|sol)_[0-9a-f]{24}$/.test(chargeId)) throw new Error(`unexpected charge id ${chargeId}`);
  const iso = new Date(Date.now() - seconds * 1000).toISOString();
  const out = qaSql(`update payment_ledger set provider_payload = jsonb_set(provider_payload, '{expiresAt}', '"${iso}"') where id = '${chargeId}' and status = 'pending_payment' returning id`);
  expect(out, `charge ${chargeId} moved to the past`).toContain(chargeId);
}

/** Charges recorded for a buyer in the QA ledger (the wallet is checked before it reaches SQL). */
function ledgerRows(wallet: string): number {
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error(`unexpected wallet ${wallet}`);
  return Number(qaSql(`select count(*) from payment_ledger where buyer_wallet = '${wallet}'`));
}

/** The server's charge lifetime is 30 minutes (PIX_TTL_MS, SOLANA_PAY_TTL_MIN default): checked before expiring it. */
function expectTtl(expiresAt: string, what: string) {
  const left = Date.parse(expiresAt) - Date.now();
  expect(left > 29 * 60_000 && left <= 30 * 60_000 + 5_000, `${what}: expires in ${Math.round(left / 1000)} s, expected ~30 min`).toBe(true);
}

/** The id of the charge the page creates next (from the API answer the page receives). */
const nextCharge = (page: import("@playwright/test").Page, path: string) =>
  page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === "POST").then(async (r) => {
    expect(r.status(), `${path} answered ${r.status()}`).toBe(200);
    return ((await r.json()) as { id: string }).id;
  });

test("scenario 11a: a sold-out Solver blocks the checkout and nothing is charged", async ({ page, devWallet, evidence }) => {
  const { soldOut } = qaFixtures();
  const before = await chainAgent(soldOut.id);
  expect(before.maxSupply > 0 && before.totalSales >= before.maxSupply, "sold out on chain").toBe(true);

  await page.goto(`/en/solvers/${soldOut.slug}`);
  await expect(page.getByText("Sold out", { exact: true }).first()).toBeVisible();
  await signInWithDevWallet(page);
  await openCheckout(page, soldOut.slug);
  await expect(page.getByText("No licenses left", { exact: true })).toBeVisible();
  await choosePayment(page, "pix", (await getConfig()).paymentToken.symbol);
  await agree(page);
  await expect(payButton(page), "pay stays disabled").toBeDisabled();

  const after = await chainAgent(soldOut.id);
  expect([after.totalSales, after.maxSupply], "no sale happened").toEqual([before.totalSales, before.maxSupply]);
  expect(await licenseCount(devWallet.address), "no license for the buyer").toBe(0n);
  const pix = await page.request.post("/api/pix/charges", { data: { kind: "license", agentId: soldOut.id } });
  expect([pix.status(), ((await pix.json()) as { code: string }).code], "the API refuses a charge too").toEqual([409, "sold_out"]);
  expect(ledgerRows(devWallet.lower), "no charge recorded for the buyer").toBe(0);
  evidence.checked(`sold out (cap ${after.maxSupply} = sales ${after.totalSales} on chain): "No licenses left", pay disabled, API 409 sold_out, no sale, no license`);
});

test("scenario 11b: a suspended Solver cannot be bought (not listed, checkout refuses, nothing charged)", async ({ page, devWallet, evidence }) => {
  const { suspended } = qaFixtures();
  const before = await chainAgent(suspended.id);
  expect(before.status, "Suspended on chain").toBe(2);
  const list = (await (await page.request.get("/api/agents")).json()) as { slug: string }[];
  expect(list.map((a) => a.slug), "not in the catalog list").not.toContain(suspended.slug);

  await signInWithDevWallet(page);
  await openCheckout(page, suspended.slug);
  await choosePayment(page, "pix", (await getConfig()).paymentToken.symbol);
  await agree(page);
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/pix/charges") && r.request().method() === "POST");
  await payButton(page).click();
  const res = await refused;
  expect([res.status(), ((await res.json()) as { code: string }).code], "charge refused").toEqual([409, "agent_unavailable"]);
  await expect(page.getByText("This solver isn't for sale right now", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Pix QR code" })).toHaveCount(0);
  expect((await chainAgent(suspended.id)).totalSales, "no sale").toBe(before.totalSales);
  expect(ledgerRows(devWallet.lower), "no charge recorded for the buyer").toBe(0);
  evidence.checked(`suspended (status 2 on chain): not listed, Pix charge refused 409 agent_unavailable, "isn't for sale" shown, no sale, no ledger row`);
});

test("scenario 11c: an expired Pix charge offers a new one", async ({ page, devWallet, evidence }) => {
  await signInWithDevWallet(page);
  await openCheckout(page, "ui-design");
  await choosePayment(page, "pix", (await getConfig()).paymentToken.symbol);
  await agree(page);
  const created = nextCharge(page, "/api/pix/charges");
  await payButton(page).click();
  const id = await created;
  await expect(page.getByRole("button", { name: "Simulate payment (test)" })).toBeVisible();
  expectTtl(((await (await page.request.get(`/api/pix/charges/${id}`)).json()) as { expiresAt: string }).expiresAt, `Pix ${id}`);

  // Just past the deadline, as a person waiting on the page would see it: the panel keeps checking for 2 minutes after
  // the deadline (PIX_GRACE_MS) and the 30 s reconcile job expires the simulated Pix on the server meanwhile.
  expireCharge(id, 30);
  // "time limit has ended" (local clock) usually shows first; if the 30 s job was faster, "expired" comes directly.
  await expect(page.getByText("This Pix's time limit has ended", { exact: true }).or(page.getByText("This Pix expired", { exact: true }))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This Pix expired", { exact: true })).toBeVisible({ timeout: 120_000 });
  const view = (await (await page.request.get(`/api/pix/charges/${id}`)).json()) as { status: string; txHash: string | null };
  expect([view.status, view.txHash], "charge expired, nothing sent").toEqual(["expired", null]);
  // An expired Pix can no longer be paid.
  const late = await page.request.post(`/api/pix/charges/${id}/simulate`);
  expect([late.status(), ((await late.json()) as { code: string }).code], "simulated payment after expiry").toEqual([400, "pix_expired"]);
  expect(await licenseCount(devWallet.address), "no license from the expired Pix").toBe(0n);
  await page.getByRole("button", { name: "Generate another Pix" }).click();
  await expect(payButton(page)).toBeVisible();
  evidence.checked(`Pix ${id}: created with a 30 min lifetime; expired on the server (status expired, no tx), paying it afterwards is refused (pix_expired), the page offers "Generate another Pix" and returns to the payment step`);
});

test("scenario 11d: an expired Solana charge offers a new one; another wallet cannot see it", async ({ page, browser, evidence }) => {
  const { cheap } = qaFixtures();
  await signInWithDevWallet(page);
  await openCheckout(page, cheap.slug);
  await choosePayment(page, "solana", (await getConfig()).paymentToken.symbol);
  await agree(page);
  const created = nextCharge(page, "/api/solana-pay/charges");
  await payButton(page).click();
  const id = await created;
  await expect(page.getByRole("link", { name: "Open in wallet" })).toBeVisible();
  // Control: the owner reads both routes (so the stranger's 404 below is about ownership, not a wrong path).
  const mine = await page.request.get(`/api/solana-pay/charges/${id}`);
  expect(mine.status(), "owner GET solana charge").toBe(200);
  expectTtl(((await mine.json()) as { expiresAt: string }).expiresAt, `Solana ${id}`);
  expect((await page.request.get(`/api/purchases/${id}`)).status(), "owner GET purchase").toBe(200);

  // Another signed-in wallet cannot read the charge, nor see it on the done page.
  const other = await browser.newContext();
  try {
    const stranger = await injectDevWallet(other);
    const p2 = await other.newPage();
    await signInWithDevWallet(p2);
    expect((await p2.request.get(`/api/solana-pay/charges/${id}`)).status(), "stranger GET solana charge").toBe(404);
    expect((await p2.request.get(`/api/purchases/${id}`)).status(), "stranger GET purchase").toBe(404);
    await p2.goto(`/en/checkout/done?agent=${cheap.slug}&kind=license&charge=${id}`);
    await expect(p2.getByText("We can't find this purchase in your account yet", { exact: true })).toBeVisible({ timeout: 90_000 });
    evidence.checked(`stranger ${stranger.address}: 404 on /api/solana-pay/charges/${id} and /api/purchases/${id}; the done page shows "can't find this purchase"`);
  } finally {
    await other.close();
  }

  // Past the deadline and the server's 5-minute grace for late Solana payments (the panel keeps checking that long too),
  // the server reports it expired: no payment was made.
  expireCharge(id, 6 * 60);
  await expect(page.getByText("This payment request expired", { exact: true })).toBeVisible({ timeout: 120_000 });
  const view = (await (await page.request.get(`/api/solana-pay/charges/${id}`)).json()) as { status: string; solanaSignature: string | null; txHash: string | null };
  expect([view.status, view.solanaSignature, view.txHash], "charge expired, nothing paid or sent").toEqual(["expired", null, null]);
  await page.getByRole("button", { name: "Create a new payment request" }).click();
  await expect(payButton(page)).toBeVisible();
  evidence.checked(`Solana ${id}: expired on the server (no signature, no tx), the page offers "Create a new payment request"`);
});
