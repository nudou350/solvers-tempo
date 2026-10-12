// Mode B, scenarios 2 and 10 (read only): the owner's saved Privy session opens the site as the owner's wallet, the
// account menu shows it, and the admin review queue opens (the wallet is in ADMIN_WALLETS). No sign-out: it would end
// the saved session.
import { PROD_EMAIL, PROD_WALLET } from "../../src/env.js";
import { accountButton, expect, test } from "../../src/fixtures.js";

test("mode B scenario 2: the owner's session, account menu and wallet", async ({ page, evidence }) => {
  await page.goto("/en");
  await expect(accountButton(page)).toBeVisible({ timeout: 60_000 });
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { wallet: string }).wallet.toLowerCase(), "session wallet").toBe(PROD_WALLET);
  await accountButton(page).click();
  const menu = page.locator("#account-menu");
  await expect(menu.getByText(`${PROD_WALLET.slice(0, 6)}…${PROD_WALLET.slice(-4)}`, { exact: false })).toBeVisible();
  await expect(menu.getByText(PROD_EMAIL, { exact: false })).toBeVisible();
  await expect(menu.getByRole("link", { name: "My library" })).toBeVisible();
  evidence.checked(`/api/auth/me = ${PROD_WALLET}; the menu shows the e-mail and the wallet`);
});

test("mode B scenario 10: the admin review queue opens for the owner (ADMIN_WALLETS)", async ({ page, evidence }) => {
  await page.goto("/en/admin/reviews");
  await expect(page.getByRole("heading", { name: "Reviews", level: 1 })).toBeVisible({ timeout: 60_000 });
  expect((await page.request.get("/api/admin/submissions")).status(), "admin API").toBe(200);
  await page.goto("/en/creator");
  await expect(page.getByRole("main")).toBeVisible();
  evidence.checked("/admin/reviews shows the queue and /api/admin/submissions answers 200 for the owner; /creator opens");
});
