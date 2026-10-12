# Migration progress

Plan: the approved plan, outside this repository (path in `CLAUDE.local.md`; the spec, read it in full before resuming).
Decisions: `docs/migration/decisions.md`. Inventory: `docs/migration/00-inventory.md`. One note per phase: `phase-N.md`.

Old repo snapshot (must stay identical; re-check at the end of every phase):
`git -C <old repo> status --porcelain` = `?? LICENSE` + `?? texts.json`;
`git -C <old repo> log -1 --format=%H` = `1348d92911cf1f089aa062d08771a29a47f74efd`.

## Status

| Phase | Status | Commit |
|---|---|---|
| 1 Bootstrap | done | "Phase 1: bootstrap solvers-tempo from the reference repo" |
| 2 Contracts | done; deployed and verified on Moderato | "Phase 2: Solidity contracts …" + "Phase 2: Moderato deployment …" |
| 3 Chain client + shared | done | "Phase 3: viem chain client, generated contracts client, shared types …" |
| 4 Server | done | "Phase 4: server on Tempo …" |
| 5 Web | done | "Phase 5: web app on Tempo …" |
| 6 Packages, evals, scripts | done | "Phase 6: solver packages, scripts and e2e on Tempo …" |
| 7 Docs + infra | done | "Phase 7: documentation, infra, CI and upgrade tooling …" |
| 8 Purge + final verification | done | "Phase 8: final verification …" |

## How to resume

1. Read the plan, `decisions.md`, the latest `phase-N.md` and this file.
2. Verify the old repo snapshot above.
3. `pnpm install && pnpm build && pnpm typecheck && pnpm test` must be green before starting the next phase; for contracts
   `cd contracts && forge test` (Foundry 1.8.5 in `~/.foundry/bin`).
4. Parked packages: `apps/server` (phase 4), `apps/web` (phase 5), `scripts` (phase 6) have `port:*` scripts; rename them
   back to `build|typecheck|test|dev` when their phase ports them.
5. Each phase ends with: all checks green, `phase-N.md`, an independent reviewer sub-agent on the phase diff (fix real
   findings), a commit with a clear English message, this file updated, old repo re-verified.
6. Testnet keys: `apps/server/.keys/moderato.json` (gitignored; deployer, platform, relay, verifier, admin, treasury,
   guardian), funded from the Moderato faucet on 2026-10-11.

## Live (2026-10-11)

`https://solvers-tempo.wondervelop.com` on the Moderato testnet, deployed with `bash infra/deploy.sh --yes` from the
repo root (VPS `/var/www/solvers-tempo`, PM2 `solvers-tempo-api|web|worker`, DB `solvers_tempo` on the VPS's PG16).
Working and checked: Privy e-mail login (new app "Solvers Tempo", owner confirmed), account menu on phones, the
catalog (9 Solvers; 8 sold on-chain, image cards), sponsored purchases, the MCP connector over HTTP, simulated Pix,
license metadata on the new domain. Since 2026-10-11 also Solana Pay (USDC on Solana devnet -> licence on Tempo,
`docs/solana-pay.md`; e2e-solana-pay 14/14 on the public domain) and the project's own Telegram bot. The test wallet is turned off in production. `ADMIN_WALLETS` = the owner's Privy
wallet `0x6e3e7bf4047d70f853b7c26acee15eb8387663f8`.

## Next (owner's list)

1. **Telegram**: done 2026-10-11 (@Solvers_tempo_notification_bot, token + chat id in `shared/.env`).
2. **Mercado Pago**: test credentials (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) in `shared/.env`, webhook URL
   `https://solvers-tempo.wondervelop.com/webhooks/mercadopago` in the Mercado Pago panel, `PIX_SIMULATE=false` to use
   real test charges. Pix stays off on mainnet until `docs/payments-open-questions.md` is answered by the accountant.
3. **GitHub**: create the repository (private), add the remote and push; then the `production` environment with
   required reviewers and the secrets `VPS_SSH_KEY` + `VPS_KNOWN_HOSTS` for the manual `deploy.yml`.
4. **Real connector test**: add `https://solvers-tempo.wondervelop.com/mcp` as a connector in Claude / ChatGPT and run
   a Solver end to end.
5. **Decisions owed** (`decisions.md`): mainnet payment token; royalty percentages; accountant on Pix; admin custody
   (cold EOA or Safe); Privy production mode (development mode caps the app at 150 users); the previous app's future on
   the shared VPS; weekly backup exclusions; whether credits should grant access.
6. **Mainnet** (only after 5): contracts per `docs/deploy-runbook.md` §4 with fresh keys, admin handover
   (`cli:admin accept`, `admin-delay 172800`), explicit `PAYMENT_TOKEN`, Privy in production mode.

## Open items (resolved)

- X3 → X33 (Privy's previous-chain/x402 packages no longer installed; peer declarations remain as text) and X35.
- viem pin → X33 (workspace viem for Privy).
- X16 → `contracts/script/Upgrade.s.sol` + `cli:admin upgrade` (phase 7).
- X21 → `cli:admin accept` / `admin-delay` on the sponsored admin lane (phases 4 and 7).
