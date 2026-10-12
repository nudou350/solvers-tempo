# Phase 8 — Purge + final verification

Date: 2026-10-11. Plan sections: §6 phase 8, §7 verification, mission definition of done.

## End-to-end runs (all green)

### Contracts on anvil

| Check | Result |
|---|---|
| `contracts/script/e2e-anvil.sh` | PASS — purchase split 90/10, royalty exactly 5% + 5%, float purchase, escrow release, atomic batch, reverting batch rolled back |
| `contracts/script/upgrade-anvil.sh` | PASS — six proxies validated against the reference build, both guards refuse, cold-admin upgrade recorded |

### Local anvil + QA API (port 3028, disposable DB `solvers_tempo_qa` on 5546)

| Script | Result |
|---|---|
| e2e-creator | PASS 107/107 (incl. stage 7 royalty on the original price and stage 9 kill switch) |
| e2e-purchase / e2e-transfer / e2e-full / e2e-mcp / e2e-supply | PASS 14/14, 8/8, 14/14, 14/14, 8/8 |
| e2e-pix (with `MP_WEBHOOK_SECRET`) | PASS 11/11, 0 skipped |
| e2e-agent-pay / e2e-agent-use | PASS 14/14, 8/8 |
| smoke-catalog / smoke-creator / qa-race | PASS 2/2, 10/10, 2/2 |
| qa-worker-resume | PASS 3/3 (worker killed at 20/402 files, resumed to 402/402, 1205 chunks, 0 duplicates) |

### Moderato testnet (dev API on 3018; deployment `deployments/42431.json`)

