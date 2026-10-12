// Scenario 6 (mode A): resell / transfer a license to another wallet from "My library". The transferring owner pays the
// royalty (creator share + platform share of the ORIGINAL price, each floored); the license moves; the old owner loses
// access. Everything is checked on chain and through the old owner's session.
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentDetail, chainAgent, eventArgs, expectedRoyalty, licenseOf, lower, ownerOf, receiptOf, registryConfig, relayAddress, tokenBalance } from "../../src/chain.js";
import { blockDeltas, expectSponsored, nextConfirmedTx, tokenTransfers } from "../../src/checkout.js";
import { ownLicense } from "../../src/data.js";
import { expect, signInWithDevWallet, test } from "../../src/fixtures.js";
import { token } from "../../src/money.js";

test("scenario 6: transfer a license with royalty (creator 5% + platform 5% of the original price)", async ({ page, devWallet, evidence }) => {
  const cfg = await registryConfig();
  const slug = "ui-design";
  const pre = await chainAgent((await agentDetail(slug)).agent.id);
  const royalty = expectedRoyalty(pre.price, pre.royaltyBps, cfg.platformRoyaltyBps);
  const own = await ownLicense(evidence, devWallet.account, slug, royalty.total);
  const lic = await licenseOf(own.tokenId);
  expect(lic.originalPrice, "original price recorded on the license").toBe(own.price);
  const heir = privateKeyToAccount(generatePrivateKey());
  const creator = lower(pre.creator);

  await signInWithDevWallet(page);
  await page.goto("/en/library");
  const card = page.locator("article").filter({ has: page.locator("h2", { hasText: own.name }) });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Transfer" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The royalty shown matches the on-chain math.
  await expect(dialog.getByText(`To the creator (${pre.royaltyBps / 100}%)`)).toBeVisible();
  await expect(dialog.getByText(token(royalty.total, "USD", "en"), { exact: false }).first()).toBeVisible();
  await dialog.getByLabel("Recipient's wallet address").fill(getAddress(heir.address));
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(heir.address, { exact: false }).or(dialog.getByText(getAddress(heir.address), { exact: false })).first()).toBeVisible();

  const ownerBefore = await tokenBalance(devWallet.address);
  // Read right before the transfer (other tests may buy this Solver meanwhile): a transfer must not count as a sale.
  const salesBefore = (await chainAgent(own.agentId)).totalSales;
  const sent = nextConfirmedTx(page);
  await dialog.getByRole("button", { name: "Transfer license" }).click();
  const hash = await sent;
  await expect(page.getByText("License sent", { exact: true })).toBeVisible();

  const receipt = await receiptOf(hash);
  expect(receipt.status, "receipt status").toBe("success");
  await evidence.tempo("transferWithRoyalty (sponsored)", hash);
  const ev = await eventArgs<{ tokenId: bigint; from: string; to: string; creator: string; creatorAmount: bigint; platformAmount: bigint; creatorDeferred: boolean; platformDeferred: boolean }>(receipt, "RoyaltyPaid");
  expect(ev.length, "RoyaltyPaid events").toBe(1);
  const e = ev[0]!;
  expect([e.tokenId, lower(e.from), lower(e.to), lower(e.creator), e.creatorAmount, e.platformAmount, e.creatorDeferred, e.platformDeferred], "RoyaltyPaid").toEqual([
    own.tokenId,
    devWallet.lower,
    lower(heir.address),
    creator,
    royalty.creatorAmount,
    royalty.platformAmount,
    false,
    false,
  ]);
  const fromOwner = (await tokenTransfers(receipt)).filter(([f]) => f === devWallet.lower);
  expect(fromOwner.sort(), "royalty paid by the transferring owner").toEqual(
    ([[devWallet.lower, creator, royalty.creatorAmount], [devWallet.lower, lower(cfg.treasury), royalty.platformAmount]] as [string, string, bigint][]).sort(),
  );
  expect(await blockDeltas(receipt, { creator, treasury: cfg.treasury }), "balance deltas of the block").toEqual({ creator: royalty.creatorAmount, treasury: royalty.platformAmount });
  expect(ownerBefore - (await tokenBalance(devWallet.address)), "owner paid exactly the royalty").toBe(royalty.total);
  expectSponsored(receipt, devWallet.address, relayAddress());
  expect(await ownerOf(own.tokenId), "ownerOf = new owner").toBe(lower(heir.address));
  const agentAfter = await chainAgent(own.agentId);
  expect(agentAfter.totalSales, "a transfer is not a sale (cap slot not freed or taken)").toBe(salesBefore);
  evidence.checked(
    `RoyaltyPaid: creator ${royalty.creatorAmount} (${pre.royaltyBps} bps) + platform ${royalty.platformAmount} (${cfg.platformRoyaltyBps} bps) of the original price ${own.price}, paid by the old owner (Transfer logs + block deltas); fee by RELAY; ownerOf(#${own.tokenId}) = ${heir.address}`,
  );

  // The old owner lost access: no license in its session, nothing in its library.
  await dialog.getByRole("button", { name: "Close" }).filter({ hasText: "Close" }).click();
  // The API mirror is updated by the indexer: polled.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/me/access/${slug}`)).json()) as { license: unknown }).license, { timeout: 60_000, message: "old owner's access after the transfer" })
    .toBeNull();
  await expect
    .poll(async () => ((await (await page.request.get("/api/me/licenses")).json()) as { id: string }[]).map((l) => l.id), { timeout: 60_000, message: "old owner's licenses" })
    .not.toContain(own.tokenId.toString());
  // This wallet only ever held this license: the library must reach its empty state (not just "still loading").
  await page.goto("/en/library");
  await expect(page.getByText("No solvers in your library", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("article h2", { hasText: own.name })).toHaveCount(0);
  evidence.checked("old owner: /api/me/access has no license, /api/me/licenses and My library no longer list it");
});
