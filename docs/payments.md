# Payments

How Solvers takes money and turns it into an on-chain purchase. Code: `packages/shared/src/payments.ts` (types),
`apps/server/src/payments` (registry, lifecycle, ledger, fulfilment, reconcile, export), `apps/server/src/pix`,
`apps/server/src/agent-pay`. Splits and minimums: `docs/economics.md`. Float operations: `docs/treasury.md`. Open
business and accounting questions (no answers here): `docs/payments-open-questions.md`.

## 1. Model

- A **charge** buys exactly one thing (a license, a number of credits or a guarantee) for one buyer.
- Every charge has a `chargeId` (ledger primary key) and `purchaseId = keccak256("solvers:v1:" + chargeId)`
  (`purchaseIdFor` in `packages/shared/src/evm.ts`).
- The contracts accept a purchase id once per payer: the Registry stores `keccak256(payer, purchaseId)` and refuses a
  replay with `DuplicatePurchase` (X22). `purchaseRef(payer, purchaseId)` tells what a used id bought (kind and token
  id, escrow id or buyer), which is how interrupted charges are resumed.
- The **ledger row is written before** anything is sent to a wallet or to the chain.
- Each provider implements the `PaymentProvider` interface: `capabilities`, `createCharge`, `confirm`,
  `handleWebhook?`, `fulfill`, `reconcile`, `refund?`.

## 2. Providers

| Id | Kinds | Settlement | Refundable | Status |
|---|---|---|---|---|
| `direct-wallet` | license, credits, escrow | the buyer sends the purchase (sponsored batch) | no (the platform never holds the money) | live |
| `pix-intermediated` | license, credits, escrow | the PLATFORM key sends `*For(buyer, …)` from its float | yes (Mercado Pago refund) | live off mainnet, simulated without credentials; disabled on mainnet |
| `agent-pay` | license | MPP payment into the PLATFORM float, then `purchaseLicenseFor` | yes (on-chain transfer back to the payer) | behind `AGENT_PAY_ENABLED` |
| `pix-marketplace-split` | license | external | — | stub (`NotImplemented`), open question |
| `fiat-onramp-to-wallet` | all | buyer, after an on-ramp | — | stub (`NotImplemented`), open question |
| `fake` | all | in memory | — | tests only |

### direct-wallet

1. `POST /api/purchases/intent` (session required; the buyer is always the session wallet) checks the Solver is
   sellable (status, platform status, reviewed version and price, cap, pause, not the creator, not already owned),
   writes the ledger row and returns the calls: `[token.approve(contract, amount), purchaseLicense | buyCredits |
   createEscrow (…, purchaseId)]`.
2. The wallet sends them as one sponsored batch through `/api/relay` and calls `POST /api/tx/confirm` with the hash.
3. The indexer's `SaleAuthorized` (or `purchaseRef(buyer, purchaseId)`) marks the charge `fulfilled`. An intent never
   sent expires after 30 minutes; if it lands later, the chain wins.

`GET /api/purchases/:chargeId` shows any charge to its buyer.

### pix-intermediated (D10)

1. `POST /api/pix/charges` (same input as an intent; at most 3 open Pix charges per buyer) quotes the price in BRL
   (`store/fx.ts`: a public USD-BRL quote, fallback `BRL_PER_USD`; the rate is stored with 8 decimals and its source),
   bounds R$ 1 to R$ 500, and creates a Mercado Pago order (30 minutes to pay).
2. The buyer pays the Pix. Mercado Pago calls `POST /webhooks/mercadopago`; the signature (HMAC with
   `MP_WEBHOOK_SECRET`, timestamp window) is verified, and the order status is always **re-read** from the Mercado Pago
   Orders API, never taken from the webhook body. A replayed webhook is harmless.
3. Fulfilment: the PLATFORM key sends one batch `[token.approve(exact amount), purchaseLicenseFor | buyCreditsFor |
   createEscrowFor(buyer, …, purchaseId)]` on nonce lane 1, fee paid by RELAY. The hash is journaled before broadcast.
   The contract split pays the creator and the treasury in that transaction.
4. If the purchase became impossible (sold out, price changed, Solver suspended), the charge is refunded through
   Mercado Pago.

Without Mercado Pago credentials and off mainnet, `PIX_SIMULATE` (default true off mainnet) shows a placeholder code
and `POST /api/pix/charges/:id/simulate` approves it. On mainnet Pix is disabled in code (`pix/provider.ts`) until the
questions in `docs/payments-open-questions.md` are answered.

### agent-pay (D4)

HTTP 402 with the Machine Payments Protocol: see `docs/agent-payments.md`. The payment settles into the PLATFORM float
(X24) and the license is then minted to the paying wallet with `purchaseLicenseFor`, like Pix.

## 3. Lifecycle

`apps/server/src/payments/lifecycle.ts`:

```
created -> pending_payment -> confirmed -> fulfilling -> fulfilled
                  |               |            |
                  v               v            v
           expired / failed    refunding -> refunded
```

- Transitions are conditional updates, so two workers never fulfil the same charge; only the caller that wins
  `confirmed -> fulfilling` sends a transaction, and it first checks `purchaseRef(PLATFORM, purchaseId)` and the
  `sent_txs` journal.
- Two facts override the normal order: the chain shows the sale (any open or abandoned charge becomes `fulfilled`), and
  the provider proves a late payment (`expired -> confirmed`).
- Errors that can never succeed (for example `SoldOut`, `AgentNotActive`) lead to a refund; float problems (balance or
  allowance) alert the admin and retry; an attempt and age limit stops endless retries with an alert and a refund.

## 4. Ledger

Table `payment_ledger` (one row per charge): provider and provider charge id, `purchase_id`, kind, buyer and payer
wallets, agent id, the intent (credits amount, escrow milestones), BRL amount in cents, FX rate and source, token
address and amount, gross, fee, creator amount, creator-deferred flag, tx hash and log index, `ref` from `purchaseRef`,
status, error, provider payload, timestamps (`created_at`, `confirmed_at`, `fulfilled_at`, `updated_at`). Unique on
`(payer_wallet, purchase_id)` and on `(provider, provider_charge_id)`.

Export: `pnpm --filter @solvers/server cli:ledger-export --from 2026-10-01 --to 2026-10-31 > ledger.csv` (UTC days,
both inclusive; default the current month).

## 5. Reconcile

Job `payments: reconcile` every 30 s (`apps/server/src/payments/jobs.ts`): expires stale charges, fulfils confirmed
ones, resumes interrupted fulfilments from the chain (`purchaseRef`, journal receipts) and finishes interrupted refunds.
Job `payments: float balance` every 10 minutes alerts when PLATFORM or RELAY holds less than
`FLOAT_LOW_BALANCE_UNITS`. `cli:treasury-status` lists balances and open charges.

## 6. Tests and checks

- Conformance suite over the providers and the fake provider (replays, crash between confirmed and fulfilled, price
  changes, sold out, pause, on-chain duplicates) in `apps/server/test`.
- End to end on a running API: `cd scripts && npm run e2e:purchase`, `npm run e2e:pix`, `npm run e2e:agent-pay`
  (`docs/qa.md`).
