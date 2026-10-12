# QA

How to test Solvers locally and on Moderato: contract checks, monorepo tests, the local QA stack and every e2e/smoke
script. Each script prints PASS/FAIL per check and exits non-zero on failure; a skipped check fails the run unless
`E2E_ALLOW_SKIP=1`. CI is described in [`ci-notes.md`](ci-notes.md).

## 1. Databases (never the other projects' ones)

Local Postgres is the Docker container **`solvers-tempo-pg`** (`pgvector/pgvector:pg16`, `127.0.0.1:5546`, user `solvers`;
decisions.md X1):

| Database | Used by |
|---|---|
| `solvers_tempo` | dev API (`apps/server/.env`) |
| `solvers_tempo_test` | `*.db.test.ts` (`TEST_DATABASE_URL`) |
| `solvers_tempo_qa` | local QA API (`apps/server/.env.qa`), recreated by `bootstrap.ts` and `qa-reset.ps1` |

On the development machine never point anything at `127.0.0.1:5433`, 5543 or 5544 (other projects' databases with real data).

## 2. Contracts (`cd contracts`)

```bash
forge test                                   # unit, matrices, fuzz (256 runs)
FOUNDRY_PROFILE=ci forge test                # fuzz 2000, invariants 256 x 64 (as CI)
forge snapshot --check --no-match-path 'test/invariant/*' --no-match-test 'Fuzz|fuzz'
node script/check-layouts.mjs                # UUPS storage append-only (--write only after a reviewed change)
forge build --sizes --skip test --skip 'test/**'   # every contract < 24,576 bytes (test helpers excluded)
bash script/e2e-anvil.sh                     # fresh anvil --tempo on port 8547 (ANVIL_PORT): validated deploy + sponsored flows
```

`e2e-anvil.sh` deploys with `Deploy.s.sol`, accepts the admin handover, then checks: register with stake, approve, purchase
(buyer pays exactly the price, creator price − 10%, treasury 10%), transfer with royalty (exact 5% + 5%),
`purchaseLicenseFor` from the float, escrow create → `markPassed` → release, an atomic self-paid `0x76` batch
`[approve, purchaseLicense]`, and a batch whose second call reverts (the approve is rolled back). It prints
`ALL E2E CHECKS PASSED`.

## 3. Monorepo tests

```bash
pnpm build && pnpm typecheck && pnpm test                         # root, via turbo
cd apps/server && node --env-file-if-exists=.env.test --import tsx --test test/trial.test.ts   # one server test
cd packages/shared && node --import tsx --test src/money.test.ts                                # one package test
```

- DB tests (`apps/server/test/*.db.test.ts`) skip unless `TEST_DATABASE_URL` points at a **disposable, migrated** database
  (`solvers_tempo_test` on 5546). Turbo passes `TEST_DATABASE_URL` and `ANVIL_BIN` through.
- Chain tests (`packages/chain`, server `*-anvil*` tests, web `wallet-send.test.ts`) spawn `anvil --tempo` and skip when
  it is absent; `ANVIL_BIN` / `FORGE_BIN` override the binaries (default `~/.foundry/bin`).
- Authenticated route tests need no Privy and no chain: `createApp([])` + `signSession(wallet)` from `auth/jwt.ts`.
- The web test script also runs `scripts/check-messages.mjs` (en and pt message files complete).

## 4. Local QA stack (`anvil --tempo` + QA API)

```bash
docker start solvers-tempo-pg                                   # the Postgres container (5546)
cd scripts && npx tsx src/bootstrap.ts --seed                   # chain, contracts, .env.qa, database, seed
cd apps/server && node --env-file=.env.qa --import tsx src/index.ts   # QA API on 127.0.0.1:3028 (another terminal)
```

`bootstrap.ts [--seed] [--skip-deploy]`:

1. starts a detached `anvil --tempo --port 8545` (reused if chain 31337 already answers there);
2. `forge clean`, `Deploy.s.sol` (deployer = anvil dev key 0, PLATFORM 1, VERIFIER 2, cold admin 3, treasury
   `0x…dEaD`, `MIN_STAKE` 0) and `AcceptAdmin.s.sol`; writes `deployments/31337.json` (`--skip-deploy` reuses it);
3. writes `apps/server/.env.qa` (gitignored): API on 127.0.0.1:3028, database `solvers_tempo_qa`, anvil keys (RELAY = dev
   key 8, no role), submissions inline, simulated verifier, guarantees open (min sales/rating 0), agent payments on with a
   random MPP secret;
4. recreates and migrates `solvers_tempo_qa` (never `solvers_tempo` or `solvers_tempo_test`);
5. `--seed`: `cli:publish --no-chain` (criador-de-solvers) and `cli:publish frontend-react ui-design` on anvil.

`powershell -File scripts/qa-reset.ps1` recreates and migrates only `solvers_tempo_qa` (it refuses any other
`DATABASE_URL`) and empties `apps/server/.qa-data`; stop the QA API first. It does not touch the chain; re-seed with
`cd apps/server && node --env-file=.env.qa --import tsx src/cli/publish.ts --no-chain`.

Point a script at the QA API with `API_URL=http://127.0.0.1:3028 SERVER_ENV_FILE=../apps/server/.env.qa`; `e2e-creator`,
`qa-race` and `qa-worker-resume` default to it.

## 5. Scripts (`cd scripts`)

Common environment (`scripts/src/env.ts`): `API_URL` (default `http://127.0.0.1:3018`), `CHAIN_ID` (default: the API's
`/api/config`), `RPC_URL`, `DEPLOYMENTS_FILE`, `SERVER_ENV_FILE` (default `apps/server/.env`; the scripts read the admin
and platform key paths from it), `SCRIPT_KEYS_DIR` (default `scripts/.keys`, gitignored), `E2E_SLUG` (default
`frontend-react`), `ADMIN_KEY` (admin key when `SERVER_ENV_FILE` has no `ADMIN_PRIVATE_KEY`).

| `npm run` | File | What it proves | Needs |
|---|---|---|---|
| `e2e:purchase` | `e2e-purchase.ts` | Direct-wallet purchase: SIWE, purchase intent (ledger row + `[approve, purchaseLicense]`), batch through `POST /api/relay`, confirm; exact token movements, NFT owner, API mirror, ledger | |
| `e2e:api` | `e2e-api.ts` | Store API through `@solvers/api-client` with the shared zod schemas and the cookie session | |
| `e2e:full` | `e2e-full.ts` | Buy → MCP recognises the license → on-chain review → transfer with royalty → guaranteed task (verified deliverable, `markPassed`, preview, release, download) → dispute → admin refund → memories | `GUARANTEE_MIN_SALES=0`, `GUARANTEE_MIN_RATING=0`, `VERIFIER_MODE=simulated` or `docker`, an admin wallet in `ADMIN_WALLETS` with its key in `SERVER_ENV_FILE` or `ADMIN_KEY` |
| `e2e:mcp` | `e2e-mcp.ts` | Connector as Claude/ChatGPT: 401 discovery, DCR, SIWE consent + memory key, PKCE S256, tools and free-trial limits, refresh rotation, invalid token | |
| `e2e:creator` | `e2e-creator.ts` | Creator flow stages 1-9: invite/profile, ZIP to review, security negatives, review, co-signed publication + `cli:approve`, purchase and use, new version, on-chain bypass blocked, kill switch | local QA stack only; fresh database; `FROM_STAGE=N`, `ONLY_STAGES=1,2` |
| `e2e:supply` | `e2e-supply.ts` | License cap: `SoldOut` at fill time with no token moved, cap only rises, raise then buy; the test Solver is suspended at the end | admin key |
| `e2e:pix` | `e2e-pix.ts` | `pix-intermediated`: simulated payment, `purchaseLicenseFor` from the float, webhook replays (also in parallel) give one transaction | server off mainnet with `PIX_SIMULATE`; the same `MP_WEBHOOK_SECRET` in the server and the script for the signed-webhook checks |
| `e2e:transfer` | `e2e-transfer.ts` | Transfer with royalty: exact creator + platform shares of the original price; a plain ERC-721 transfer reverts `RoyaltyNotPaid` | |
| `e2e:agent-pay` | `e2e-agent-pay.ts` | Agent buys over HTTP 402 (MPP, `mppx` client, pull mode): 402 challenge, forged credential refused, exact debit, no fee, license minted to the agent, then MCP use; second purchase 409 | `AGENT_PAY_ENABLED=true`, `MPP_SECRET_KEY` |
| `e2e:agent-use` | `e2e-agent-use.ts` | Agent key login (two calls), tools, memory, refresh; buys directly on-chain through the relay when it has no license | `E2E_AGENT_KEY` optional |
| `smoke:catalog` | `smoke-catalog.ts` | Every listed Solver with a trial activates and its knowledge base answers; spends nothing | any server, `API_URL` |
| `smoke:creator` | `smoke-creator.ts` | The free Solver Creator through agent login: step 1, `validate_package`, template, knowledge, memory calibration | |
| `publish:test-agent` | `publish-test-agent.ts` | One test Solver through the real creator flow on any network, then bought and used | worker running (or `SUBMISSIONS_INLINE=true`), admin wallet + key |
| — | `qa-race.ts` | Simultaneous uploads respect the open-submission limit; simultaneous review decisions: only one counts | after `e2e-creator` |
| — | `qa-worker-resume.ts` | Killing the worker mid-ingestion resumes from the last finished file without duplicate chunks | QA API with `SUBMISSIONS_INLINE=false` plus a separate worker (`node --env-file=.env.qa --import tsx src/worker/index.ts`), creator invited (`ONLY_STAGES=1 npx tsx src/e2e-creator.ts`) |
| `eval` | `eval.ts` | Grades `agents/<slug>/evals` answers into `evals/report.json` (no model, no API key) | |
| `bootstrap`, `topup` | | Local stack (section 4); faucet top-ups (`docs/treasury.md`) | |

Run any of them with `npx tsx src/<file>` or `npm run <name>`.

## 6. Moderato e2e

1. Fund the server wallets: `cd scripts && npx tsx src/topup.ts`.
2. Start the dev API against Moderato with an overrides file that is not committed:
   `cd apps/server && node --env-file=.env --env-file=<overrides> --import tsx src/index.ts`, where the overrides set
   `AGENT_PAY_ENABLED=true`, `MPP_SECRET_KEY`, `MP_WEBHOOK_SECRET`, `SUBMISSIONS_INLINE=true`, `GUARANTEE_MIN_SALES=0`,
   `GUARANTEE_MIN_RATING=0`.
3. `cd scripts && npx tsx src/<script>.ts` (default `API_URL` is the dev API on 3018). Explorer links:
   `https://explore.testnet.tempo.xyz/tx/<hash>`.

Before publishing on a shared network set `PUBLIC_API_URL` to the public domain: `cli:publish` refuses a localhost URL on
Moderato, and the site's co-signed flow writes `PUBLIC_API_URL` into metadata URIs. Results of the last runs:
`docs/migration/phase-6.md`.

## 7. Browser e2e

Playwright suite in `e2e-browser/` ([`browser-e2e-plan.md`](browser-e2e-plan.md)): it clicks through the site like a
person and verifies every result outside the screen (receipts, events, balance deltas, `ownerOf`, the Solana
transaction, the API mirror). On demand only: no schedule, no CI job.

```bash
pnpm e2e:browser                       # mode A: local QA stack, dev wallet, every scenario
E2E_PROD_EMAIL=<owner e-mail> pnpm e2e:browser --prod   # mode B: the public testnet site, the owner's Privy account (short subset)
pnpm e2e:browser purchase              # any Playwright filter or flag: a file name, -g "scenario 3", --headed
pnpm e2e:browser --fresh               # mode A after a new bootstrap.ts --seed (stop the QA API first)
pnpm e2e:browser --keep                # mode A: leave the QA API and the web dev server running afterwards
```

Report: `e2e-browser/report/summary.md` (and `.json`): PASS/FAIL per test, what was checked on chain and every
transaction with its explorer link (Tempo explorer on Moderato; the bare hash on the local chain, which has no explorer;
Solana Explorer for devnet). HTML report with traces, screenshots and videos of failures:
`cd e2e-browser && npx playwright show-report report/html`. `E2E_TELEGRAM=1` with `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ADMIN_CHAT_ID` also sends the summary to Telegram.

**Prerequisites**

- Once: `pnpm install` and `cd e2e-browser && npx playwright install chromium`.
- Mode A: Docker (`solvers-tempo-pg`), Foundry (for `bootstrap.ts`). The runner reuses what already answers and starts
  the rest: `anvil --tempo` + contracts + `.env.qa` + `solvers_tempo_qa` (bootstrap, when the chain or the contracts are
  missing), the QA API on 3028 and the web dev server on 3001 with `NEXT_PUBLIC_ALLOW_DEV_WALLET=1`, proxied to the QA
  API (never the dev database). It appends `SOLANA_PAY_ENABLED`, `SOLANA_CLUSTER=devnet` and `SOLANA_PAY_KEYPAIR` to
  `.env.qa` when bootstrap dropped them (restart the QA API after that). It checks that the RPC, the API and the site
  serve the same chain, clears the faucet cooldowns of the QA database and creates three test Solvers through the real
  creator flow (`publish-test-agent.ts`): one at 5 USD, one sold out (cap = sales, set by its creator), one suspended
  (`cli:suspend`); they are kept in `e2e-browser/.cache/qa-fixtures.json` and reused while still valid.
- Scenario 5 spends 5 test USDC per run from the devnet payer `scripts/.keys/solana-devnet-payer.json`: check
  `cd scripts && npm run solana:balances`; USDC from https://faucet.circle.com (Solana Devnet, 20 per 2 h), SOL from
  https://faucet.solana.com.
- Mode B: when there is no valid saved session (the first run, and any run more than 24 hours after the last login:
  the API session lasts 24 h) it opens a visible browser, types the owner's e-mail and waits up to 15 minutes for the
  OWNER to type the e-mail code in that window (the code is never typed by the suite or an agent). The session is saved
  in `e2e-browser/.auth/prod.json` (gitignored). It holds Privy's refresh token, a login to the owner's embedded wallet:
  treat it as a credential, never commit, print or share it, and delete it when mode B is not needed. The runner tops
  the owner's wallet up from the Moderato faucet. Traces and videos are off in mode B (they would store the live
  session); failure screenshots stay on and may show the owner's e-mail and wallet address.

