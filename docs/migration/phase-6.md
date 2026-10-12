# Phase 6 — Packages, evals, scripts

Date: 2026-10-11. Plan sections: §3.5 (scripts/agents inventory), §6 phase 6, §7 verification.

## What was built

| Area | What |
|---|---|
| Solver packages | All nine packages (+ `_exemplos`) kept. In `criador-de-solvers`: the four planned prose edits (minimum-price rationale; "resold" → "transferred", with the royalty as a share of the original price; "5 USDC" → "US$5 paid in a stablecoin"); three wordings that only the purge check flagged were rephrased (two in `criador-de-solvers`, one in `frontend-react`). `pricing.priceUsdc` and `royaltyBps` untouched (D14/D15). `cli:validate --all`: nine packages + `_exemplos` valid. |
| Evals | `scripts/src/eval.ts` in English, no API key needed; re-grading left every `report.json` unchanged (scores are never edited). `backend-node`, `criador-de-solvers` and `planilhas-dados` have no saved outputs and are reported as skipped. |
| Scripts | viem only. Shared helpers in `scripts/src/lib` (`http`, `wallet` = SIWE + relayed sends, `mcp` = OAuth DCR + PKCE, `agent-client`, `flows`, `report`, `qa-*`). `env.ts`, `bootstrap.ts` (local anvil + deploy + seed), `topup.ts` (Moderato faucet `tempo_fundAddress`), `publish-test-agent.ts` (the real co-signed publication + `cli:approve` on any network), e2e: `e2e-purchase`, `e2e-api`, `e2e-full`, `e2e-mcp`, `e2e-creator` (+ `qa-reset.ps1`, disposable DB on 5546, API on 3028), `e2e-supply`, `e2e-pix`, `e2e-transfer`, `e2e-agent-pay` (mppx client), `e2e-agent-use`, `smoke-catalog`, `smoke-creator`, `qa-race`, `qa-worker-resume`. Every script prints PASS/FAIL per check and exits non-zero on failure. Scripts of dropped features and the previous chain's key/debug tools deleted. The package builds, typechecks and tests like the others (6 unit tests). |

## Moderato results (dev API on 3018; explorer https://explore.testnet.tempo.xyz/tx/<hash>)

| Script | Result | Evidence |
|---|---|---|
| publish-test-agent (co-signed + `cli:approve`) | PASS 7/7 | register `0x0432cebe…c9fc`, approve `0xd9ff208a…6340`, purchase `0x5d384c83…1acc` |
| e2e-purchase | PASS 14/14 — fee payer = RELAY; buyer paid exactly 19; creator 17.1; treasury 1.9 | `0x00524360…84dc` |
| e2e-transfer | PASS 8/8 — exactly 0.95 + 0.95 of 19; a plain transfer reverts `RoyaltyNotPaid` | `0xcabf0ddf…0a6f` |
| e2e-full | PASS 14/14 — buy → MCP → review → transfer → guarantee → release → dispute → refund | review `0xd3cfde29…37b1`, transfer `0xad6b7698…1aa0`, escrow `0x3f4bff64…e434`, release `0x9eb932d8…5166`, dispute `0x489fd514…f021`, refund `0x4864b46d…f2bb` |
| e2e-mcp | PASS 14/14 | |
| e2e-supply | PASS 8/8 — SoldOut, cap only rises | cap `0x0fecc51d…852`, purchase `0x92e7a41c…aa76` |
| e2e-pix | 10/11 — 4 webhook replays → 1 transaction; the failing check (license listed immediately) was server bug 1, fixed in phase 5's commit | `0x91feae23…e9a8` |
| e2e-agent-pay | 11/12 — exact debit, the agent paid no fee, a second purchase 409; failing check = server bug 1 (fixed) | settlement `0x2a076d81…9ce9`, mint `0xee8d51b0…3317` |
| e2e-api | PASS 9/9 | `0x87868ca9…a0fa` |
| e2e-agent-use | PASS 8/8 | `0xa3de96c2…5572` |
| smoke-catalog | PASS 2/2 | |