| Definition-of-done item | Script | Result | Evidence (explore.testnet.tempo.xyz) |
|---|---|---|---|
| Fresh test Solver (co-signed publication + `cli:approve`) | publish-test-agent | PASS 7/7 | [register](https://explore.testnet.tempo.xyz/tx/0x1099bd817de0071d37b071dd8c739b12b8c73845e902a72fbeaac22708afcb2b), [approve](https://explore.testnet.tempo.xyz/tx/0x91d4d58bfb6a75306b2d23e66d988d1a9dd30d5f9909f913f4f7cdc1188e4cd1), [purchase](https://explore.testnet.tempo.xyz/tx/0xbea9827a76ab95e6ba652fe10491337e5fac8512b8bbfc6dac9acf522a12baf2) |
| Sponsored direct-wallet purchase (fee payer RELAY; buyer paid exactly 19, creator 17.1, treasury 1.9) | e2e-purchase | PASS 14/14 | [tx](https://explore.testnet.tempo.xyz/tx/0x2105ee5820b85869e3f50def14a5033480f131e89d59769e4e0ebbbe0cc8c999) |
| Simulated Pix + webhook replay (4 replays → 1 transaction; license listed at once) | e2e-pix | PASS 11/11 | [fulfilment](https://explore.testnet.tempo.xyz/tx/0xacb58c0097049ae3901f2fce4e8920a4c1ed7aa0992383750c4e1bf3a850ed51) |
| Royalty exactly 5% + 5% of the original price (0.95 + 0.95 of 19); plain transfer reverts `RoyaltyNotPaid` | e2e-transfer | PASS 8/8 | [tx](https://explore.testnet.tempo.xyz/tx/0xa3e088007982b3933ae1a64708c2b21f7bd8947bbc22aa65ba8fbb6d61bde1ca) |
| Review, transfer, escrow release, dispute, refund | e2e-full | PASS 14/14 | [review](https://explore.testnet.tempo.xyz/tx/0x7a99d0460af16065767d1a9088e3b36e6ff80581958ddde5b696c3c45a1ad32c), [transfer](https://explore.testnet.tempo.xyz/tx/0x87309802fa5d0e07509526b85060c04ab46a72b026905de0a86f185ee2981710), [escrow](https://explore.testnet.tempo.xyz/tx/0x4b03c64ded2be7e4fb59456ae917700418ac17d931a722ac7f3895b7b237ad8b), [release](https://explore.testnet.tempo.xyz/tx/0xb709685395b599c5ac87baedd594c12cebd396fcb1c59f6c627c9f3960828f7c), [dispute](https://explore.testnet.tempo.xyz/tx/0xf7cc3a619ef0a40edbbdee6bb8ec2278fae7aef47871b8b2c8c13c4304ed24fe), [refund](https://explore.testnet.tempo.xyz/tx/0xe0d824de84b1c182ff82a3d311f20245999be5bbae54ca772d3c001912c2663f) |
| SoldOut (no token moved); cap only rises | e2e-supply | PASS 8/8 | [cap](https://explore.testnet.tempo.xyz/tx/0xbc0f1a4d2d9b262269fabae81eba1a556eeee05958a2a5034c41a5cfb714f385), [purchase](https://explore.testnet.tempo.xyz/tx/0xcf8025e644689897fabf5552c3d1b2aebda696866affa23bac44f6ea9e939955) |
| Agent-pay (MPP) purchase + MCP use (exact debit, no fee for the agent, second purchase 409) | e2e-agent-pay | PASS 14/14 | [settlement](https://explore.testnet.tempo.xyz/tx/0x20195dc6f73c373aa1e1c9487a41fd243f0b1ce814c28e6d1a099eadd6678481), [mint](https://explore.testnet.tempo.xyz/tx/0x06fa2b15a712e7ae7af331b5593cc13a351866589935d59358de83a8de4299c7) |
| Agent login, use, direct purchase | e2e-agent-use | PASS 8/8 | [tx](https://explore.testnet.tempo.xyz/tx/0x14bb6558564b26f156431aa8a9d0c9e59ba72244d6358f1e2db22665faac3254) |
| MCP connector (OAuth DCR + PKCE, tools) | e2e-mcp | PASS 14/14 | |
| Store API / catalog | e2e-api, smoke-catalog | PASS 9/9, 2/2 | [tx](https://explore.testnet.tempo.xyz/tx/0xd5ca1b1ee8b5c18405a7b10529dfa3c467e01478e10c57fc4b767badf5fc7f93) |
| Suspend / resume (`cli:suspend`, sales and activation refused while suspended, both work after resume) | cli + check | PASS 9/9 | [suspend](https://explore.testnet.tempo.xyz/tx/0x4eeb692c66443b734c160a934c1a770c65de57ff2f5b12681c615dac41cba931), [resume](https://explore.testnet.tempo.xyz/tx/0x5292dc2a3efdc6c0a5b5f52b14cfd242c5532937d76f5b24dfb820f79e5c4e28) |

Web flow: phase 5 ran the real web app (:3001) against the API (:3018) on Moderato with the dev wallet: SIWE sign-in and a
sponsored license purchase (token #24, buyer debited exactly the price, fee paid by RELAY). The MCP connector was exercised
over HTTP exactly as Claude/ChatGPT call it (OAuth DCR + PKCE + tools, `e2e-mcp`, `e2e-agent-*`); adding the connector to
a real Claude or ChatGPT account is an action on the owner's third-party account and was not done.

Commands: `docs/qa.md`; logs of these runs are outside the repo (session scratchpad).

Test Solvers left on Moderato by the runs: `e2e-bcb32c`, `e2e-4da1b2`, `e2e-4f8f46` (listed), the e2e-supply ones
(suspended).

## Purge and dependency audit

- `node scripts/purge-check.mjs` (word-boundary mode over every tracked and untracked, non-ignored file): exit 0; the only
  matching file is `docs/migration/00-inventory.md` (allowed). The plan's token list is covered (assembled from fragments
  in the script), plus the Portuguese stems of the dropped secondary-market feature. Exact, commented exceptions in the
  script: one phrase in `agents/frontend-react/knowledge/formularios-e-validacao.md` (the generic web term for in-page
  links; editing it would change a paid package's hash and invalidate its measured eval, phase 6) and the lockfile lines
  below. Literal (substring) mode, reported for X2: 473 files / 4033 lines, essentially substrings of ordinary words
  (`display`, `split`, ...) in CSS/HTML and code; it is informational only.
- Every `package.json`: no dependency on the previous chain's packages, `web3.js`, the x402 packages or the dropped
  privacy-withdrawal package.
- `pnpm-lock.yaml`: none of those packages is installed. Two documented exceptions (X33, X35), allowed line by line in
  `scripts/purge-check.mjs` with comments:
  1. Privy's `@privy-io/react-auth` declares optional peer dependencies on the previous chain's SDK packages; pnpm
     records those declarations as text in the lockfile, but `autoInstallPeers: false` + the `x402: "-"` override keep
     them uninstalled, and `apps/web/next.config.ts` stubs them in the bundle.
  2. A generic base-58 encoding package (and its `base-x` helper) is installed as a transitive dependency of Privy's
     WalletConnect/Reown packages (X35). It is not chain-specific code we use; the allow-list names it and its current
     parents, so any new dependent fails the check.
- Keys: no `.env*` (other than the two templates), key file or `moderato.json` was ever committed; the seven Moderato
  testnet private keys do not appear in any commit (checked with `git grep` over every revision).
- `apps/server/data/` is gitignored; test packages committed in `aa57b22` (test data, no secrets) were removed from the
  index in phase 7.

## Plan §10 VERIFY items

| # | Item | Status |
|---|---|---|
| 1-6, 10 | Tempo facts, precompiles, sponsorship, TIP-20 permit, receive policies, forge/anvil Tempo mode | closed in `phase-2.md` |
| 8, 9 | viem relay API, per-key nonces, batch simulation, `eth_getLogs` limits, `logIndex` in 0x76 receipts | closed in `phase-3.md` |
| 11 | viem SIWE helpers | closed: `createSiweMessage`/`parseSiweMessage`/`verifySiweMessage` from `viem/siwe` (viem 2.57.4) used by `packages/api-client` and `apps/server/src/auth/siwe.ts`; tests `packages/api-client/src/index.test.ts` (message + signature recovery) and `apps/server/test/siwe.test.ts`, `agent-auth.db.test.ts` |
| 7 | Privy signs a 0x76 transaction on Tempo | **open (owner action)**: the SDK path is confirmed from the installed typings and a Privy-style signer produces the identical transaction to a viem key account (`apps/web/test/unit.test.ts`), but a live Privy login + signature needs the owner's Privy app configured (`phase-5.md`, dashboard list) |

## What could not run

- Live Privy login and signing (VERIFY 7): needs the owner's Privy app (no dashboard changes are ours to make).
- Real Mercado Pago charges and refunds: no credentials; Pix ran simulated (`PIX_SIMULATE`), the webhook HMAC path with a
  local secret.
- A real Claude/ChatGPT account with the connector installed (third-party account): the MCP connector was exercised over
  HTTP exactly as those clients call it.
- Mainnet anything (forbidden by the mission); the mainnet config stays inert until the payment token is chosen.

## Gate

- `pnpm build && pnpm typecheck && pnpm test`: 11/11 turbo tasks green — server 1243 tests (1236 pass, 0 fail,
  7 skipped because the paid packages are absent from this repo), web 56 + `check-messages` (2090 keys in en and pt),
  scripts 8, shared 51, api-client 9, chain 18, contracts-client 3.
- Contracts: `forge fmt --check`, `forge build`, `forge snapshot --check`, `forge test` 472/472; storage layouts
  unchanged against the committed ones (`script/check-layouts.mjs`); anvil e2e + upgrade e2e above. `forge coverage`
  (invariants excluded): 100% of lines in every contract under `src/`; statements 90-100%, branches 50-100% (the lowest
  is `SolversSatellite` branches, 2/4).

## Old repo check

`git -C ../solver status --porcelain` = `?? LICENSE`, `?? texts.json`; `git -C ../solver log -1 --format=%H` =
`1348d92911cf1f089aa062d08771a29a47f74efd` — identical to the start. Nothing was pushed (the new repo has no remote) and
nothing was deployed.

## First deployment (2026-10-11, on the owner's explicit go)

- Host: the shared VPS (`/var/www/solvers-tempo`), `https://solvers-tempo.wondervelop.com` (Let's Encrypt, auto-renew),
  PM2 `solvers-tempo-api` (127.0.0.1:3018), `-web` (127.0.0.1:4018), `-worker`; database `solvers_tempo` on the VPS's
  PostgreSQL 16 (pgvector). The previous app on the same host was not touched (still answering).
- Network: Moderato testnet (chain 42431), the phase-2 contracts; License base URI set to
  `https://solvers-tempo.wondervelop.com/api/license/`
  ([tx](https://explore.testnet.tempo.xyz/tx/0xa8ecfceee699f70716a9415def7c3a88c1ee7374f67b9f8d4ecfcda3f57771a5)).
- Catalog: the eight sold Solvers published on-chain (co-signed registration + admin approval + eval), the platform
  Solver database-only, image cards on Cloudinary. The admin key was copied to the VPS only for that command and deleted
  afterwards; the VPS holds only the PLATFORM, RELAY and VERIFIER testnet keys (and the demo creators' keys).
- Privy: a new app "Solvers Tempo" (separate from the previous app): allowed origins `https://solvers-tempo.wondervelop.com`
  and `http://localhost:3001`, e-mail login only, identity token on, verification key from the app's JWKS. The test
  wallet (`NEXT_PUBLIC_ALLOW_DEV_WALLET=1`) stays enabled on this testnet until the owner confirms the Privy login.
- Left for the owner: `ADMIN_WALLETS` (site review), a Telegram bot of its own, Mercado Pago credentials (Pix simulated
  meanwhile).
- Smoke tests against the public domain: `smoke-catalog` 6/6, `e2e-purchase` 14/14 (sponsored purchase), `e2e-mcp`
  14/14; the Privy sign-in dialog opens (e-mail).