**Scenarios (mode A)**

| # | Test | Verified outside the screen |
|---|---|---|
| 1 | Home, search and every paid Solver page in pt and en (also mode B) | pages 200, no console errors or failed requests, prices = `/api/agents` = `Registry.getAgent().price` |
| 2 | Dev-wallet sign-in, account menu, test funds, sign-out | `/api/auth/me` 401/200/401; faucet tx from a PLATFORM_ROLE key, exact Transfer and balance, balance shown in the menu |
| 3 | Buy with the wallet balance | `LicensePurchased` (agent, buyer, payer, price, purchase id of the charge), fee floor to the treasury and the rest to the creator (Transfer logs and balance deltas), fee paid by RELAY, buyer paid exactly the price, `ownerOf`, `/api/me/licenses`, My library |
| 4 | Buy with Pix (simulated) | same, sent by the PLATFORM key (`purchaseLicenseFor`), fee by RELAY, buyer spent nothing |
| 5 | Buy with USDC on Solana devnet | QR decoded from the image pixels = "Open in wallet" link (recipient, mint, amount, reference, memo); paid from the test payer; Solana tx success, reference among its keys, recipient +price and payer -price from the tx metadata, memo = charge id, the API charge names that signature; Tempo fulfilment as in 4 |
| 6 | Transfer (resell) from My library | `RoyaltyPaid`: creator and platform shares of the original price, paid by the old owner; `ownerOf` = new owner; no sale counted; old owner's access, licenses and library empty |
| 7a | Guaranteed task from the checkout; plan delivered through the connector; approved on /guarantees | `EscrowCreated` (purchase id, total, fee), `escrowOf` milestones = the offer; milestone Passed with a deliverable hash; `MilestonePaid` with the fee split and balance deltas |
| 7b | Delivered milestone disputed on /guarantees | `MilestoneUpdated(Disputed)` by the buyer, reason hash = sha256(criterion + reason), escrow Disputed, no token moved |
| 8 | Install page -> connector OAuth consent in the browser -> MCP | connector address = config; DCR + PKCE (wrong verifier and code replay refused); `list_my_solvers` lists the license; `activate_solver` lifetime; bad token 401 |
| 9 | Review from My library | `ReviewSubmitted` (author, rating, sha256 of the text, token id), `LicenseReviewed`; text on the Solver page; no license -> 403 |
| 10 | Creator panel; admin review queue | the panel links the creator's Solver, its all-time sales (dashboard API) = Registry `totalSales`, the 30-day number on screen = the API; admin queue for an `ADMIN_WALLETS` wallet, "Page not found" and 403 for others |
| 11 | Sold out, suspended, expired Pix and Solana charges, someone else's charge | checkout blocked with no ledger row and no sale; 30-min lifetime; expired on the server (charges moved past their deadline in the QA database), late Pix payment refused, "create a new one"; another wallet gets 404 |

