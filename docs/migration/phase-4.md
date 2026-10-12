# Phase 4 — Server

Date: 2026-10-11. Plan sections: §3.3 (server inventory), §3.6 (env), §3.7 (DB), §5 (payments), §6 phase 4, D3/D4/D6-D12/D14/D19/D20.

Built by five parallel sub-agents with strict file ownership (auth+relay, indexer, payments+agent-pay,
store/runtime/MCP/wiring, publish/verifier/CLIs/worker) on a foundation written first (env, chain context, nonce lanes,
jobs helper, payments hook, DB baseline), then integrated.

## What was built

| Area | What |
|---|---|
| Foundation | `env.ts` (plan §3.6; keys optional so the worker runs keyless; mainnet refuses admin/guardian/deployer keys; RELAY ≠ PLATFORM off the local chain; relay gas/fee caps); `chain/index.ts` (`initChain` + boot validation: chain id, contract code, token decimals = `PAYMENT_TOKEN_DECIMALS`, Registry token/treasury, PLATFORM/USAGE/VERIFIER roles, RELAY holds no role); `chain/lanes.ts` (`sendServerCalls`: one 2D nonce lane per server key and purpose, fee paid in-process by RELAY, hash journaled in `sent_txs` before broadcast with an `onSigned` hook, `validBefore` expiry, `reconcileSentTxs`); `infra/.env.example` (every env variable; a test keeps it in sync with `env.ts`). |
| DB | `0000_baseline.sql` regenerated from `db/schema.ts` (plan §3.7) plus the insert-only triggers of `package_reviews` (UPDATE/DELETE row trigger, TRUNCATE statement trigger). Added during the phase: `relay_log.sign_payload`, `wallet_persons`; `sent_txs` keyed by `tx_hash` (X25). All `version_hash` columns use the 64-hex form (X29). |
| Auth / OAuth / memory (D7, D8) | SIWE (EIP-4361, `viem/siwe`): purpose-bound single-use nonces (consumed only after a valid signature), domain/uri ∈ `SIWE_DOMAINS`, chain id, version, issuedAt/expiration/notBefore; EOA signatures, ERC-1271 for sign-in only. Privy access/identity tokens verified with `jose` (X26), off until configured; only a hash of the e-mail is stored. OAuth DCR + PKCE unchanged; consent page discovers wallets via EIP-6963 and signs with `personal_sign`; agent login is SIWE signed by a secp256k1 key. Memory key = HKDF over a canonicalised EIP-191 signature of `MEMORY_KEY_MESSAGE`; ERC-1271 refused. |
| Relay (D3) | `POST /api/relay` (web session or agent OAuth token; 503 when disabled) on `createSponsorRelay`: sender = session wallet, batch simulated with `estimateGas` (reverts refused with the decoded error), daily gas quotas per wallet and per IP reserved under a DB lock at co-signing time, `relay_log` keyed by the fee-payer sign payload. |
| Indexer (D9) | `eth_getLogs` poller over the six contracts (cursor `indexer:evm:<chainId>` with block hash, 32-block rewind on mismatch, ranges ≤ `INDEXER_BLOCK_BATCH`), events in (block, logIndex) order, reads before a single DB transaction that writes `processed_events` + effects, `indexer_failures` retry (RPC errors never spend attempts). Mirrors agents (D6 eval of the current version; unapproved chain version → `sync_flag`, never `platform_status`), licenses (owner on every `Transfer`, burn, version at mint), credits, reviews (+version at submission), escrows/milestones (derived status), reputation, deferred payouts, `chain_txs` (amounts from event fields). `SaleAuthorized` → payments hook inside the transaction. Governance events → cache invalidation + admin alert (only for events less than one hour old, so a backfill never replays alerts). `processTxHash`, `cli:reindex --from-block/--tx/--dead`. No webhook. |
| Payments (§5, D4, D10) | Provider registry and lifecycle with the ledger row written first and conditional status transitions (`fulfill` sends once): `direct-wallet`, `pix-intermediated` (Mercado Pago order in BRL, status re-read from the API, HMAC webhook, simulation off mainnet; PLATFORM fulfils `*For` with an exact approve in the same batch), `agent-pay` (MPP via `mppx`, `tempo` charge; settles into the PLATFORM float, X24), `fake`, stubs `pix-marketplace-split` / `fiat-onramp-to-wallet`. Reconcile job (expire, resume via `purchaseRef(PLATFORM, id)` and the `sent_txs` journal, refund only when provably unfulfillable). Float/relay low-balance alert, `cli:ledger-export`, `cli:treasury-status`. `docs/payments-open-questions.md` (questions only). |
| Store / runtime / MCP / wiring | `/api/tx/*` return `TxResponse` call payloads (review, transfer with royalty quote → `maxRoyalty`, claim, escrow actions, creator pricing/royalty/supply cap/metadata/stake); `/api/tx/confirm` (→ `processTxHash`, decoded events); `/api/license/:id` (tokenURI JSON); `/api/config` (`PublicConfig`, Registry config cached and invalidated on governance events); `/api/me/balance|payouts|licenses/:id/transfer-quote`; faucet (Moderato `tempo_fundAddress`, anvil PLATFORM transfer). Pause from Registry `pauseFlags`. Runtime access from the license mirror + `ownerOf` re-check. MCP texts: network label, MPP purchase instructions, sold-out wording without a secondary market. Jobs: auto-release and stale disputes from PLATFORM (X27), usage batches on the usage lane, `reconcileSentTxs`, payments, indexer, publish reconcile, delist, cleanup; escrow-closing job removed (D19). `app.ts` mounts everything; `index.ts` migrates, validates the chain, loads packages, listens on 127.0.0.1:3018. |
| Publication / admin (D20) | Co-signed publication: one sponsored creator batch `[approve(staking, minStake)?, registerAgent, setSupplyCap?]` (or `updateVersion` [+ pricing, royalty]) built from the approved record, simulated first, confirmed by tx hash against the approved id/versionHash/price. `cli:approve` / `cli:suspend` sign with the admin key on the admin lane (RELAY pays; the admin key holds no tokens); `cli:admin` governance commands (dry-run + simulation by default, `--yes` sends; mainnet only with an explicit `--key-file`, never env keys; granting a role to RELAY refused). Verifier `markPassed` and `setEval` on the verifier lane. The worker never builds a chain context. |

