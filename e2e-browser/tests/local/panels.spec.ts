// Scenario 10 (mode A): the creator panel for a creator and the admin review queue for an ADMIN_WALLETS wallet (read and
// navigate only: approving on the site signs nothing on-chain, the cold-key approval is cli:approve). The numbers on
// the creator panel are checked against the Registry; the admin area is refused to anyone else.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateKey } from "@solvers/chain";
import { readEnvFile } from "../../../scripts/src/env.js";
import { agentDetail, chainAgent } from "../../src/chain.js";
import { ENV_QA, REPO } from "../../src/env.js";
import { accountButton, expect, injectDevWallet, signInWithDevWallet, test } from "../../src/fixtures.js";
import { qaFixtures } from "../../src/prepare.js";

test("scenario 10a: the creator panel shows the creator's Solver with the on-chain sales count", async ({ browser, evidence }) => {
  const { cheap } = qaFixtures();
  const key = loadPrivateKey(readFileSync(join(REPO, "scripts", ".keys", "creators", `${cheap.slug}.key`), "utf8"), "creator key");
  const ctx = await browser.newContext();
  try {
    const creator = await injectDevWallet(ctx, key);
    const onchain = await chainAgent(cheap.id);
    expect(onchain.creator.toLowerCase(), "the key is the Solver's creator on chain").toBe(creator.lower);
    const name = (await agentDetail(cheap.slug)).agent.name;
    const page = await ctx.newPage();
    await signInWithDevWallet(page);
    await page.goto("/en/creator");
    // All-time sales from the panel's own API = the Registry; the 30-day number on screen = that API's 30-day number.
    const dash = (await (await page.request.get("/api/creator/dashboard")).json()) as { totals: { sales: number }; last30: { sales: number } };
    expect(dash.totals.sales, "dashboard all-time sales = Registry totalSales").toBe(onchain.totalSales);
    const sales = page.locator("span.small.muted", { hasText: "Sales in 30 days" }).locator("xpath=following-sibling::span[1]");
    await expect(sales).toHaveText(String(dash.last30.sales), { timeout: 60_000 });
    // Every test Solver is named "QA Creator Flow": the panel must link THIS one.
    await expect(page.locator(`a[href$="/solvers/${cheap.slug}"]`).first()).toBeVisible();
    // The Solver page tells the creator they cannot buy their own Solver (D12).
    await page.goto(`/en/solvers/${cheap.slug}`);
    await expect(page.getByText("This is your solver", { exact: true })).toBeVisible();
    evidence.checked(`creator ${creator.address}: panel links ${cheap.slug} ("${name}"); all-time sales ${dash.totals.sales} = Registry totalSales; 30-day sales on screen = API; own Solver page says "This is your solver"`);
  } finally {
    await ctx.close();
  }
});

test("scenario 10b: the admin review queue opens for an ADMIN_WALLETS wallet and is hidden from others", async ({ browser, page, devWallet, evidence }) => {
  const adminKey = loadPrivateKey(readEnvFile(ENV_QA).ADMIN_PRIVATE_KEY, "ADMIN_PRIVATE_KEY of .env.qa");
  const adminWallets = (readEnvFile(ENV_QA).ADMIN_WALLETS ?? "").toLowerCase().split(",");
  const ctx = await browser.newContext();
  try {
    const admin = await injectDevWallet(ctx, adminKey);
    expect(adminWallets, "the QA admin key is in ADMIN_WALLETS").toContain(admin.lower);
    const p = await ctx.newPage();
    await signInWithDevWallet(p);
    await p.goto("/en/admin/reviews");
    await expect(p.getByRole("heading", { name: "Reviews", level: 1 })).toBeVisible({ timeout: 60_000 });
    expect((await p.request.get("/api/admin/submissions")).status(), "admin API for the admin").toBe(200);
    evidence.checked(`admin ${admin.address} (ADMIN_WALLETS): /admin/reviews shows the queue, /api/admin/submissions 200`);
  } finally {
    await ctx.close();
  }

  // Anyone else: "Page not found" and 403 from the API.
  await signInWithDevWallet(page);
  await expect(accountButton(page)).toBeVisible();
  await page.goto("/en/admin/reviews");
  await expect(page.getByText("Page not found", { exact: true })).toBeVisible({ timeout: 60_000 });
  expect((await page.request.get("/api/admin/submissions")).status(), "admin API for a buyer").toBe(403);
  evidence.checked(`buyer ${devWallet.address}: /admin/reviews says "Page not found", /api/admin/submissions 403`);
});
