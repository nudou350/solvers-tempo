// Scenario 2 (mode A): sign in with the dev wallet -> account menu -> test funds -> sign out. The session cookie is
// checked on /api/auth/me, the faucet transfer on-chain (receipt, sender PLATFORM, balance delta).
import { erc20Abi, parseEventLogs } from "viem";
import { isPlatform, lower, network, receiptOf, tokenBalance } from "../../src/chain.js";
import { accountButton, expect, signInWithDevWallet, test } from "../../src/fixtures.js";
import { token } from "../../src/money.js";

test("scenario 2: dev wallet sign-in, account menu, test funds and sign-out", async ({ page, devWallet, evidence }) => {
  // Signed out: /api/auth/me refuses.
  await page.goto("/en");
  expect((await page.request.get("/api/auth/me")).status(), "/api/auth/me before sign-in").toBe(401);

  await signInWithDevWallet(page);
  const me = await page.request.get("/api/auth/me");
  expect(me.status(), "/api/auth/me after sign-in").toBe(200);
  expect(lower(((await me.json()) as { wallet: string }).wallet), "session wallet = the injected dev wallet").toBe(devWallet.lower);
  evidence.checked(`session cookie valid: /api/auth/me = ${devWallet.address}`);

  // Account menu: test wallet, its short address, profile and library links.
  await accountButton(page).click();
  const menu = page.locator("#account-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Test wallet", { exact: true })).toBeVisible();
  await expect(menu.getByText(`${devWallet.lower.slice(0, 6)}…${devWallet.lower.slice(-4)}`, { exact: false })).toBeVisible();
  await expect(menu.getByRole("link", { name: "My library" })).toBeVisible();

  // Test funds from the menu: the transfer is on-chain, from the PLATFORM float, to this wallet.
  const before = await tokenBalance(devWallet.address);
  const faucetRes = page.waitForResponse((r) => r.url().endsWith("/api/faucet") && r.request().method() === "POST");
  await menu.getByTestId("faucet").click();
  const res = await faucetRes;
  expect(res.status(), `/api/faucet answered ${res.status()}: ${await res.text()}`).toBe(200);
  const { txHash, amountUnits } = (await res.json()) as { txHash: string; amountUnits: string };
  const receipt = await receiptOf(txHash);
  expect(receipt.status).toBe("success");
  expect(await isPlatform(receipt.from), "faucet sender holds PLATFORM_ROLE").toBe(true);
  const n = await network();
  // The receipt also carries the network fee (paid by the server in the same token); only the transfer to the wallet counts.
  const toWallet = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter((l) => lower(l.address) === lower(n.deployment.token) && lower(l.args.to) === devWallet.lower);
  expect(toWallet.map((t) => [lower(t.args.from), t.args.value]), "token Transfer to the wallet").toEqual([[lower(receipt.from), BigInt(amountUnits)]]);
  expect((await tokenBalance(devWallet.address)) - before, "balance delta").toBe(BigInt(amountUnits));
  await evidence.tempo("faucet transfer (PLATFORM -> dev wallet)", txHash);
  evidence.checked(`faucet: receipt success, sender has PLATFORM_ROLE, Transfer ${amountUnits} to the wallet, balance +${amountUnits}`);

  // The toast confirms it and the open menu re-reads the balance: it shows the on-chain balance.
  await expect(page.getByText(/You received .* in test funds/)).toBeVisible();
  const shown = menu.getByTestId("balance");
  await expect(shown).toHaveText(/^Balance: [\d,.]+ USD$/);
  const after = await tokenBalance(devWallet.address);
  await expect(shown).toHaveText(`Balance: ${token(after, "USD", "en")}`);

  // Sign out: the header offers "Sign in" again and the cookie no longer opens a session.
  if (!(await menu.isVisible())) await accountButton(page).click();
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("button", { name: "Sign in" })).toBeVisible();
  expect((await page.request.get("/api/auth/me")).status(), "/api/auth/me after sign-out").toBe(401);
  evidence.checked("after sign-out /api/auth/me = 401");
});
