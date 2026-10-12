// Scenarios 3, 4 and 5 (mode A): buy a license in the browser with the wallet balance, with Pix (simulated) and with
// USDC on Solana devnet. Each test has its own fresh wallet and its own Solver; every fact is checked on chain.
import { agentIdToBytes32 } from "@solvers/shared";
import type { Hex } from "viem";
import { agentDetail, chainAgent, fund, getConfig, isPlatform, lower, relayAddress, serverPlatform, tokenBalance } from "../../src/chain.js";
import { agree, choosePayment, expectInLibrary, expectSponsored, openCheckout, payButton, readDone, verifyLicensePurchase } from "../../src/checkout.js";
import { expect, signInWithDevWallet, test } from "../../src/fixtures.js";
import { qaFixtures } from "../../src/prepare.js";
import { decodeQrImage, loadPayer, parseSolanaPayUrl, payFromTestPayer, solBalance, solanaTxFacts, splBalance, toUnits } from "../../src/solana.js";

/** The Solver of a scenario, read from the API and the Registry (never from the page). */
async function solver(slug: string) {
  const d = await agentDetail(slug);
  const c = await chainAgent(d.agent.id);
  expect(c.status, `${slug} is active on chain`).toBe(1);
  return { slug, name: d.agent.name, id: d.agent.id, idHex: agentIdToBytes32(d.agent.id) as Hex, price: c.price, creator: lower(c.creator) };
}

test("scenario 3: buy with the wallet balance (sponsored batch, exact split)", async ({ page, devWallet, evidence }) => {
  const s = await solver("ui-design");
  const cfg = await getConfig();
  for (const h of await fund(devWallet.address, s.price)) await evidence.tempo("test funds for the buyer (anvil funder)", h);
  const before = await tokenBalance(devWallet.address);
  expect(before, "buyer holds exactly the price").toBe(s.price);

  await signInWithDevWallet(page);
  await openCheckout(page, s.slug);
  await choosePayment(page, "wallet", cfg.paymentToken.symbol);
  await expect(page.getByText(/Your balance:/)).toBeVisible();
  await agree(page);
  await expect(payButton(page)).toHaveText(`Pay $${(Number(s.price) / 1e6).toFixed(2)}`);
  await payButton(page).click();
  const done = await readDone(page);

  const p = await verifyLicensePurchase(evidence, { txHash: done.txHash, agentIdHex: s.idHex, buyer: devWallet.address, payer: devWallet.address, price: s.price, creator: s.creator, label: "purchaseLicense (wallet balance, sponsored)", chargeId: done.chargeId });
  const relay = relayAddress();
  const fp = expectSponsored(p.receipt, devWallet.address, relay);
  expect(await tokenBalance(devWallet.address), "buyer paid exactly the price, no network fee").toBe(0n);
  evidence.checked(`network fee paid by RELAY ${fp}, not the buyer; buyer balance ${before} -> 0 (exactly the price)`);
  await expectInLibrary(page, evidence, { name: s.name, tokenId: p.tokenId });
});

