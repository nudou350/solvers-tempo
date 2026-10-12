# Phase 7 — Docs + infra (not deployed)

Date: 2026-10-11. Plan sections: §6 phase 7, D13 (infra names/ports), D2 (UUPS), X16, X21. Nothing was deployed: no
ssh, no PM2/nginx/DNS/certbot change, no push, no GitHub API call.

## What was built

| Area | What |
|---|---|
| Docs | New: `docs/architecture.md`, `economics.md`, `royalties.md`, `payments.md`, `agent-payments.md`, `treasury.md`, `deploy-runbook.md`, `qa.md`. Rewritten for Tempo: `docs/README.md` (index), `agent-login.md`, `license-cap.md`, `ci-notes.md`, `concepts-guide.md` + `guia-conceitos.md`; `payments-open-questions.md` keeps questions only. Edited, not rewritten: `creator-guide.md` + `criador-solvers.md` (phase 6: QA on anvil, network selection by `CHAIN_ID`/`RPC_URL`, admin keys and `--key-file`; phase 7 review fixes: PM2 names `solvers-tempo-api`/`solvers-tempo-worker` and the Registry's `minPrice`). Root `README.md`, `CLAUDE.md` (stack, layout, commands, non-obvious rules for Tempo) and `AGENTS.md` (Solidity/Foundry rules). `PACKAGE_SPEC.md` + `.pt-BR.md`: chain sections only (publication, `updateVersion` with version-scoped evals D6, `priceUsdc` meaning D14, `royaltyBps`, supply cap, routes). Deleted: `docs/plano-i18n.md` (historical) and `docs/deploy-criador-solvers.md` (folded into the runbook §6-10). |
| Design | `design/` mockups (26 screens, `mock-data.js`, `solver-lib.js`, `WEB_SPEC.md`): Tempo network, USD stablecoin, ERC-721 license, `0x…` addresses/hashes, explorer links; secondary-market sections replaced by "transfer" with the royalty disclosure; Pix kept. The PNGs in `design/screenshots/` still show the old content (binary, unused by the app). |
| Infra (D13 + VPS_GUIDE) | `infra/ecosystem.config.cjs` (PM2 `solvers-tempo-api` 127.0.0.1:3018, `solvers-tempo-web` 127.0.0.1:4018, `solvers-tempo-worker`), `infra/nginx/solvers-tempo` (`solvers-tempo.wondervelop.com`; `/` → web, `/api` `/mcp` `/oauth` `/.well-known` `/webhooks` → API; zones `solvers_tempo_api|web|auth|upload`; `/_next/static/` unlimited and cached a year on success only; HSTS + nosniff, the CSP stays the app's), `deploy.sh` and `setup-vps.sh` (print-only unless `--yes`; never run by CI), `worker-run.sh`, `manifest.json`, `infra/README.md` (order of operations; certbot before enabling the site; confirm ports with `ss -tln`). `nginx -t` passes in a local `nginx:1.24` container. Ports 3018/4018 are free in VPS_GUIDE's table. |
| CI | `.github/workflows/ci.yml` (push/PR: install, build, typecheck, test with a pgvector service on 5546 and the test DB migrated, Foundry 1.8.5 for anvil, `generate:check`), `contracts.yml` (fmt, build, sizes, tests, snapshot, layouts, anvil e2e, upgrade e2e), `deploy.yml` (`workflow_dispatch` only, master only, typed confirmation, `production` environment, secrets `VPS_SSH_KEY` + `VPS_KNOWN_HOSTS`). All `permissions: contents: read`; every action is pinned by commit except `foundry-rs/foundry-toolchain@v1` (major tag: its commit could not be determined offline; pin it when the workflows are next touched with network access). |
| Upgrades (X16) | `contracts/script/Upgrade.s.sol` (validate → prepare → execute; validates each new implementation with `validateUpgrade` against a reference build of the deployed `gitSha` from `deployments/<chainId>.json`; refuses a live implementation that differs from the deployment file, execute on mainnet, and non-admin callers), `reference-build.sh`, `record-upgrade.mjs`, `upgrade-anvil.sh` (whole procedure on a fresh anvil: ALL UPGRADE CHECKS PASSED), `test/UpgradeScript.t.sol`. HEAD validated against the Moderato deployment's commit `0c876b8` offline (no RPC). |
| Admin (X21) | Sponsored admin lane for every cold-key step on mainnet (the cold key holds no tokens): `cli:admin accept` (default-admin transfer), `cli:admin admin-delay <seconds>` / `admin-delay-rollback` (`changeDefaultAdminDelay` / `rollbackDefaultAdminDelay` on the Registry, the only contract with admin rules), `cli:admin upgrade <contract> <impl> [--call <hex>]` (`upgradeToAndCall` after `Upgrade.s.sol` validate + prepare; refuses no code, deployment proxies, the live implementation, a wrong `proxiableUUID` and runtime code that is not the proxy's contract in the local build, immutables and metadata hash masked). All with `--key-file <file> --allow-network mainnet [--yes]`. Tests: `test/admin-args.test.ts`, `test/admin-cli.db.test.ts` (anvil: delay scheduled, rolled back, in force after the wait; License proxy upgraded to a fresh implementation, ERC-1967 slot checked; a Credits implementation refused for the License proxy; admin's token balance unchanged and the receipt's fee payer is RELAY). |

## Gate

- `pnpm build && pnpm typecheck && pnpm test`: 11/11 turbo tasks; server 1243 tests, 1236 pass, 0 fail, 7 skipped (paid
  packages absent); web 56; scripts 8; shared, chain, api-client, contracts-client green.
- `forge fmt --check`, `forge build`, `forge snapshot --check` (flags of `contracts.yml`), `forge test` 472/472.
- `node scripts/purge-check.mjs`: exit 0 (only `docs/migration/00-inventory.md`, plus the commented lockfile allow-list of
  X33: Privy's peer-declaration lines and one generic base-58 encoding package that Privy's WalletConnect dependencies
  install; see `scripts/purge-check.mjs`).
- `bash -n infra/*.sh`; `nginx -t` in a local `nginx:1.24` container; workflow YAML parses.
- `apps/server/data/` (runtime packages/submissions) is now gitignored; the e2e test packages that phase 6 committed were
  removed from the index (they are test data with no secrets and remain in the history of `aa57b22`).

## Review

Independent reviewer sub-agent (no deploy/push path, no secrets in files). Fixed:
- nginx rejected review photos between 2 and 5 MB (global 2 MB body limit) → a dedicated location with 6 MB.
- `contracts/.gas-snapshot` out of sync → regenerated with the CI flags after the last `.sol` edit.
- `cli:admin upgrade` accepted any UUPS implementation (e.g. a Credits implementation for the License proxy) → the
  on-chain runtime code must match the local build of that contract (immutables and metadata masked); tests on anvil.
- Stale PM2 names (`solvers-api`/`solvers-worker` belong to the old app on the shared VPS), the old minimum-price wording,
  dead `NEXT_STEPS.md`/`FRONT_PLAN.md` references, the docs index, X16's text, this note's claims about pinned actions.
- Mockups still offered a secondary market and "proven"/"independently tested" performance → transfer chip, "teste interno da
  equipe", per-Solver creator share; the purge check also matches the Portuguese verb stem of that feature.
- Nits: an unconditional sponsorship assertion in the admin test, `record-upgrade.mjs` paths and `--sha` check,
  `setup-vps.sh` password on stdin and idempotent creation, nginx cipher directive, worker node resolved at start.

## Old repo check

`?? LICENSE`, `?? texts.json`, HEAD `1348d92911cf1f089aa062d08771a29a47f74efd` (unchanged).
