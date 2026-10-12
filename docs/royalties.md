# Transfer royalties

A license is an ERC-721 token (`SolversLicense`). It can be given or sold to another wallet, and **every transfer pays
a royalty enforced by the contract** (D15). There is no marketplace inside Solvers: how the two parties settle any price
between themselves is outside the platform, and the royalty does not depend on it.

## 1. The rule

```
creatorAmount  = originalPrice × creatorBps  / 10,000   (rounded down)
platformAmount = originalPrice × platformBps / 10,000   (rounded down)
```

- **Base = the original price** paid when that license was minted (stored in the license slot), not any later price.
- **creatorBps** is per Solver: the manifest's `pricing.royaltyBps`, written at `registerAgent`. The creator can change
  it with `setRoyaltyBps` **only until the first sale** (`RoyaltyLocked` afterwards).
- **platformBps** is the Registry config `platformRoyaltyBps`, default 500 (5%), changed by the admin with
  `cli:admin set-config platform-royalty-bps=<n>`; it applies to every later transfer.
- Total cap 2500 bps (25%, `MAX_TOTAL_ROYALTY_BPS`): registration and `setRoyaltyBps` refuse `creatorBps + platformBps
  > 2500` (`RoyaltyTooHigh`). If the admin later raises `platformRoyaltyBps`, the platform share is clamped so the total
  stays within 25% (`SolversMath.effectivePlatformBps`); the creator's share is never reduced.
- Each share is floored separately; the dust stays with the payer. Example: original price 19 units, 500 + 500 bps →
  0.95 + 0.95 (measured by `e2e-transfer` on Moderato). Test vector: `19` base units at 500/1000 bps → `0` and `1`.
- The defaults (5% creator for most packages, 5% platform) are still an owner decision (decisions.md, owed #2). Today's
  packages declare `royaltyBps` between 300 and 500.

## 2. Who pays, when

- The **current owner** (`from`) always pays, also when an approved operator or a `setApprovalForAll` operator moves
  the token: the operator needs the owner's token allowance to the License contract.
- It is charged inside the ERC-721 `_update`, so **every** transfer path pays: `transferFrom`, both `safeTransferFrom`s,
  `transferWithRoyalty(to, tokenId, maxRoyalty)` and `transferWithRoyaltyPermit(...)` (one call with an EIP-2612 permit
  on the payment token).
- If the owner's allowance or balance is below the total, the transfer reverts with `RoyaltyNotPaid(required)` and
  nothing moves.
- `transferWithRoyalty` also reverts with `RoyaltyChanged(quote)` if the quote rose above `maxRoyalty` (for example the
  admin changed `platformRoyaltyBps` between quote and transaction).
- Exempt: minting (the purchase), burning (`burn(tokenId)` by the owner) and a transfer to oneself.
- While the admin-only pause bit `TRANSFERS` (4) is set, transfers revert `TransfersPaused`; mint and burn still work.
- The creator share goes to the agent's creator and the platform share to the treasury, with the deferred-payout
  fallback of `docs/economics.md` section 5 if a recipient cannot receive.

## 3. What a transfer does not change

- **The license cap is never freed**: the cap counts licenses minted over the Solver's life (`totalSales`), so a
  transfer or a burn never opens a slot (`docs/license-cap.md`).
- Memories stay with the wallet that created them; they do not travel with the license.
- A license that already backed a review cannot back another author's review (X12).

## 4. How the app does it

1. `GET /api/me/licenses/:id/transfer-quote` returns the bps and the exact amounts (`quoteRoyalty` on-chain).
2. `POST /api/tx/transfer { licenseId, to, maxRoyaltyUnits }` refuses a self-transfer and the zero address, checks the
   `TRANSFERS` pause and the owner's balance, answers 409 `royalty_changed` with the new quote if it went up, and
   returns one batch `[token.approve(license, royalty), license.transferWithRoyalty(to, tokenId, maxRoyalty)]`.
3. The wallet sends the batch through the relay (the platform pays the network fee); `POST /api/tx/confirm` indexes it.
   The indexer moves the license row to the new owner and records `chain_txs.kind = royalty`; the creator dashboard
   shows "royalties from transfers".

Web: `apps/web/src/components/account/TransferLicenseDialog.tsx` (recipient checks, disclosure of both shares, re-quote
on `royalty_changed`). End to end: `cd scripts && npm run e2e:transfer`.

## 5. `royaltyInfo` (ERC-2981)

`royaltyInfo(tokenId, salePrice)` returns the License contract as receiver and the amount actually charged
(creator + platform shares of the original price, each floored; X13), whatever `salePrice` is. It is informational
for external marketplaces; Solvers enforces the royalty on the transfer itself. Tokens sent to the License contract
outside a transfer are strays the admin can sweep.