test("scenario 4: buy with Pix (simulated) completed by the PLATFORM float", async ({ page, devWallet, evidence }) => {
  const s = await solver("frontend-react");
  const cfg = await getConfig();
  expect(cfg.pix.simulate, "Pix is simulated on this network").toBe(true);
  expect(await tokenBalance(devWallet.address), "buyer starts with no stablecoin").toBe(0n);

  await signInWithDevWallet(page);
  await openCheckout(page, s.slug);
  await choosePayment(page, "pix", cfg.paymentToken.symbol);
  await agree(page);
  await expect(payButton(page)).toHaveText(/^Generate a Pix for /);
  await payButton(page).click();
  await expect(page.getByText("Waiting for payment", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Simulate payment (test)" }).click();
  const done = await readDone(page);
  expect(done.chargeId, "Pix charge id").toMatch(/^pix/);

  const platform = serverPlatform();
  const p = await verifyLicensePurchase(evidence, { txHash: done.txHash, agentIdHex: s.idHex, buyer: devWallet.address, payer: platform, price: s.price, creator: s.creator, label: "purchaseLicenseFor (Pix, PLATFORM float)", chargeId: done.chargeId });
  expect(lower(p.receipt.from), "sender = PLATFORM key").toBe(platform);
  expect(await isPlatform(p.receipt.from), "sender holds PLATFORM_ROLE").toBe(true);
  expect(await tokenBalance(devWallet.address), "buyer spent no stablecoin").toBe(0n);
  const fp = expectSponsored(p.receipt, platform, relayAddress());
  evidence.checked(`sent by PLATFORM ${platform} (PLATFORM_ROLE), network fee by RELAY ${fp}, buyer stablecoin balance 0 before and after`);
  await expectInLibrary(page, evidence, { name: s.name, tokenId: p.tokenId });
});

test("scenario 5: buy with USDC on Solana devnet (QR decoded and paid), fulfilled on Tempo", async ({ page, devWallet, evidence }) => {
  // Devnet confirmation (up to 90 s) + detection by the server + Tempo fulfilment.
  test.setTimeout(480_000);
  const { cheap } = qaFixtures();
  const s = await solver(cheap.slug);
  const cfg = await getConfig();
  const sp = cfg.solanaPay!;
  expect([sp.enabled, sp.cluster], "Solana Pay on devnet").toEqual([true, "devnet"]);
  const payer = await loadPayer();
  const usdc = await splBalance(payer.address, sp.mint as never);
  expect(usdc >= s.price, `test payer ${payer.address} holds ${usdc} USDC units, needs ${s.price} (https://faucet.circle.com, Solana Devnet)`).toBe(true);
  const sol = await solBalance(payer.address);
  expect(sol >= 10_000_000n, `test payer ${payer.address} holds ${sol} lamports, needs 0.01 SOL for fees (https://faucet.solana.com)`).toBe(true);

  await signInWithDevWallet(page);
  await openCheckout(page, s.slug);
  await choosePayment(page, "solana", cfg.paymentToken.symbol);
  await agree(page);
  await expect(payButton(page)).toHaveText(/^Generate the payment QR code \(5 USDC\)$/);
  await payButton(page).click();

  // The QR image and the "Open in wallet" link must carry the same transfer request.
  const qr = page.locator("img[alt^='QR code']");
  await expect(qr).toBeVisible();
  const link = page.getByRole("link", { name: "Open in wallet" });
  const href = (await link.getAttribute("href")) ?? "";
  const decoded = await decodeQrImage(qr);
  expect(decoded, "QR image = Open in wallet link").toBe(href);
  const req = parseSolanaPayUrl(href);
  expect([req.recipient, req.splToken], "recipient and mint = /api/config").toEqual([sp.recipient, sp.mint]);
  expect(toUnits(req.amount ?? "0", 6), "URL amount = on-chain price").toBe(s.price);
  expect(req.references.length, "one reference key").toBe(1);
  expect(req.memo, "memo present").toBeTruthy();
  evidence.checked(`QR decoded from the image pixels = "Open in wallet" href; recipient ${req.recipient}, amount ${req.amount} USDC, reference ${req.references[0]}`);

  const paid = await payFromTestPayer(href);
  evidence.solana("Solana Pay transfer (test payer -> platform)", paid.signature);
  const done = await readDone(page);
  expect(done.chargeId, "Solana charge id").toMatch(/^sol/);

  const facts = await solanaTxFacts(paid.signature, { recipient: sp.recipient!, payer: payer.address, mint: sp.mint });
  expect(facts.ok, "Solana transaction succeeded").toBe(true);
  expect(facts.accountKeys, "reference among the account keys").toContain(req.references[0]);
  expect(facts.recipientDelta, "recipient token account +price").toBe(s.price);
  expect(facts.payerDelta, "payer token account -price").toBe(-s.price);
  expect(facts.memos, "memo = charge id").toEqual([done.chargeId]);
  expect(req.memo, "URL memo = charge id").toBe(done.chargeId);
  // The server matched THIS payment to the charge (by its reference), not some other transfer.
  const charge = (await (await page.request.get(`/api/solana-pay/charges/${encodeURIComponent(done.chargeId)}`)).json()) as { status: string; solanaSignature: string | null; txHash: string | null };
  expect([charge.status, charge.solanaSignature, charge.txHash?.toLowerCase()], "charge: fulfilled by our signature, with the page's Tempo tx").toEqual(["fulfilled", paid.signature, done.txHash]);
  evidence.checked(`Solana tx: success, reference present, recipient +${s.price} / payer -${s.price} (tx metadata), memo = ${done.chargeId}; the API charge names this signature`);

  const platform = serverPlatform();
  const p = await verifyLicensePurchase(evidence, { txHash: done.txHash, agentIdHex: s.idHex, buyer: devWallet.address, payer: platform, price: s.price, creator: s.creator, label: "purchaseLicenseFor (Solana Pay, PLATFORM float)", chargeId: done.chargeId });
  expect(lower(p.receipt.from), "sender = PLATFORM key").toBe(platform);
  const fp = expectSponsored(p.receipt, platform, relayAddress());
  expect(await tokenBalance(devWallet.address), "buyer never held stablecoin on Tempo").toBe(0n);
  evidence.checked(`Tempo fulfilment sent by PLATFORM ${platform}, network fee by RELAY ${fp}; buyer never held stablecoin`);
  await expectInLibrary(page, evidence, { name: s.name, tokenId: p.tokenId });
});
