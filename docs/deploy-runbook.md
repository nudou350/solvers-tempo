# Deploy runbook

How to put Solvers on a Tempo network and on the VPS: keys, contracts, server, web, worker, first Solver. Every command,
script and infra file below exists in this repository (`infra/`, `.github/workflows/`, `contracts/script/`).

**Owner's go required.** Nothing in sections 7-10 (VPS, DNS, nginx, PM2, certbot, backups) is done without the owner's
explicit go (`docs/migration/decisions.md`, owed decision #5; the A record `solvers-tempo.wondervelop.com` exists). No
mainnet transaction and no real funds without the owner either. Moderato transactions and the public faucet are fine.

Related: `docs/treasury.md` (floats and alerts), `docs/qa.md` (tests), `docs/ci-notes.md`, `docs/architecture.md`.

## 1. Prerequisites

| Tool | Version | Note |
|---|---|---|
| Foundry | 1.8.5 | Upstream Foundry has Tempo support (`tempo = true` in `contracts/foundry.toml`, `anvil --tempo`); `tempo-foundry` is deprecated (https://tempo.xyz/developers/docs/sdk/foundry). On the dev machine: `~/.foundry/bin`. |
| Node | >= 22 | `package.json` `engines` |
| pnpm | 10.20.0 | `packageManager` field |
| Docker | any recent | deliverable verifier image, local Postgres |
| bash + `npx` | | `openzeppelin-foundry-upgrades` shells out to `bash` + `npx @openzeppelin/upgrades-core` during deploys (`OPENZEPPELIN_BASH_PATH` overrides the bash it uses; see `docs/migration/phase-2.md`) |

Networks (plan §1 T1, https://tempo.xyz/developers/docs/quickstart/connection-details):

| | Chain id | RPC | Explorer |
|---|---|---|---|
| Moderato (testnet) | 42431 | `https://rpc.moderato.tempo.xyz` | `https://explore.testnet.tempo.xyz` |
| Mainnet | 4217 | `https://rpc.tempo.xyz` | `https://explore.tempo.xyz` |
| Local | 31337 | `anvil --tempo` (`http://127.0.0.1:8545`) | none |

`contracts/foundry.toml` defines the RPC aliases `moderato`, `tempo` and `local`.

## 2. Keys and custody

Generate fresh keys per network; never reuse a key across networks. Keys are never committed (`apps/server/.keys` is
gitignored) and never printed by the CLIs. Each server key may be given as `0x` hex or as a path to a key file.

| Key | Role on-chain | Where it lives | Holds tokens? |
|---|---|---|---|
| DEPLOYER | temporary default admin during `Deploy.s.sol` only | operator's machine | yes, enough stablecoin to pay the deploy fees (sender pays in `forge script`) |
| PLATFORM (`PLATFORM_PRIVATE_KEY`) | `PLATFORM_ROLE` + `USAGE_ROLE` | API server | yes: the stablecoin float (`docs/treasury.md`) |
| RELAY (`RELAY_PRIVATE_KEY`) | **none** (fee payer only, D3) | API server | yes: pays every sponsored fee |
| VERIFIER (`VERIFIER_PRIVATE_KEY`) | `VERIFIER_ROLE` (`markPassed`, `setEval`) | API server | no (fees by RELAY) |
| Cold ADMIN | `DEFAULT_ADMIN_ROLE` (config, approve/suspend, disputes, slashes, admin delay, upgrades) | off the VPS | no: every admin call, including the accept, the admin delay and upgrades, has a sponsored `cli:admin` command (D20, X21); only the testnet shortcut `AcceptAdmin.s.sol` makes it pay its own fee |
| GUARDIAN (optional) | `GUARDIAN_ROLE` (add pause bits only, never TRANSFERS) | off the VPS | no |
| TREASURY (`TREASURY_ADDRESS`) | fee recipient (address only, cold wallet) | owner | receives fees, platform royalties, slashes |

Rules enforced by the code:

- `apps/server/src/env.ts`: with `CHAIN_ID=4217` the API refuses to start if `ADMIN_PRIVATE_KEY`, `GUARDIAN_PRIVATE_KEY` or
  `DEPLOYER_PRIVATE_KEY` is set, and requires an explicit `PAYMENT_TOKEN`. Off the local chain RELAY must differ from
  PLATFORM and from VERIFIER; the admin key must be a key of its own.
- Boot validation (`apps/server/src/chain/index.ts`, `validateChain`): RPC chain id = `CHAIN_ID`; contract code at the
  six addresses; `PAYMENT_TOKEN` decimals = `PAYMENT_TOKEN_DECIMALS`; Registry `token()` = `PAYMENT_TOKEN`; Registry
  `treasury()` = `TREASURY_ADDRESS`; PLATFORM holds exactly PLATFORM + USAGE, VERIFIER exactly VERIFIER, RELAY no role
  (no hot key may hold `DEFAULT_ADMIN_ROLE` or `GUARDIAN_ROLE`). Any problem: the API does not start.
- Admin CLIs (`apps/server/src/cli/cli-chain.ts`, `admin-guard.ts`): the RPC chain id must equal `CHAIN_ID`; mainnet only
  with `--allow-network mainnet`; on mainnet the signer key comes only from `--key-file <file>` (an `ADMIN_PRIVATE_KEY`
  in the environment is refused). Every admin transaction is signed on the admin nonce lane and its fee is paid by RELAY.

**Custody options for the default admin** (owed decision #4): a cold EOA today; a Safe later. Safe announced Tempo
support (plan T13, https://safe.global/blog/tempo-and-safe-wallet-integration). The Registry uses OpenZeppelin
`AccessControlDefaultAdminRules`, so switching custody is one 2-step transfer: `cli:admin propose <safe-address>` (current
admin), then the new admin accepts after the delay. A Safe cannot sign through `cli:admin accept` (that command signs with a
key file); its accept is a Safe transaction calling `acceptDefaultAdminTransfer()` on the Registry. Keep the GUARDIAN
separate so an emergency pause does not need the cold admin.

## 3. Funding (testnets)

Moderato fees and test balances come from the public faucet (plan T7, https://tempo.xyz/developers/docs/quickstart/faucet;
amounts are not published):

```bash
cast rpc tempo_fundAddress <address> --rpc-url https://rpc.moderato.tempo.xyz
cd scripts && npx tsx src/topup.ts                 # PLATFORM, RELAY, VERIFIER and admin keys from apps/server/.env, target 100 each
npx tsx src/topup.ts --min 500 platform relay      # only these, target 500
```

The DEPLOYER needs a stablecoin balance before step 4.1 (`forge script` pays fees from the sender in a TIP-20 chosen by
Tempo's fee-token cascade; measured in phase 2). The Moderato deploy (18 transactions) used about 132.2M gas, about 0.16
test USD. Contract creation costs `code_size × 1,000 + 500,000` gas (plan T8).

On mainnet there is no faucet: the owner funds DEPLOYER, PLATFORM and RELAY from the treasury (`docs/treasury.md`).

## 4. Contracts

All commands run in `contracts/`. Always `forge clean` right before a deploy or upgrade script: the OpenZeppelin upgrade
validator needs exactly one build-info per contract (`docs/migration/phase-2.md`).

### 4.1 Deploy (`script/Deploy.s.sol`)

Environment (from the script header):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PAYMENT_TOKEN` | yes | | TIP-20 payment token (Moderato: pathUSD `0x20c0000000000000000000000000000000000000`; mainnet: owed decision #1) |
| `TREASURY_ADDRESS` | yes | | fee recipient (a TIP-20 address is rejected) |
| `PLATFORM_ADDRESS` | yes | | gets `PLATFORM_ROLE` and `USAGE_ROLE` |
| `VERIFIER_ADDRESS` | yes | | gets `VERIFIER_ROLE` |
| `COLD_ADMIN` | yes | | final default admin; must not be zero and, off anvil, must differ from the deployer |
| `LICENSE_BASE_URI` | yes | | `tokenURI = base + tokenId`, e.g. `https://solvers-tempo.wondervelop.com/api/license/` |
| `GUARDIAN_ADDRESS` | no | none | gets `GUARDIAN_ROLE` |
| `FEE_BPS` | no | 1000 | primary-sale fee (contract cap 2000) |
| `PLATFORM_ROYALTY_BPS` | no | 500 | platform share of the transfer royalty |
| `MIN_STAKE` | no | 0 | base units |
| `MIN_PRICE` | no | 5000000 | base units (5 units of a 6-decimal token) |
| `DEPLOYMENT_NAME` | no | `solvers` | name written to the deployment file |
| `GIT_SHA` | off anvil | | 40-hex commit of the deployed source |

What the script does, in order: `Upgrades.deployUUPSProxy` (upgrade-safety validated) for `SolversRegistry`
(`initialize(deployer, 0, token, treasury, feeBps, platformRoyaltyBps, minStake, minPrice)`), `SolversLicense`
(`registry, baseURI`), `SolversCredits`, `SolversReviews` (`registry, license, credits`), `SolversEscrow`,
`SolversStaking`; then `setSatellites(license, credits, reviews, escrow, staking)`; `grantRole` PLATFORM and USAGE to
`PLATFORM_ADDRESS`, VERIFIER to `VERIFIER_ADDRESS`, GUARDIAN to `GUARDIAN_ADDRESS` if set;
`beginDefaultAdminTransfer(COLD_ADMIN)`; writes `deployments/<chainId>.json`.

```bash
forge clean
GIT_SHA=$(git rev-parse HEAD) forge script script/Deploy.s.sol --skip test --rpc-url moderato --broadcast --slow \
  --private-key <deployer key>        # the other variables exported beforehand
node script/record-deployment.mjs 42431
```

`forge script` writes the deployment file during the simulation, before any transaction exists;
`record-deployment.mjs <chainId>` then merges the broadcast tx hashes (from `broadcast/Deploy.s.sol/<chainId>/run-latest.json`)
and the real `deployBlock` into `deployments/<chainId>.json`. Commit that file: the server, web, scripts and indexer load
it by `CHAIN_ID`, and `INDEXER_START_BLOCK` defaults to its `deployBlock`.

### 4.2 Admin handover (`script/AcceptAdmin.s.sol`)

The cold admin accepts the default admin role and raises the admin-transfer delay (`ADMIN_DELAY_SECS`, default 172800 =
48 h), so any future handover is visible on-chain before it completes:

```bash
REGISTRY=<registry proxy> forge script script/AcceptAdmin.s.sol --rpc-url moderato --broadcast --private-key <cold admin key>
```

This is a plain broadcast: the cold admin pays its own fee here (decisions.md X21; on Moderato fund it from the faucet).
The accept needs a block after the schedule. Use it on testnets only; on mainnet the cold key never holds tokens, so the
same two calls go through `cli:admin` (4.7).

Only the Registry carries `AccessControlDefaultAdminRules`: the five satellites check roles and authorize upgrades through
the Registry's `hasRole`, so one admin and one admin delay govern all six contracts.

### 4.3 Verification (Sourcify on `contracts.tempo.xyz`)

```bash
forge verify-contract --rpc-url moderato --verifier sourcify --verifier-url https://contracts.tempo.xyz \
  <implementation address> src/SolversRegistry.sol:SolversRegistry
forge verify-contract --rpc-url moderato --verifier sourcify --verifier-url https://contracts.tempo.xyz <proxy address> \
  lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy
```

Repeat for the six implementations (`impls` in the deployment file) and the six proxies. Check the result at
`https://contracts.tempo.xyz/v2/contract/<chainId>/<address>` (`match` for creation and runtime). Docs:
https://tempo.xyz/developers/docs/quickstart/verify-contracts.

### 4.4 Client and repo

```bash
pnpm --filter @solvers/contracts-client generate         # ABIs from contracts/out + addresses from deployments/*.json
pnpm --filter @solvers/contracts-client generate:check   # fails when the committed files are stale
```

Never hand-edit `packages/contracts-client/src/generated`.

### 4.5 The Moderato deployment (public, 2026-10-11)

`deployments/42431.json`: Registry `0x09a82967C8C4A5a9ece332fb954C58313997BF21`, License
`0xb20C198431624b2Dd04dd6f998F87318F209c819`, Credits `0xddAC1a537944eD2f438988AdeD23E6b5636D41dF`, Reviews
`0x5a8221C883816712b9C3d54C17289c77814c0696`, Escrow `0x1d9D98e0F5656AE69150Df535BFb5dFF1F9055aE`, Staking
`0x0B2E5B1137E8ED0Aae537772330f672AACE194Bf`; deploy block 39,085,012; `minStake` 0, `minPrice` 5,000,000, fee 1000 bps,
platform royalty 500 bps; license base URI `http://localhost:3018/api/license/` until the domain is live (X20, change it
with `cli:admin set-base-uri`). All twelve contracts are verified.

### 4.6 Upgrades (`script/Upgrade.s.sol`)

All six contracts are UUPS proxies; only the Registry's default admin can upgrade any of them (decisions.md D2;
`test/Upgrade.t.sol`). The upgrade tooling (decisions.md X16) is `script/reference-build.sh`, `script/Upgrade.s.sol` and `script/record-upgrade.mjs` (tests in `test/UpgradeScript.t.sol`, whole procedure on a fresh
anvil in `script/upgrade-anvil.sh`, run by `contracts.yml`); it has not been run against Moderato yet. Each new implementation is validated by `openzeppelin-foundry-upgrades` against the build of
the commit that produced the **live** implementation (`implGitSha.<key>` after a recorded upgrade, else the
deployment's `gitSha`), not against the working tree. From `contracts/`:

1. `node script/check-layouts.mjs` must pass (storage layouts append-only; `--write` only after a reviewed append-only
   change, and commit `storage-layouts/*.json`).
2. `bash script/reference-build.sh <chainId>`: builds every source commit named in the deployment file in a temporary
   git worktree and copies its build-info to `reference-build/sha-<12 hex>/` (gitignored).
3. `forge clean` (one build-info per contract).
4. Validate only (default mode, sends nothing):
   `UPGRADE=registry,license forge script script/Upgrade.s.sol --skip test --rpc-url <rpc>` (`UPGRADE` is a comma list of
   `registry, license, credits, reviews, escrow, staking` or `all`; `UPGRADE_DATA_<KEY>` = optional calldata for
   `upgradeToAndCall`, e.g. a `reinitializer(n)` migration).
5. Upgrade:
   - **Mainnet path**: `UPGRADE_MODE=prepare … --broadcast --private-key <deployer key>` deploys the validated
     implementations (no role needed) and prints, per proxy, the new implementation and the `upgradeToAndCall` calldata.
     The default admin then sends it as a sponsored admin transaction (the cold admin holds no tokens, X21):
     `pnpm --filter @solvers/server cli:admin upgrade <key> <new implementation> [--call <UPGRADE_DATA_<KEY> hex>]`
     (dry-run, then `--yes`; see 4.7). With a Safe as admin, the Safe sends the printed calldata instead.
   - **Local chain and testnet only**: `UPGRADE_MODE=execute … --broadcast --private-key <admin key>` deploys and
     upgrades in one run (refused on chain 4217 and unless signed by the default admin).
6. After the upgrade is mined: `node script/record-upgrade.mjs <chainId> --rpc-url <rpc> [--sha <commit>]` writes the new
   `impls.<key>`, `implGitSha.<key>` and an `upgrades[]` entry into the deployment file (without `--sha` the commit is
   HEAD and `contracts/src` must be clean).
7. Verify the new implementations (4.3) and regenerate the client (4.4).

### 4.7 Mainnet admin steps (sponsored, X21)

The cold admin never holds tokens: every call below is signed by the cold key on the admin nonce lane and its fee is paid
by RELAY (`sendServerCalls({ signer: "admin", lane: "admin" })`). Each command is a dry-run by default (reads, prints who
signs, the calls and a simulation, sends nothing); `--yes` sends. On mainnet the CLI refuses to run without
`--allow-network mainnet`, refuses `ADMIN_PRIVATE_KEY` in the environment and takes the key only from `--key-file`. It
needs the server's chain settings (`CHAIN_ID=4217`, `RPC_URL`, `RELAY_PRIVATE_KEY`, the deployment) and the database
(`DATABASE_URL`: every send is journalled in `sent_txs` and indexed right away).

```bash
M="--allow-network mainnet --key-file <cold-admin.key>"
# 1. Handover (after Deploy.s.sol scheduled it to COLD_ADMIN; acceptable once the schedule has passed)
pnpm --filter @solvers/server cli:admin accept $M            # dry-run
pnpm --filter @solvers/server cli:admin accept $M --yes
# 2. Admin-transfer delay of 48 h, as AcceptAdmin.s.sol does on testnets (an increase takes effect after
#    min(new delay, 5 days); until then `admin-delay-rollback` cancels it)
pnpm --filter @solvers/server cli:admin admin-delay 172800 $M
pnpm --filter @solvers/server cli:admin admin-delay 172800 $M --yes
# 3. Upgrades: only after 4.6 steps 1-5 (check-layouts, reference build, validate, then UPGRADE_MODE=prepare)
pnpm --filter @solvers/server cli:admin upgrade license <new implementation> $M [--call <hex>]
pnpm --filter @solvers/server cli:admin upgrade license <new implementation> $M [--call <hex>] --yes
# then 4.6 steps 6-7: record-upgrade.mjs, verify, regenerate the client
```

`cli:admin upgrade` accepts `registry | license | credits | reviews | escrow | staking` (proxy from the deployment) and
refuses before sending when the new implementation has no code, is one of the deployment's proxies, is already the live
implementation, does not answer `proxiableUUID()` with the ERC-1967 implementation slot, or whose runtime code is not the
proxy's contract in the local build (`contracts/out/<Name>.sol/<Name>.json` `deployedBytecode`, immutables and the
metadata hash masked; so the License proxy can never be pointed at a Credits implementation). Run it from a checkout at
the commit `Upgrade.s.sol` prepare deployed, after `forge build` in `contracts/`. It cannot check storage layout or
upgrade safety: that is `Upgrade.s.sol`'s validation, which must have passed for the same commit first (the command prints
this reminder).

## 5. RPC and fee payer

- `RPC_URL` (and optional `RPC_WS_URL`) in the server env. Providers listed in plan T13: Alchemy (RPC/WS, no webhooks on
  Tempo), QuickNode, Chainstack; the public RPCs above work for development. The indexer polls `eth_getLogs`; the
  Moderato RPC refuses ranges above 100,000 blocks (measured in phase 3), far above `INDEXER_BLOCK_BATCH` (2000).
- Fee sponsorship is the platform's own relay inside the API (`POST /api/relay`, decisions.md D3): the RELAY key
  co-signs Tempo `0x76` transactions of signed-in wallets that touch our contracts; server-sent transactions use RELAY as
  the in-process fee payer. Caps and quotas: `RELAY_MAX_GAS_PER_TX`, `RELAY_DAILY_GAS_PER_WALLET`, `RELAY_DAILY_GAS_PER_IP`,
  `RELAY_DAILY_GAS_GLOBAL`, `RELAY_MAX_FEE_PER_GAS`, `RELAY_MAX_PRIORITY_FEE_PER_GAS` (`infra/.env.example`).
  `RELAY_ENABLED=false` answers 503 (rollback switch).
- Documented alternatives, not used by this code (plan T4, https://tempo.xyz/developers/docs/api/fee-payer): Tempo's
  hosted Fee Payer API (Tempo Console key; signups limited) and the public testnet sponsor
  `https://sponsor.moderato.tempo.xyz`; Privy native sponsorship (`sponsor: true`, needs TEE wallets and prepaid credits,
  plan T11).

## 6. Server, worker and web environment

- API, worker and CLIs: copy `infra/.env.example` to `apps/server/.env` (on the VPS: the shared `.env`), fill it; the
  template is kept in sync with `apps/server/src/env.ts` by a test. The worker needs no chain keys (it never builds a chain
  context); it needs the database, `SUBMISSIONS_DIR`, `PUBLISHED_DIR`, the embeddings settings and `TELEGRAM_BOT_TOKEN`.
- Web: `apps/web/.env.example` (`NEXT_PUBLIC_CHAIN_ID` must equal the API's `CHAIN_ID`; `NEXT_PUBLIC_*` are inlined at
  build time; `NEXT_PUBLIC_ALLOW_DEV_WALLET` only on test networks, always refused on 4217).
- Persistent folders outside any release: `SUBMISSIONS_DIR` (creator ZIPs), `PUBLISHED_DIR` (published packages),
  `DELIVERABLES_DIR` (guarantee deliverables). Without them the server writes under `./data` inside the release.
- `ADMIN_WALLETS`: wallets that review submissions on the site. Reviewing on the site signs nothing on-chain.
- Upload limits (env): `SUBMISSION_MAX_ZIP_BYTES` 52428800 (50 MB), `SUBMISSION_MAX_UNZIPPED_BYTES` 157286400 (150 MB),
  `SUBMISSION_MAX_FILES` 2000, `SUBMISSION_MAX_PENDING` 3, `SUBMISSION_MAX_PER_DAY` 5; 10 MB per file (code constant).
- Verifier image: `docker build -t solvers-tempo-react-test agents/frontend-react/verifier` (distinct from the previous app's `solvers-react-test` on the shared host) (`VERIFIER_IMAGE`, `VERIFIER_MODE=docker`).

## 7. Database (VPS)

- Database `solvers_tempo` on the VPS PostgreSQL 16 cluster (port 5433, pgvector; D13). Create a dedicated user
  (VPS_GUIDE §4) and `CREATE EXTENSION vector`. The development machine never touches 5433: local work uses the
  `solvers-tempo-pg` container on 5546 (X1, `docs/qa.md`).
- First migration: the API runs pending migrations at boot (`apps/server/src/index.ts`); to run them alone:
  `pnpm --filter @solvers/server db:migrate`. The baseline is `apps/server/src/db/migrations/0000_baseline.sql`.
- Migrations share the database with the release still running: keep every new migration backward compatible (additive).

## 8. VPS layout, PM2, nginx, TLS, deploys

The host files are in `infra/` (overview and first-time order in `infra/README.md`). None of them runs by itself: no
workflow deploys on push, and every script is started by hand by the owner (owner's go, see the top of this file).

| File | What it is |
|---|---|
| `infra/ecosystem.config.cjs` | PM2 apps (D13), one instance each, logs in `/var/www/solvers-tempo/logs`: `solvers-tempo-api` (`backend/dist/index.js` with `--env-file=.env`, `PORT=3018`, 127.0.0.1; exactly one instance because MPP replay protection and the lane queues are in memory; `kill_timeout` 10 s), `solvers-tempo-web` (`frontend/start.mjs`, `PORT=4018`, `HOSTNAME=127.0.0.1`, `API_INTERNAL_URL=http://127.0.0.1:3018`), `solvers-tempo-worker` (`infra/worker-run.sh`, no port, no chain keys, `kill_timeout` 20 s to checkpoint) |
| `infra/worker-run.sh` | Worker start command: `exec nice -n 10 node --env-file=.env ./dist/worker/index.js` (PM2 has no nice option; `exec` keeps the PID so SIGTERM reaches the worker) |
| `infra/nginx/solvers-tempo` | Site for `solvers-tempo.wondervelop.com`: port 80 redirects to HTTPS (the redirect sits in `location /` so certbot's HTTP-01 renewals still match); `/` → web (4018); `/api`, `/mcp` (no buffering, 300 s read), `/oauth`, `/.well-known`, `/webhooks`, `/preview`, `/health` → API (3018); `location = /api/creator/submissions` with `client_max_body_size 60m`, `proxy_request_buffering off`, 300 s timeouts and the POST-only zone `solvers_tempo_upload` (6 r/min per IP); the review photo upload `location ~ ^/api/agents/[^/]+/reviews/mine/images$` with `client_max_body_size 6m` (the API accepts 5 MB images), same zone and proxy settings as `/api/`; the rest keeps 2 MB; `/api/auth/` on the strict `solvers_tempo_auth` zone; `/_next/static/` without any `limit_req`, cached a year on success only. Every zone, map and upstream name starts with `solvers_tempo_` (nginx names are global); rejections answer 429. nginx sets only HSTS and nosniff; the CSP is the app's |
| `infra/setup-vps.sh` | One-time host preparation, run on the VPS as `deploy`; dry-run without `--yes`; idempotent. Creates `/var/www/solvers-tempo/{releases,shared/{submissions,packages,deliverables},keys,logs}`, the role `solvers_tempo_user` and database `solvers_tempo` on PostgreSQL 16 port 5433 with `vector` (password only in `shared/db.env`, chmod 600), `shared/.env` (generated `JWT_SECRET` and `SERVER_KEK`, Moderato defaults, key-file paths under `keys/`) and `shared/web.env`. Touches no nginx, certificate, PM2 or other project |
| `infra/deploy.sh` | Ships `git archive HEAD` (never the working tree) to `$DEPLOY_HOST:/var/www/solvers-tempo/releases/<sha>`; dry-run without `--yes`. Refuses a commit without a public `deployments/<chainId>.json`, a `shared/.env` missing `SUBMISSIONS_DIR`/`PUBLISHED_DIR`/`DELIVERABLES_DIR`/`AGENTS_DIR`/`CHAIN_ID`/`DATABASE_URL`, and `NEXT_PUBLIC_CHAIN_ID` different from `CHAIN_ID`. Installs, builds the packages, API and web (`NEXT_PUBLIC_*` from `shared/web.env`), builds the verifier image, runs the migrations from the new release, waits for uploads in progress, switches the `app`/`backend`/`frontend`/`agents` symlinks, reloads (or first-starts) the three PM2 apps, then watches them ~30 s (`/health` on 3018, `/` on 4018, no restarts); any failure after the switch rolls back to the previous release. Keeps the active, previous and newest other release. `DEPLOY_HOST` (`deploy@<vps>`) is required |
| `infra/manifest.json` | Project metadata (VPS_GUIDE convention), copied to `/var/www/solvers-tempo/manifest.json` by each deploy |
| `infra/.env.example` | Every API/worker variable (kept in sync with `apps/server/src/env.ts` by a test) |

First time, in this order (details in `infra/README.md`):

1. Contracts deployed, verified and handed over (§4); `deployments/<chainId>.json` and the regenerated client committed.
2. DNS: `A` record of the domain → the VPS.
3. `bash setup-vps.sh` (dry-run), then `bash setup-vps.sh --yes` on the VPS; fill `shared/.env` (treasury, `ADMIN_WALLETS`,
   Telegram, Privy, Pix) and `shared/web.env`; copy the three key files into `/var/www/solvers-tempo/keys/` (chmod 600).
   Never put `ADMIN_PRIVATE_KEY` there.
4. Ports: `ss -tln | grep -oE '127.0.0.1:[34][0-9]{3}|\*:[34][0-9]{3}' | sort -u` must not list 3018 or 4018 (a busy port
   only shows as a PM2 restart loop).
5. **TLS before enabling the site** (the site references the certificate files, so `nginx -t` fails until they exist):
   `sudo certbot certonly --nginx -d solvers-tempo.wondervelop.com`. Renewal is automatic (VPS_GUIDE §6).
6. nginx: copy `infra/nginx/solvers-tempo` to `/etc/nginx/sites-available/`, link it into `sites-enabled/`,
   `sudo nginx -t && sudo systemctl reload nginx`. `/` answers 502 until the first deploy.
7. First deploy from a clean checkout of the commit to ship: `bash infra/deploy.sh`, then `bash infra/deploy.sh --yes`;
   `pm2 save` once the three apps are online.
8. Checks: §9.

Later deploys: `bash infra/deploy.sh --yes` from the commit to ship, or the manual workflow below, only after `ci.yml` is
green for that commit and any contract deploy or upgrade it depends on is done. Migrations run from the new release while
the old one still serves: keep them additive.

- `deploy.sh` never changes nginx: a change to `infra/nginx/solvers-tempo` is copied by hand (dated backup of the live
  file), then `sudo nginx -t && sudo systemctl reload nginx`.
- A change to an app block of `ecosystem.config.cjs` needs `pm2 delete <name>` and
  `pm2 start /var/www/solvers-tempo/app/infra/ecosystem.config.cjs --only <name>`, then `pm2 save` (`pm2 reload` does not
  re-read the file).
- Reloading the single API process cuts open uploads; `deploy.sh` waits up to `UPLOAD_WAIT` (120 s) while a
  `shared/submissions/<id>/package.zip*` was written in the last 10 s. The worker resumes from its last finished file.
- Manual rollback to a release still on disk: point the four symlinks at it (as `activate` in `deploy.sh` does) and
  `pm2 reload solvers-tempo-api solvers-tempo-web solvers-tempo-worker`. Migrations are not rolled back.

### Workflows (`.github/workflows/`)

All three have `permissions: contents: read`. `actions/checkout`, `actions/setup-node` and `webfactory/ssh-agent` are
pinned by commit; `foundry-rs/foundry-toolchain@v1` is still a tag (Foundry itself is pinned to `v1.8.5`).

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | pull requests, pushes to `master`, manual | install, `generate:check` (builds `contracts/out`, fails when the generated client is stale), build, typecheck, migrate a `pgvector/pgvector:pg16` service on port 5546 (`TEST_DATABASE_URL`), `pnpm test` (unit, DB and `anvil --tempo` tests) |
| `contracts.yml` | changes under `contracts/**`, manual | `forge fmt --check`, build with sizes, tests (ci profile), gas snapshot, storage layouts, `script/e2e-anvil.sh`, `script/upgrade-anvil.sh` |
| `deploy.yml` | **`workflow_dispatch` only** (no push, merge or schedule trigger) | runs only from `master` with the typed confirmation `deploy solvers-tempo`, inside the `production` environment (the owner sets required reviewers there, so every run waits for approval); install, build, typecheck, then `bash infra/deploy.sh --yes` over SSH |

`deploy.yml` reads two secrets of the `production` environment and nothing else: `VPS_SSH_KEY` (private key of the
`deploy` user, loaded by `webfactory/ssh-agent`) and `VPS_KNOWN_HOSTS` (the VPS host key line from
`ssh-keyscan -t ed25519 <vps-ip>`, fingerprint checked on the VPS with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`;
the job fails if it is empty, so the runner never trusts on first use). Application secrets (`shared/.env`,
`shared/web.env`, keys) live only on the VPS. Contract deploys, upgrades and admin calls never run in CI.

### Backups

`/opt/deploy/backup.sh` dumps every PostgreSQL database daily and tars `/var/www/<project>` weekly (VPS_GUIDE §9).
For this project, exclude `shared/submissions` (re-uploadable) and archived package versions from the weekly tarball, delete
ZIPs of submissions rejected more than 30 days ago, and alert when submissions + packages exceed 20 GB (the patch the
previous app prepared). Editing `backup.sh` is a shared-host change: owner's go first.

## 9. After a deploy

```bash
curl -fsS https://solvers-tempo.wondervelop.com/health
curl -fsS https://solvers-tempo.wondervelop.com/api/config          # chainId, contracts, fee 1000 bps, royalty, minPriceUnits, pix, agentPay
curl -s -o /dev/null -w '%{http_code}\n' https://solvers-tempo.wondervelop.com/api/creator/submissions   # 401 without a session
pm2 list                                                              # three processes online
pm2 logs solvers-tempo-worker --lines 30 --nostream                   # no errors; the Telegram bot polling
cd scripts && API_URL=https://solvers-tempo.wondervelop.com npx tsx src/smoke-catalog.ts   # spends nothing
pnpm --filter @solvers/server cli:treasury-status                     # floats above the alert threshold
```

## 10. First Solvers

1. Platform Solvers (free, database only, `PLATFORM_AGENTS`): `pnpm --filter @solvers/server cli:publish --no-chain`.
2. Paid team packages on dev/demo chains: `pnpm --filter @solvers/server cli:publish [slug ...]` (registers, prices, caps,
   approves on the admin lane, records the eval on the verifier lane; creator keys are generated locally and never on mainnet).
   Set `PUBLIC_API_URL` to the public domain first: metadata URIs carry it, and `cli:publish` refuses a localhost URL on Moderato.
3. Third-party creators: `pnpm --filter @solvers/server cli:invite create --email <address>` (no extra `--` with pnpm), the
   creator uploads the ZIP, an `ADMIN_WALLETS` reviewer approves on the site (signs nothing), the creator co-signs one
   sponsored publication batch, then `pnpm --filter @solvers/server cli:approve <slug|submissionId> [--dry-run] [--key-file <file>]`
   signs `approveAgent` with the cold admin key (fee by RELAY). Updates of an approved Solver need no `cli:approve`.
4. Kill switch: `pnpm --filter @solvers/server cli:suspend <slug> [--reason "..."]` (database `platform_status` + `suspendAgent`
   on-chain), `--resume` to undo. Creator guide: `docs/creator-guide.md`.
5. Telegram: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` in the env. The bot is polled by `solvers-tempo-worker`
   (`getUpdates`; it must have no webhook); creators link themselves through `POST /api/creator/telegram-link` and
   `/link <code>` (alias `/vincular`) in the bot; `cli:invite set-chat <wallet> <chatId>` is the admin shortcut. Without the
   token the link route answers 503 `telegram_unavailable`.

## 11. Privy (owner's dashboard)

Listed in `docs/migration/phase-5.md`; nothing is changed by us:

1. App id → `NEXT_PUBLIC_PRIVY_APP_ID` (web) and `PRIVY_APP_ID` (server) (reuse vs new app: owed decision #6).
2. Allowed origins: `http://localhost:3001` and `https://solvers-tempo.wondervelop.com`.
3. E-mail login on.
4. EVM embedded wallet on login: set in code (`createOnLogin: "users-without-wallets"`).
5. Tempo chains: set in code (`supportedChains`, `defaultChain`).
6. Verification key → `PRIVY_VERIFICATION_KEY`.
7. "Return user data in an identity token" on (needed for the e-mail link).
8. Optional: disable confirmation modals (code sets `showWalletUIs: false`).
9. Raw-hash signing is used.

## 12. Mainnet checklist (inert until every item is decided)

1. Payment token chosen (pathUSD, OUSD or USDC.e; owed #1) and set explicitly as `PAYMENT_TOKEN`.
2. Royalty percentages confirmed (owed #2); `PLATFORM_ROYALTY_BPS` at deploy.
3. Accountant's answer on Pix (owed #3, `docs/payments-open-questions.md`); Pix stays off on mainnet in the code until then.
4. Admin custody decided (owed #4); cold key or Safe never on the VPS; GUARDIAN separate.
5. Domain and VPS confirmed (owed #5).
6. Privy app decided and configured (owed #6).
7. Fresh keys; PLATFORM and RELAY funded from the treasury; `FLOAT_LOW_BALANCE_UNITS` set for real volumes.
8. Deploy with `GIT_SHA`, record, verify, then `cli:admin accept` and `cli:admin admin-delay 172800` (4.7, sponsored; never
   `AcceptAdmin.s.sol`, which makes the cold key pay), commit `deployments/4217.json`, regenerate the client.
9. `PIX_SIMULATE`, `FAUCET_ENABLED` and the dev wallet are forced off by the code on 4217; confirm `/api/config`.
10. A dedicated RPC provider for production (plan T13).