Local anvil + QA API on 3028: everything above passes; `e2e-creator` 104/106 (stage 8 = server bug 2: a price changed
on-chain without review was still sold through `/api/purchases/intent` — fixed in phase 5's commit), `smoke-creator`
10/10, `qa-race` 2/2. `qa-worker-resume` needs a separate worker process and was not run.

The two server bugs (fulfilments not indexed at once; purchase intents not checking the reviewed version/price) were
fixed with regression tests before the phase-5 commit; the affected scripts are re-run in phase 8.

## Reproduce

- Moderato: `cd apps/server && node --env-file=.env --env-file=<overrides> --import tsx src/index.ts` (overrides, not
  committed: `AGENT_PAY_ENABLED=true`, `MPP_SECRET_KEY`, `MP_WEBHOOK_SECRET`, `SUBMISSIONS_INLINE=true`,
  `GUARANTEE_MIN_SALES=0`, `GUARANTEE_MIN_RATING=0`), then `cd scripts && npx tsx src/<script>.ts`.
- Local: `cd scripts && npx tsx src/bootstrap.ts --seed`, `cd apps/server && node --env-file=.env.qa --import tsx
  src/index.ts`, then `API_URL=http://127.0.0.1:3028 SERVER_ENV_FILE=../apps/server/.env.qa npx tsx src/<script>.ts`.

## Notes

- Moderato now holds test Solvers from these runs (`e2e-bcb32c`, `e2e-4da1b2` listed; the e2e-supply ones suspended).
- The API allows 5 open agent-pay orders per IP per 15 minutes; back-to-back `e2e-agent-pay` runs hit 429.
- `cli:publish` refuses a localhost `PUBLIC_API_URL` on Moderato, while the site's co-signed flow writes the configured
  `PUBLIC_API_URL` into metadata URIs; set `PUBLIC_API_URL` to the public domain before publishing on a shared network.

## Gate

- `pnpm build && pnpm typecheck && pnpm test`: 11/11 turbo tasks; scripts 8 unit tests; server 1225 pass, 0 fail.
- `cli:validate --all`: nine packages + `_exemplos` valid. Purge check: nothing under `scripts/` or `agents/`
  (`agents/frontend-react/knowledge/formularios-e-validacao.md` keeps a generic HTML phrase about in-page links to each form field through an
  exact allow-list entry, so the paid package's hash and measured eval stay valid).

## Review

Independent reviewer sub-agent: no script can touch mainnet funds or drop a database other than the disposable one.
Fixed: skipped checks no longer count as passes (a run with skips fails unless `E2E_ALLOW_SKIP=1`); `e2e-mcp` no longer
returns early without a trial; the royalty on the ORIGINAL price is now tested (`e2e-creator` stage 7 raises the price
5 → 6 after the purchase and asserts 250,000 + 250,000 base units, computed in the script); child processes get their
database/chain/key variables from the env file, never from the shell (`childEnv()`, QA refuses anything but
`127.0.0.1:5546/solvers_tempo_qa`); an unplanned edit to a paid package's knowledge file was reverted; `e2e-agent-pay`
compares the debit with the on-chain price and checks the creator/treasury split; the scripts' mainnet guard compares
`CHAIN_ID` with the RPC; exact error and count assertions; `qa-worker-resume` kills only its own worker; cleanup in
`finally`. The QA passages of the creator guides describe the new reset. Local re-run after the fixes:
`e2e-creator` 106/107 (the one failure was a stale field in a stage-5 check, fixed afterwards), `e2e-transfer` 8/8,
`e2e-agent-pay` 14/14, `e2e-mcp` 14/14, `e2e-supply` 8/8, `qa-worker-resume` 3/3; `e2e-pix` 10/10 checks with 3
reported skips without `MP_WEBHOOK_SECRET` (fails by design unless allowed). Moderato re-runs are part of phase 8.

## Old repo check

`?? LICENSE`, `?? texts.json`, HEAD `1348d92911cf1f089aa062d08771a29a47f74efd` (unchanged).
