// Mode B login (plan §3): the owner's Privy account. A saved session (.auth/prod.json, gitignored, never printed) is
// reused while the site still accepts it. Otherwise this opens a VISIBLE browser, types the owner's e-mail and waits for
// the OWNER to type the e-mail code in that window (nobody reads the mailbox; the code is never stored), then saves the
// session for the next runs.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import { PROD_AUTH_FILE, PROD_EMAIL, PROD_WALLET, WEB_URL } from "../../src/env.js";
import { accountButton, expect, test } from "../../src/fixtures.js";

/** True when the saved session still opens /api/auth/me as the owner's wallet. */
async function savedSessionWorks(): Promise<boolean> {
  if (!existsSync(PROD_AUTH_FILE)) return false;
  const ctx = await request.newContext({ baseURL: WEB_URL, storageState: PROD_AUTH_FILE });
  try {
    const r = await ctx.get("/api/auth/me");
    return r.ok() && ((await r.json()) as { wallet: string }).wallet.toLowerCase() === PROD_WALLET;
  } finally {
    await ctx.dispose();
  }
}

test("mode B login: the owner's Privy session (saved, or typed by the owner now)", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  if (await savedSessionWorks()) {
    test.info().annotations.push({ type: "checked", description: "saved Privy session still valid: /api/auth/me = the owner's wallet" });
    return;
  }
  await page.goto("/en");
  await page.bringToFront();
  // "Sign in" may be clicked before the Privy SDK is ready (the click then does nothing): retried until the modal's
  // e-mail field shows up. Privy's modal container reports as hidden while it animates: its field is targeted directly.
  const signIn = page.getByRole("banner").getByRole("button", { name: "Sign in" });
  const email = page.locator("#privy-dialog").getByPlaceholder("your@email.com");
  await expect(async () => {
    if (!(await email.isVisible())) await signIn.click({ timeout: 5_000 });
    await expect(email).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await email.fill(PROD_EMAIL);
  await page.locator("#privy-dialog").getByRole("button", { name: "Submit" }).click();
  console.log(`\n[e2e-browser] >>> OWNER: type the e-mail code sent to ${PROD_EMAIL} in the open browser window (waiting up to 15 minutes) <<<\n`);
  await expect(accountButton(page)).toBeVisible({ timeout: 15 * 60_000 });
  const me = await page.request.get("/api/auth/me");
  expect(me.status(), "/api/auth/me after the Privy login").toBe(200);
  expect(((await me.json()) as { wallet: string }).wallet.toLowerCase(), "the owner's wallet").toBe(PROD_WALLET);
  mkdirSync(dirname(PROD_AUTH_FILE), { recursive: true });
  // Privy keeps part of its session in IndexedDB.
  await page.context().storageState({ path: PROD_AUTH_FILE, indexedDB: true });
  test.info().annotations.push({ type: "checked", description: "new Privy session saved to .auth/prod.json" });
});