## Verification

- `pnpm build && pnpm typecheck && pnpm test`: see "Gate" below. Server typecheck now includes the test files (`tsconfig.check.json`).
- DB tests run against the disposable container `solvers-tempo-pg` on port 5546 (`solvers_tempo_test`); chain tests spawn `anvil --tempo` with the six proxies deployed.
- Live boot on Moderato with the dev keys: boot validation passed (chain 42431, code, decimals, token, treasury, roles), `/health`, `/api/config` (fee 1000 bps, royalty 500/500, min price 5000000, Pix simulated, agent-pay off), `/.well-known/oauth-authorization-server`, `/api/relay` refuses without a session, the indexer replayed the deployment's governance history from `deployBlock` and advanced its cursor.

## Gate

- `pnpm build && pnpm typecheck && pnpm test`: 9/9 turbo tasks green. Server: 1225 tests, 1218 pass, 0 fail, 7 skipped
  (they need the paid packages, absent from this repo). shared 51, chain 18, api-client 6, contracts-client 3.
- `forge test`: 465/465.
- Purge check (word-boundary mode): nothing under `apps/server`, `packages`, `contracts`, `infra`.
- DBs recreated from the regenerated `0000_baseline.sql` (incl. the review's index changes and the `package_reviews`
  triggers) before the run.

## Review

Three independent reviewer sub-agents (auth/relay/lanes, payments/indexer, store/publish/CLIs) read the diff against
the plan. No critical finding; every real finding was fixed with a regression test:

- **Auth / relay / lanes / env** (X30, X31): the template's empty values broke boot (empty = unset now, the template is
  parsed by a test); IPv6 quota rotation and no global ceiling (IPv6 /64 keys, `RELAY_DAILY_GAS_GLOBAL` with an admin
  alert); nested JSON-RPC batches and a shared per-call context; the relay forwarding raw transactions that asked for no
  sponsorship; nonce reuse after a receipt timeout and across processes (lane held until `validBefore`, Postgres advisory
  lock); a transport error at broadcast or an RPC error at reconcile marking a mined transaction failed/expired; hot keys
  holding admin/guardian or another key's roles; contract-signature sign-in disabled (X30); keys compared by address;
  mainnet requires an explicit `PAYMENT_TOKEN`; the unused `FEE_PAYER_URL` removed.
- **Payments / indexer**: an agent-pay order could be paid twice or raced by two payers (HMAC verified first, atomic
  claim, duplicate settlements refunded once with an alert); refunds could be sent twice (timed claim, journal checked
  on-chain); deterministic reverts retried forever (more unfulfillable errors, attempt/age limit → alert + refund); sale
  amounts lost on an RPC error inside the indexer transaction (computed from the same transaction's events); ledger
  uniqueness now (payer, purchase id) per X22; a refund racing a late sale (re-read `purchaseRef` first); getLogs range
  halving; bad agent ids skipped; alerts after commit; Pix webhook timestamp window; FX on the `ask` side.
- **Store / publish / CLIs** (X32): escrow texts could be inherited by another wallet's escrow reusing a purchase id
  (joined on escrow id, buyer, purchase id, kind) and the sweep could stall; deliverable checks without agreed criteria
  now refused (409) in the MCP tool and the verifier; guarantee-limit race (hold under the lock); publication confirm
  and `cli:approve` now compare royalty, pay-per-use price and metadata URI; reviewed price changes keep the creator's
  pay-per-use price; usage-batch reconcile only treats "receipt not found" as missing; acceptance plans cleaned up;
  404 for never-minted licenses; agent instructions follow `AGENT_PAY_ENABLED`; dispute texts keyed by reason hash;
  the site's admin approve signs nothing on-chain (`cli:approve` does); `register_tx` only from the matching event;
  unmeasured evals read as 0 (D6).

## Not covered / carried forward

- Privy identity-token claim names (`linked_accounts`) are confirmed live in phase 5 (owner's Privy app).
- ERC-1271 sign-in goes through `publicClient.verifyMessage`, not exercised on Tempo (no smart-account wallet in tests).
- `mppx` replay protection is in memory: one API process only (PM2 runs a single `solvers-tempo-api`).
- Mercado Pago refund/cancel endpoints follow the Orders API docs and were not called live (Pix stays simulated off mainnet).
- Guarantee purchases: the wallet limit is checked when the plan is built, before the ledger row (small race window);
  acceptance tests of abandoned plans stay on disk until a cleanup job exists.
- Stake withdrawals appear in `chain_txs` as kind `stake` with a negative amount.

## Old repo check

`?? LICENSE`, `?? texts.json`, HEAD `1348d92911cf1f089aa062d08771a29a47f74efd` (unchanged).
