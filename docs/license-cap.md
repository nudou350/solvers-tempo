# License cap

A creator can limit how many licenses of a Solver are ever sold. The cap is enforced by `SolversRegistry` on-chain;
the server only mirrors it to answer early and clearly. Default: unlimited.

## 1. Rules (contract)

- Storage: `Agent.maxSupply` (`uint32`, `0` = unlimited) next to `Agent.totalSales` (licenses ever minted for the
  Solver), in the same storage slot.
- `setSupplyCap(agentId, max)` is creator-only:
  - from unlimited, the first cap needs `max >= 1` and `max >= totalSales` (`SupplyCapTooLow`);
  - afterwards it can **only go up**: `max` must be greater than the current cap (`SupplyCapCannotDecrease`);
  - there is no way back to unlimited and no way down. Event `SupplyCapSet(agentId, max)`.
- Every license purchase (`purchaseLicense`, `purchaseLicenseFor`, the permit variant) passes through
  `authorizeSale`, which reverts `SoldOut(agentId, max)` when `totalSales >= maxSupply` and otherwise increments
  `totalSales`. The whole transaction reverts: no token moves, no license is minted.
- `totalSales` only grows. **Transferring or burning a license never frees a slot**, and a transfer does not count as a
  sale (it pays the royalty of `docs/royalties.md`, not a new purchase).
- Credits and guarantees are not licenses and do not consume slots. The free trial is off-chain and does not consume a
  slot either.
- Two purchases racing for the last slot are ordered by the chain: exactly one succeeds, the other reverts `SoldOut`.

## 2. What may be promised

The contract only prevents **lowering** the cap. The creator can raise it at any time, so:

- Say: "the current limit is N licenses; it is recorded on-chain and can only go up".
- Never say "only N will exist", "guaranteed scarcity" or anything equivalent. This applies to the storefront, the
  MCP texts, `PACKAGE_SPEC.md` and any marketing text.

## 3. Where the cap comes from

- Manifest `supply: { maxLicenses }`, an integer from 1 to 1,000,000 (`MAX_LICENSES_CAP`). The validator warns
  `SUPPLY_WITH_TRIAL` when a capped Solver also offers the free trial.
- Publication: the creator's co-signed batch includes `setSupplyCap` when the approved manifest asks for a cap
  (`docs/creator-guide.md`). `cli:publish` (platform packages) creates the cap or raises it; a lower or missing value
  in the manifest is ignored with a warning, never turned into "unlimited" (`nextMaxLicenses` in
  `apps/server/src/store/supply-rules.ts`).
- After publication the creator raises it from the dashboard: `POST /api/tx/creator/:idOrSlug/supply-cap` returns the
  `setSupplyCap` call for the creator's wallet (409 `supply_unchanged` for the same value, 400 `supply_lower` /
  `supply_below_sold` otherwise). The cap is not part of the package hash, so no new version or review is needed.

## 4. Server mirror

- `agents.max_licenses` (null = unlimited) and `agents.total_sales`, written by the indexer from `SupplyCapSet` and
  every sale.
- Pre-checks answer 409 `sold_out` before any call is built or any money is taken: purchase intents
  (`/api/purchases/intent`), Pix charges, agent-pay quotes and orders, and the store purchase guards. If the mirror lags,
  the relay's simulation (or the platform's fulfilment) hits `SoldOut` and nothing moves; a Pix or agent payment that
  was already taken is refunded (`docs/payments.md`).
- API and MCP show `supply { max, sold, left }`: "X of Y licenses left" or "sold out". When sold out there is no
  purchase link; the text never points to a secondary market.

## 5. Limits

| Limit | Effect |
|---|---|
| The cap only rises | A creator who set it too high cannot lower it. |
| The creator can raise it | "Limited" is the limit of the moment, not a promise (section 2). |
| The counter is licenses minted, not licenses alive | Burning or transferring never reopens a slot. |
| The mirror can lag by a poll interval | The chain is the authority; a late pre-check is caught by simulation or refunded. |
| Pix and agent orders do not reserve a slot | A buyer can lose the last slot between charge and fulfilment; the payment is refunded. |
| Several wallets bypass any per-wallet rule | Nothing on-chain limits licenses per person. |

## 6. Tests

- Contracts: `contracts/test/Registry.t.sol` (cap rules), `License.t.sol` (`SoldOut` moves nothing, burn and transfer
  never free a slot), the invariant suite (`totalSales` monotonic and `<= maxSupply`).
- Server: `apps/server/test/supply-rules.test.ts` and the DB tests of the catalog and intents.
- End to end: `cd scripts && npm run e2e:supply` (cap 1, buyer A buys, buyer B is stopped by `SoldOut` with nothing
  moved, lower or equal caps refused, raise to 2, B buys). Passed on Moderato (`docs/migration/phase-6.md`).
