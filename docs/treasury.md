# Treasury and floats

Who holds the platform's stablecoin, what each balance pays for, how to watch it and how to top it up. Facts only: open
accounting and custody questions are in [`payments-open-questions.md`](payments-open-questions.md) (§6 and §7); nothing
here is a tax or legal conclusion. Keys and custody: [`deploy-runbook.md`](deploy-runbook.md) §2. Money flows:
[`payments.md`](payments.md), [`economics.md`](economics.md).

All amounts are in base units of the payment token (`PAYMENT_TOKEN`, 6 decimals; 1,000,000 units = 1 stablecoin unit).

## 1. The three balances

| Account | Key | What it pays or receives | Holds roles |
|---|---|---|---|
| **PLATFORM float** | `PLATFORM_PRIVATE_KEY` (hot, on the API server) | Pays every `*For` purchase: `purchaseLicenseFor` / `buyCreditsFor` / `createEscrowFor` for Pix (`pix-intermediated`) and agent payments (`agent-pay`). **Receives** the MPP settlements of agent payments (decisions.md X24), which the fulfilment spends seconds later, so a fulfilled agent purchase nets to zero on the float. Refunds of agent payments go back from it. On the local chain only, the `/api/faucet` route transfers from it. It also signs, without paying any fee, the usage batches (`recordUsageBatch`, usage lane) and the permissionless escrow upkeep (`releaseMilestone` after the review window, `resolveStaleDispute`; X27). | `PLATFORM_ROLE`, `USAGE_ROLE` |
| **RELAY fee key** | `RELAY_PRIVATE_KEY` (hot, on the API server) | Pays **every network fee**: the relay (`POST /api/relay`, browsers and agents), every server-sent transaction (PLATFORM, VERIFIER and admin lanes, in-process fee payer), the MPP pull-mode settlements of agents, and the admin CLIs (D20). | none (boot validation refuses any role) |
| **TREASURY** | `TREASURY_ADDRESS` (cold wallet, owner) | Receives the primary-sale platform fee (`feeBps`, floor), the fee on escrow releases, the platform share of every transfer royalty, executed slashes, and whatever an admin `sweep-stray` sends there. It pays nothing automatically. | none |

The treasury must be the Registry's `treasury()`: the API refuses to start otherwise (`validateChain`). Changing it is
`cli:admin set-config treasury=<address>` (admin) plus the same value in the env. The contracts reject a TIP-20 token
address as treasury.

Network fees are never deducted from any split: a buyer pays exactly the price, the creator gets exactly price − fee,
and the RELAY key alone carries the gas (measured in `e2e-purchase`, `docs/migration/phase-6.md`).

## 2. Held (deferred) payouts

If a payment to a recipient would be blocked by that recipient's TIP-403 receive policy, the contracts keep the amount
(`deferred[recipient]`) instead of failing the sale or the release (decisions.md D5, X5). The recipient claims it with
`claim()` on the contract that holds it (the web's held payouts card; API `POST /api/tx/claim`, `GET /api/me/payouts`);
`claim()` reverts `RecipientBlocked` while the claimer's own policy would still redirect it. Deferred amounts belong to the
recipient: the platform cannot redirect them.

`sweepStray(to)` (default admin) moves only what is neither locked nor deferred (`balance − locked − totalDeferred`) out of
License, Credits, Escrow or Staking, e.g. tokens sent to a contract by mistake:

```bash
pnpm --filter @solvers/server cli:admin sweep-stray escrow <to>          # dry-run: shows the amount and the simulation
pnpm --filter @solvers/server cli:admin sweep-stray escrow <to> --yes    # sends (admin key, fee by RELAY)
```

## 3. Alerts

| Alert | Source | When | Throttle |
|---|---|---|---|
| Float low | job `payments: float balance` (`apps/server/src/payments/float.ts`), every 10 min | PLATFORM or RELAY below `FLOAT_LOW_BALANCE_UNITS` (default 50000000 = 50 units) | once per account every 6 h |
| Relay budget exhausted | relay (`apps/server/src/relay/service.ts`) | the rolling 24 h sponsored gas reached `RELAY_DAILY_GAS_GLOBAL` (default 2,000,000,000); sponsored transactions are refused | once an hour |
| Payments (stuck or duplicate charges, unfulfillable purchases) | payments module (`payments/alerts.ts`) | per event | per key, default once an hour |

Alerts go to the Telegram chat `TELEGRAM_ADMIN_CHAT_ID` (bot `TELEGRAM_BOT_TOKEN`); without a token they are only logged.
The treasury balance is shown by `cli:treasury-status` but never alerts.

## 4. Status and ledger

```bash
pnpm --filter @solvers/server cli:treasury-status
```

Read-only: prints the chain, token and threshold, the PLATFORM, RELAY and TREASURY balances (`LOW` next to an account under
the threshold) and the open charges of the payment ledger by provider and status, with the oldest one's age.

```bash
pnpm --filter @solvers/server cli:ledger-export --from 2026-10-01 --to 2026-10-31 > ledger.csv
```

CSV of `payment_ledger` rows created between the two UTC days (both inclusive; default: from the first day of the current
month to today). Rows carry the provider, purchase id, buyer, kind, BRL amount and FX rate/source (Pix), token amount,
fee, creator amount, deferral flag, tx hash and status.

## 5. Topping up

### Testnets

Moderato's public faucet (plan T7, https://tempo.xyz/developers/docs/quickstart/faucet; amounts not published) through the
script, which calls `tempo_fundAddress` until the balance reaches the target (local anvil: a transfer from dev account 0;
never on mainnet):

```bash
cd scripts && npx tsx src/topup.ts                          # server wallets from apps/server/.env, target 100 each
npx tsx src/topup.ts --min 500 platform relay               # only these, target 500
npx tsx src/topup.ts --min 50 0x<address> buyer1            # an address and/or a named key under scripts/.keys
SERVER_ENV_FILE=../apps/server/.env.qa npx tsx src/topup.ts # the local QA environment
```

Or directly: `cast rpc tempo_fundAddress <address> --rpc-url https://rpc.moderato.tempo.xyz`.

### Mainnet

There is no faucet. The owner transfers the payment token from the treasury (cold) to the PLATFORM or RELAY address; nobody
else moves treasury funds. Who may authorise these movements and how they are recorded is an open question
(`payments-open-questions.md` §7). Size the floats to the expected Pix and agent volume between top-ups (PLATFORM) and
to the daily sponsored gas (RELAY; the global relay ceiling bounds it).

## 6. When an alert fires

1. `pnpm --filter @solvers/server cli:treasury-status`: confirm which account is low and whether charges are stuck.
2. **PLATFORM low**: Pix and agent fulfilments will start failing and stay `confirmed` (the reconcile job retries every
   30 s; nothing is lost while the float is refilled). Top it up (section 5). If it cannot be refilled soon, pause intake:
   `cli:admin set-pause entries` (admin or a guardian) stops new on-chain purchases for everyone, or turn agent payments off
   (`AGENT_PAY_ENABLED=false`) and stop offering Pix.
3. **RELAY low**: sponsored transactions fail for every user and every server send. Top it up first; it is the most urgent.
4. **Relay budget exhausted**: check `relay_log` for one wallet or IP dominating (abuse) before raising
   `RELAY_DAILY_GAS_GLOBAL`; per-wallet and per-IP quotas apply independently.
5. After topping up, rerun `cli:treasury-status`; open charges should drain within a few reconcile cycles.
