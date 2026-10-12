# Economics

Who pays what, and where the money goes, as enforced by the contracts (`contracts/src`) and mirrored by
`packages/shared/src/money.ts`. Transfer royalties have their own page: `docs/royalties.md`. Questions about taxes,
invoices or who the seller of record is are not answered here: see `docs/payments-open-questions.md`.

## 1. Units

- All money is one TIP-20 USD stablecoin, the **payment token** (`PAYMENT_TOKEN`; pathUSD on Moderato; the mainnet
  token is an owed decision). TIP-20 tokens always have 6 decimals
  (https://tempo.xyz/developers/docs/protocol/tip20/spec); the contracts assert it at initialization and the server
  checks `decimals()` against `PAYMENT_TOKEN_DECIMALS` at boot.
- Contracts and the database use **base units** (`1 USD = 1,000,000`). Code uses `bigint` end to end; no float math on
  amounts.
- The package manifest keeps the field name `pricing.priceUsdc` (D14): it is the price **in USD-stablecoin units**
  (e.g. `19` = 19,000,000 base units), whatever the configured token is.

## 2. Minimum price

`minPrice` is a Registry config, default `5 × 10^6` base units (5 stablecoin units). Every purchase must reach it:

| Purchase | Rule | Error |
|---|---|---|
| License | `price >= minPrice` at registration, at every `updatePricing` and again at purchase time (also after the admin raises `minPrice`, X18) | `PriceTooLow` |
| Credits | `pricePerUse × amount >= minPrice` (and `pricePerUse <= price`) | `PriceTooLow` |
| Guarantee (escrow) | sum of the milestones `>= minPrice` (one milestone may be smaller) | `PriceTooLow` |

The admin changes it with `cli:admin set-config min-price=<amount>`.

## 3. Primary-sale split

Every license sale, credit purchase and escrow release is split with `SolversMath.feeSplit`:

```
fee  = amount × feeBps / 10,000   (rounded down)
rest = amount − fee                (to the creator)
```

- `feeBps` is a Registry config: default 1000 (10%), hard cap 2000 (`MAX_FEE_BPS`, `FeeTooHigh`).
- Rounding always favours the creator: the dust of the floor stays in `rest`.
- A zero share is skipped. Example (test vector): `5,000,009` at 1000 bps → fee `500,000`, creator `4,500,009`.
- Measured on Moderato (`e2e-purchase`): a 19-unit license → buyer pays exactly 19, creator receives 17.1, treasury 1.9.
- The fee goes to the **treasury** address in the Registry config; the rest to the agent's creator.

| Kind | When the money moves | Fee rate used |
|---|---|---|
| License | at purchase, from the payer straight to creator and treasury | current `feeBps` |
| Credits | at purchase, same as licenses | current `feeBps` |
| Guarantee | at purchase the whole amount goes into the escrow contract; each milestone release pays creator + fee from it | `feeBps` **frozen at escrow creation** |
| Guarantee refund | lost dispute, `cancelUndelivered`, stale dispute: the milestone amount goes back to the buyer | no fee |

There is no refund of a license or of credits once bought.

## 4. Network fees are never deducted

The buyer pays exactly the price; the creator receives exactly `rest`; the treasury exactly `fee`. Network fees are
paid on top by the platform's RELAY key (relay and server-sent transactions, D3) and never come out of any split.
Agent payments over MPP follow the same rule: the agent pays only the price (`docs/agent-payments.md`).

Order of magnitude (measured in `docs/migration/phase-2.md`, gas at the Tempo base-fee cap of about $0.012 per million
gas, plan T8): a first license purchase ~1.9M gas, an escrow with 5 milestones ~4.4M gas (about $0.05), a royalty
transfer ~0.4M gas. A new storage slot costs 250,000 gas on Tempo
(https://tempo.xyz/developers/docs/quickstart/evm-compatibility).

## 5. Deferred payouts (D5)

Payments are pushed to their recipients during the same transaction. If a recipient cannot receive (a TIP-403 receive
policy or a token-level policy of the stablecoin issuer), the contract keeps the amount as `deferred[recipient]`, emits
`PayoutDeferred`, and the sale or release still succeeds. The recipient later calls `claim()` on that contract
(web: account page, `POST /api/tx/claim`; balance: `GET /api/me/payouts`). Only the blocked address can claim, and
`claim()` refuses while the claimer's own policy would still redirect the payment (`RecipientBlocked`, X5).

Tokens that end up in a contract outside any accounting (stray transfers) can be moved by the admin:
`balance − locked − deferred` via `cli:admin sweep-stray <license|credits|escrow|staking> <to>`.

## 6. Creator stake

`minStake` (Registry config; 0 on Moderato) is pulled from the creator at `registerAgent` and held by `SolversStaking`;
sales require `stake >= minStake`. Exit: `requestStakeExit` retires the Solver and the stake can be withdrawn 30 days
later (the admin can extend twice by 30 days). Slash: the admin proposes, it becomes executable after 72 h and expires
14 days later; `min(amount, stake)` goes to the treasury. With `minStake = 0` there is nothing to slash.

## 7. Platform float

Pix and agent purchases are paid on-chain by the PLATFORM key from its own stablecoin balance (`*For` calls). The
contract split is identical (the creator and the treasury are paid at that moment); only the payer differs. Operating
the float is in `docs/treasury.md`; payment flows in `docs/payments.md`.

## 8. Off-chain limits that shape the money

These are server rules, not contract rules (a buyer calling the contract directly is bound only by the contract):

- Maximum open guarantee value per buyer reputation level (`GUARANTEE_LIMITS_USDC` in `packages/shared/src/rules.ts`:
  0 for `none`, 20 units for `limited`, 500 for `full`), enforced when the server plans an escrow purchase (X32).
- Agent-pay price bounds `AGENT_PAY_MIN_PRICE` / `AGENT_PAY_MAX_PRICE` (default 5 / 100 units).
- Pix charge bounds R$ 1 to R$ 500 (`apps/server/src/pix/rules.ts`), at most 3 open charges per buyer.
