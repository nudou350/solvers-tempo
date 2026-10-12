# Phase 1 — Bootstrap

Date: 2026-10-10. Plan section: §6 phase 1.

## What was done

1. `git init -b master` in a new directory (fresh history, no remote).
2. **Selective copy** from the read-only old repo (`solver` @ `1348d92`) by explicit include prefixes + explicit drop regexes over
   `git ls-files` (so ignored files such as keys and env files were never candidates). Of the 1,340 tracked files, 1,007 were
   copied and 333 were not; the untracked `LICENSE` was copied too (the untracked `texts.json` was not). Not copied: the old
   program and its build files, the generated old client, the old chain package, `.agents`, `scripts/chain`, `docs/teste-manual`,
   all old DB migrations (fresh baseline in phase 4), every file of the dropped features (the secondary license market, private
   withdrawals, the cross-chain checkout, x402) in server, web, shared, scripts, docs and design, `pix/credit.ts` (D10),
   `infra/.env.example` (`.env*` rule) and `.github/workflows/*` (rewritten in phase 7, `deploy.yml` as `workflow_dispatch` only).
   Renames at copy time: `docs/agentes-login.md` → `docs/agent-login.md`, `docs/licencas-limitadas.md` → `docs/license-cap.md`,
   `TxErrorNotice.tsx` → `apps/web/src/components/ui/TxErrorNotice.tsx`. The full file-level list is
   `docs/migration/00-inventory.md`.
3. After the review, the copied `infra/*` files were **removed** again: `infra/deploy.sh` deploys to the live production host of
   the old app, so keeping it was a hazard. Phase 7 rewrites `infra/` from the old repo (read-only reference) and `VPS_GUIDE.md`.
   `scripts/qa-reset.ps1` and `scripts/src/e2e-creator.ts` still target the old project's QA database (port 5544); both now start
   with a guard that throws, and phase 6 retargets them to 5546.
4. Root config: `package.json` (`solvers-tempo`, pnpm 10.20.0, node >= 22, turbo ^2.11.5), `pnpm-workspace.yaml` (apps, packages,
   scripts; `contracts/` is not a pnpm package), `turbo.json` (`agentGuidance: false`, `test` passes `TEST_DATABASE_URL` and
   `ANVIL_BIN` through strict env mode), `tsconfig.base.json` (unchanged), `.gitignore` (rewritten), `.gitattributes`, `LICENSE`.
5. New `README.md`, `CLAUDE.md`, `AGENTS.md` (Solidity/Foundry/viem/Tempo rules).
6. `docs/migration/00-inventory.md`, `decisions.md`, `progress.md`, this note; `scripts/purge-check.mjs` (builds its token list
   from fragments so it does not match itself).
7. Stub packages `@solvers/chain` and `@solvers/contracts-client` (one export + one test each) so the workspace resolves.
8. Dependencies of the previous chain, x402, the private-withdrawal SDK and the old signature library were removed from
   `apps/server`, `apps/web` and `scripts` `package.json` at copy time; their `build`/`typecheck`/`test`/`dev` scripts are parked as
   `port:*` (with a `//` note) until the phase that ports them (server 4, web 5, scripts 6), so turbo skips them and root
   `pnpm dev` does not start unported apps. `@solvers/shared` lost only its two dropped re-exports; its full port is phase 3a.
   Web dev port changed to 3001.

## Known breakage carried into later phases (expected, parked code)

- `apps/web/src/components/account/Licenses.tsx` still imports the old path of `TxErrorNotice` (moved to `components/ui/`): phase 5.
- The indexer's old secondary-market mirror file keeps its old name (see the inventory, `apps/server/src/indexer`); phase 4 keeps
  only its license-row helpers and renames it.
- `apps/server` `port:build` copies `src/db/migrations`, which does not exist until the phase-4 baseline migration.
- pnpm 10 ignored the build scripts of `onnxruntime-node`, `esbuild`, `keccak` and others (same as the old repo); phase 4 must
  confirm the local embeddings still load or add `onlyBuiltDependencies`.

## Verified facts used in this phase

- Turborepo `agentGuidance` (root-only option, default `true`; when an AI agent is detected turbo maintains a managed block in the
  root `AGENTS.md`; `false` stops future updates but does not delete an existing block): read from the installed package docs
  `node_modules/turbo/docs/reference/configuration.mdx` (turbo 2.11.7), also published at
  https://turborepo.dev/docs/reference/configuration#agentguidance. Measured: the first turbo run (before `turbo.json` existed)
  wrote a block into `AGENTS.md`; the file was then replaced by the project's own `AGENTS.md`, and later runs did not touch it.

## Measured

| Check | Result |
|---|---|
| Tooling | node v22.23.1, pnpm 10.20.0, Docker 28.5.1; Foundry not installed at the start (installed for phase 2) |
| `pnpm install` | 855 packages resolved; peer warning `use-sync-external-store` vs React 19 (via Privy → wagmi) |
| `pnpm build` | 4/4 tasks (shared, api-client, chain, contracts-client) |
| `pnpm typecheck` | 7/7 tasks |
| `pnpm test` | 6/6 tasks; shared 24/24, chain 1/1, contracts-client 1/1 |
| Purge check (word-boundary) | ~165 files still match (expected: PORT files not yet ported) + 88 forbidden lockfile entries (X3) |

## Review

Independent reviewer sub-agent on the staged diff: no blockers; 9 should-fix and 7 nits. Fixed: removed the copied `infra/*`;
guarded the two QA scripts on port 5544; `.gitignore` patterns (`**/deployments/31337.json`, local broadcasts, `*.keypair.json`,
`design/Solver.bundle.html`); this note and the purge script made purge-clean; CLAUDE.md royalty/decimals wording aligned with D15
and D14; AGENTS.md database rule scoped to the dev machine; X4 recorded; inventory reclassified (lockfile note, unchanged
configs as KEEP, CLAUDE.md as PORT, per-package notes) and expanded to full file-level tables; parked `dev` scripts.
Accepted as-is: code comments are still Portuguese in copied files (ported per area in phases 4-6); AGENTS.md cites the
`generate` script that phase 3 adds.

## Old repo check

`git -C ..\solver status --porcelain` → `?? LICENSE`, `?? texts.json`; `git -C ..\solver log -1 --format=%H` →
`1348d92911cf1f089aa062d08771a29a47f74efd` (identical to the start).
