// "My library" actions shared by mode A and mode B: transfer (resell) a license from its card.
import type { Page } from "@playwright/test";
import { getAddress, type Hex } from "viem";
import { chainAgent, eventArgs, expectedRoyalty, licenseOf, lower, ownerOf, receiptOf, registryConfig } from "./chain.js";
import { blockDeltas, expectSponsored, nextConfirmedTx, tokenTransfers } from "./checkout.js";
import { expect, type Evidence } from "./fixtures.js";

/**
 * Opens the license card of `name`, transfers it to `to` through the dialog and returns the confirmed tx hash. The card
 * shows no token id, so the account must hold exactly ONE license with that name, and it must be `tokenId` (checked in
 * /api/me/licenses before anything is sent): the wrong license can never be given away.
 */
export async function transferInLibrary(page: Page, o: { name: string; to: string; tokenId: bigint; royaltyText?: string }): Promise<Hex> {
  type Lic = { id: string; agentId: string };
  await expect
    .poll(async () => ((await (await page.request.get("/api/me/licenses")).json()) as Lic[]).map((l) => l.id), { timeout: 60_000, message: `license #${o.tokenId} in /api/me/licenses` })
    .toContain(o.tokenId.toString());
  await page.goto("/en/library");
  const card = page.locator("article").filter({ has: page.locator("h2", { hasText: o.name }) });
  await expect(card).toBeVisible({ timeout: 60_000 });
  expect(await card.count(), `exactly one license named "${o.name}" in the library (the card is chosen by name)`).toBe(1);
  await card.getByRole("button", { name: "Transfer" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (o.royaltyText) await expect(dialog.getByText(o.royaltyText, { exact: false }).first()).toBeVisible();
  await dialog.getByLabel("Recipient's wallet address").fill(getAddress(o.to));
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(getAddress(o.to), { exact: false }).or(dialog.getByText(o.to.toLowerCase(), { exact: false })).first()).toBeVisible();
  const sent = nextConfirmedTx(page);
  await dialog.getByRole("button", { name: "Transfer license" }).click();
  const hash = await sent;
  await expect(page.getByText("License sent", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).filter({ hasText: "Close" }).click();
  return hash;
}

/**
 * On-chain facts of a license transfer with royalty: receipt success, exactly one RoyaltyPaid with the creator and
 * platform shares of the ORIGINAL price (each floored, platform capped so the total stays <= 25%), paid by the old owner
 * (its token Transfers and the block deltas of creator and treasury), sponsored fee, ownerOf = new owner.
 */
export async function verifyTransfer(
  ev: Evidence,
  o: { hash: Hex; tokenId: bigint; from: string; to: string; agentId: string; relay: string | null; label: string },
): Promise<{ total: bigint }> {
  const cfg = await registryConfig();
  const agent = await chainAgent(o.agentId);
  const lic = await licenseOf(o.tokenId);
  const royalty = expectedRoyalty(lic.originalPrice, agent.royaltyBps, cfg.platformRoyaltyBps);
  const creator = lower(agent.creator);
  const receipt = await receiptOf(o.hash);
  expect(receipt.status, "receipt status").toBe("success");
  await ev.tempo(o.label, o.hash);
  const events = await eventArgs<{ tokenId: bigint; from: string; to: string; creator: string; creatorAmount: bigint; platformAmount: bigint; creatorDeferred: boolean; platformDeferred: boolean }>(receipt, "RoyaltyPaid");
  expect(events.length, "RoyaltyPaid events").toBe(1);
  const e = events[0]!;
  expect([e.tokenId, lower(e.from), lower(e.to), lower(e.creator), e.creatorAmount, e.platformAmount, e.creatorDeferred, e.platformDeferred], "RoyaltyPaid").toEqual([
    o.tokenId,
    lower(o.from),
    lower(o.to),
    creator,
    royalty.creatorAmount,
    royalty.platformAmount,
    false,
    false,
  ]);
  const fromOwner = (await tokenTransfers(receipt)).filter(([f]) => f === lower(o.from));
  expect(fromOwner.sort(), "royalty paid by the transferring owner").toEqual(
    ([[lower(o.from), creator, royalty.creatorAmount], [lower(o.from), lower(cfg.treasury), royalty.platformAmount]] as [string, string, bigint][]).sort(),
  );
  expect(await blockDeltas(receipt, { creator, treasury: cfg.treasury }), "balance deltas of creator and treasury").toEqual({ creator: royalty.creatorAmount, treasury: royalty.platformAmount });
  expectSponsored(receipt, o.from, o.relay);
  expect(await ownerOf(o.tokenId), "ownerOf = new owner").toBe(lower(o.to));
  ev.checked(
    `RoyaltyPaid: creator ${royalty.creatorAmount} (${agent.royaltyBps} bps) + platform ${royalty.platformAmount} (${cfg.platformRoyaltyBps} bps) of the original price ${lic.originalPrice}, paid by ${o.from} (Transfer logs + block deltas); fee sponsored; ownerOf(#${o.tokenId}) = ${o.to}`,
  );
  return { total: royalty.total };
}