**Mode B** (one account, serial): scenarios 1, 2 and 10 (read only), then 3 + 6 and 4 + 6: it buys the two cheapest
Solvers the account does not own (wallet balance, then Pix) and resells each license to a throwaway address, so the
account ends owning the same licenses it started with: at the end, any license gained in the run (also after a failed
test) is resold to a throwaway address and the set of license ids is compared with the start. It skips the scripts'
test Solvers (`e2e-`/`qa-` slugs) and Solvers the owner created, and stops with a clear message when the account
already owns every purchasable paid Solver. Real Solvers' sales counters go up (accepted: test network).

## 8. Known limits

- The API allows 5 open agent-pay orders per IP per 15 minutes: back-to-back `e2e-agent-pay` runs answer 429.
- `qa-worker-resume` needs the worker as a separate process (it is not part of the inline QA API).
- `e2e-creator` targets the local QA stack only (it uses the anvil admin key and the QA database).
- Moderato keeps the test Solvers created by these runs (`e2e-<random>` slugs); `e2e-supply` suspends its own.
- On a local anvil the MPP payment's pre-broadcast simulation charges the sender the fee in `eth_call`, so
  `e2e-agent-pay` funds the agent with the price plus 1 unit of slack; the exact debit is still checked.
- The API limits its costly routes (`/api/tx`, intents, charges, search, faucet) to 20 requests per minute per IP; in
  mode A every browser reaches it from 127.0.0.1 through the Next dev proxy, so the browser e2e runs serially by default
  (`E2E_WORKERS=2` or more makes the app's own `/api/tx/confirm` retries hit 429).
