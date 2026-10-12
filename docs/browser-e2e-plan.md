# Browser e2e: plan

Status: plan approved, not implemented (2026-10-11; owner's decisions in section 7). Hand this file to the agent that
implements it, together with `docs/qa.md` and `docs/solana-pay.md`. Goal: a test run that clicks through the site like a person, end to end,
with no human in the loop, and checks every transaction on Tempo (and Solana) instead of trusting the screen.

## 1. What exists today

- API-level e2e scripts (`scripts/src/e2e-*.ts`, `docs/qa.md`): they verify the chain well, but never open the site.
- Local QA stack: API on `.env.qa` with a fresh `solvers_tempo_qa` database (`bootstrap.ts`, `qa-reset.ps1`), Moderato
  testnet, published test Solvers.
- Dev wallet in the web app (`apps/web/src/lib/wallet/dev.ts`): a key in localStorage, only when the build sets
  `NEXT_PUBLIC_ALLOW_DEV_WALLET=1`, never on mainnet. Production has it off; production login is Privy e-mail.
- Chain helpers to reuse: `scripts/src/lib/flows.ts` (agentDetail, chainAgent, ownerOf, licenseOf, eventsOf,
  mintedTokenId, expectedRoyalty, waitFor), `scripts/src/lib/solana.ts` (pay a Solana Pay URL, balances, account keys).
- No Playwright or Puppeteer in the repo.

## 2. Tool and layout

- **Playwright** (`@playwright/test`, Chromium headless) in a new workspace package `e2e-browser/`. It imports the
  scripts helpers for chain checks.
- Each test: drive the UI → read the transaction from the page (explorer link `href`, charge id in the URL) → verify on
  chain with viem/@solana/kit → verify the API mirror.
- On failure: trace, screenshot, video, the browser console and the failed requests. Report: HTML + JSON with every
  transaction link.
- One wallet per test (fresh dev-wallet key funded from the faucet), so tests run in parallel and never depend on
  each other.

## 3. Environments

| Mode | Login | Data | When |
|---|---|---|---|
| **A. Local QA** (default) | dev wallet injected into localStorage | `solvers_tempo_qa`, reset before the run | every change, before each deploy |
| **B. Public testnet site** (`https://solvers-tempo.wondervelop.com`) | the owner's Privy account (see below) | real catalog | when the owner asks, a short subset |

Mode B login (owner's decision):
- Account: the owner's Privy e-mail login (`E2E_PROD_EMAIL`, never committed). Its embedded wallet is
  `0x6e3e7bf4047d70f853b7c26acee15eb8387663f8`, which is also in `ADMIN_WALLETS` (admin pages are reachable).
- The e-mail code comes from the owner. The test opens a visible (headed) browser, types the e-mail, then **waits for
  the owner to type the code in that browser window** (or to send it in chat, if the operator's rules allow typing it
  for them). The agent never reads the owner's mailbox.
- After the first login, save the Playwright `storageState` to `e2e-browser/.auth/prod.json` (gitignored, never
  committed or printed) and reuse it until Privy expires the session; only then ask for a new code.
- Before the run, fund that wallet with test stablecoin from the Moderato faucet (`fund()` in `scripts/src/env.ts`;
  `faucetEnabled` is true on the testnet site).
- One wallet means mode B runs serially, and a wallet can hold only one licence per Solver (409 `already_owned`). So
  each purchase test buys a Solver this account does not own yet, and the resale test (scenario 6) then transfers that
  licence to a throwaway address. The account ends every run owning the same licences it started with, and the next
  run can buy again. If the account already owns every paid Solver, the run stops with a clear message.
- Never use this account in mode A or in parallel runs.

## 4. Scenarios and what each verifies on chain

| # | Flow in the browser | Verified outside the screen |
|---|---|---|
| 1 | Home → catalog → search → Solver page (pt and en) | pages answer 200, no console errors, prices match `/api/agents` and `chainAgent().price` |
| 2 | Login (dev wallet / Privy test account) → account menu → logout | session cookie/JWT valid on `/api/me` |
| 3 | Buy with wallet balance | tx receipt success, `LicensePurchased` event (buyer, agent, price), fee split: creator +90%, treasury +10% (balance deltas), fee paid by RELAY, `ownerOf(tokenId) == buyer`, licence in "Minha biblioteca" and `/api/me/licenses` |
| 4 | Buy with Pix (simulated) → "simulate payment" | `purchaseLicenseFor` sent by PLATFORM, same event and split, buyer spent no stablecoin, licence in the library |
| 5 | Buy with USDC on Solana → decode the QR image (must equal the deep link URL) → pay it with the test payer | Solana tx: success, reference present, recipient ATA +price, memo = charge id; Tempo `purchaseLicenseFor` by PLATFORM; licence in the library |
| 6 | Resell / transfer the licence to a second wallet | royalty paid: creator 5% + platform 5% of the original price, `ownerOf` = new owner, old owner loses access |
| 7 | Guarantee: create a guaranteed task from the checkout | escrow created on chain with the milestones and amounts of the offer; then release or dispute through the UI where possible |
| 8 | Install page → connector OAuth consent in the browser → MCP call with the issued token | `list_my_solvers` returns the licence bought in 3 |
| 9 | Library: review a Solver | review on chain (licence required), shown on the Solver page |
| 10 | Creator panel and admin review queue (read and navigate) | pages load for the creator and for an `ADMIN_WALLETS` wallet; no on-chain approval (that needs the cold key) |
| 11 | Negative paths | sold out / paused Solver blocks checkout; expired Pix and Solana charges show "create a new one"; a second wallet cannot see someone else's charge |

## 5. Funds and limits

- Tempo test stablecoin: faucet per wallet, unlimited for testing.
- Solana devnet USDC: Circle faucet, 20 USDC per 2 h. Scenario 5 runs once per run with the cheapest licence; mode A
  uses a 5 USDC test Solver.
- Mode B on the public site raises real Solvers' sales counters (as the API scripts already do). Accepted by the owner:
  it is a test network.

## 6. Phases

| Phase | Content | Estimate |
|---|---|---|
| 1 | `e2e-browser/` package, Playwright, dev-wallet injection + funding, report; scenarios 1 and 2 | ~2 h |
| 2 | Purchases: scenarios 3, 4, 5 with full chain checks (incl. QR decode) | ~4 h |
| 3 | Scenarios 6, 7, 9, 11 | ~4 h |
| 4 | Scenario 8 (OAuth in the browser), 10; mode B with the Privy test account; `pnpm e2e:browser` + `--prod` | ~3 h |
| 5 | Run on demand: `pnpm e2e:browser` (mode A) and `pnpm e2e:browser --prod` (mode B); summary with transaction links at the end (and to Telegram if configured) | ~1 h |

Each phase ends with the suite green twice in a row (no flaky test) and an independent review of the test code.

## 7. Owner's decisions (2026-10-11)

1. **Login on the public site**: the owner's account (`E2E_PROD_EMAIL`); the owner provides the e-mail code at
   login time (details in section 3).
2. **Sales counters**: real Solvers are fine; no hidden QA Solver.
3. **Schedule**: only on demand. No nightly run, no CI job.

## 8. Rules for the implementing agent

- Work only in this repository; never write in the old reference repository.
- Read `CLAUDE.md` / `AGENTS.md`, `apps/web/AGENTS.md` (the installed Next.js differs from training data) and
  `docs/qa.md` first.
- Never point anything at `127.0.0.1:5433`; local databases are in the `solvers-tempo-pg` container on 5546.
- Keys and session files stay out of git (`.keys/`, `e2e-browser/.auth/`); never print secret values.
- Local web dev runs on port 3001 (`pnpm --filter @solvers/web dev`); the local dev database has stale approvals, so
  mode A uses the QA stack (`.env.qa`, `bootstrap.ts`, `qa-reset.ps1`).
- Do not push and do not deploy unless the owner asks; commit with clear English messages.
- Report per scenario: PASS/FAIL, the transaction links (Tempo and Solana explorers) and what was checked on chain.
