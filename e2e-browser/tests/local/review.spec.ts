// Scenario 9 (mode A): a license holder reviews the Solver from "My library". The review is an on-chain transaction
// backed by the license (ReviewSubmitted + LicenseReviewed, content hash = sha256 of the text), and the Solver page
// shows it. A wallet without the license cannot build one.
import { createHash, randomBytes } from "node:crypto";
import { agentIdToBytes32 } from "@solvers/shared";
import { freshAccount } from "../../../scripts/src/env.js";
import { expectFailure } from "../../../scripts/src/lib/http.js";
import { TestWallet } from "../../../scripts/src/lib/wallet.js";
import { eventArgs, licenseOf, lower, receiptOf, relayAddress } from "../../src/chain.js";
import { expectSponsored, nextConfirmedTx } from "../../src/checkout.js";
import { ownLicense } from "../../src/data.js";
import { expect, signInWithDevWallet, test } from "../../src/fixtures.js";

test("scenario 9: review a Solver from the library (on-chain, license required, shown on the Solver page)", async ({ page, devWallet, evidence }) => {
  const slug = "frontend-react";
  const own = await ownLicense(evidence, devWallet.account, slug);
  const text = `Browser e2e review ${randomBytes(4).toString("hex")}: clear plan, accessible components.`;

  await signInWithDevWallet(page);
  await page.goto("/en/library");
  const card = page.locator("article").filter({ has: page.locator("h2", { hasText: own.name }) });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Review" }).click();
  await card.getByRole("radio", { name: /^4 out of 5/ }).click();
  await card.locator("textarea").fill(text);
  const sent = nextConfirmedTx(page);
  await card.getByRole("button", { name: /^(Publish review|Update review)$/ }).click();
  const hash = await sent;
  await expect(page.getByText("Review published", { exact: true })).toBeVisible();

  const receipt = await receiptOf(hash);
  expect(receipt.status).toBe("success");
  await evidence.tempo("submitReview (sponsored)", hash);
  expectSponsored(receipt, devWallet.address, relayAddress());
  const ev = await eventArgs<{ agentId: string; author: string; rating: number; contentHash: string; tokenId: bigint; edited: boolean }>(receipt, "ReviewSubmitted");
  expect(ev.length, "ReviewSubmitted events").toBe(1);
  const e = ev[0]!;
  const sha = `0x${createHash("sha256").update(text).digest("hex")}`;
  expect([lower(e.agentId), lower(e.author), Number(e.rating), lower(e.contentHash), BigInt(e.tokenId), e.edited], "ReviewSubmitted").toEqual([
    lower(agentIdToBytes32(own.agentId)),
    devWallet.lower,
    4,
    sha,
    own.tokenId,
    false,
  ]);
  const linked = await eventArgs<{ tokenId: bigint; reviewId: bigint }>(receipt, "LicenseReviewed");
  expect(linked.map((l) => l.tokenId), "LicenseReviewed(tokenId)").toEqual([own.tokenId]);
  expect((await licenseOf(own.tokenId)).reviewId, "license records the review id").toBe(linked[0]!.reviewId);
  evidence.checked(`ReviewSubmitted(author = buyer, rating 4, contentHash = sha256(text), tokenId #${own.tokenId}); license #${own.tokenId} reviewId = ${linked[0]!.reviewId}; fee by RELAY`);

  // Shown on the Solver page (the API serves the text only when it matches the on-chain hash).
  await page.goto(`/en/solvers/${slug}`);
  await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });
  evidence.checked("the review text appears on the Solver page");

  // License required: another signed-in wallet cannot build a review.
  const stranger = await new TestWallet(freshAccount(), "stranger").login();
  await expectFailure(stranger.post("/api/tx/review", { agentId: own.agentId, rating: 5, text: "no license" }), 403);
  evidence.checked("a wallet without the license gets 403 from /api/tx/review");
});
