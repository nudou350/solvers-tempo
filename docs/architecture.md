# Architecture

How Solvers is built on Tempo: components, data flow and the rules that hold them together. State as of 2026-10-11
(Moderato testnet; mainnet waits for the owner's decisions in `docs/migration/decisions.md`, "owed"). Decision ids
(D*, X*) refer to `docs/migration/decisions.md`.

## 1. Components

| Component | Where | What it does |
|---|---|---|
| Contracts | `contracts/src` | Six UUPS proxies: `SolversRegistry`, `SolversLicense`, `SolversCredits`, `SolversReviews`, `SolversEscrow`, `SolversStaking` (section 6) |
| Generated client | `packages/contracts-client` | ABIs (`@wagmi/cli` foundry plugin) and deployment addresses from `deployments/<chainId>.json`; never edited by hand |
| Chain package | `packages/chain` | viem only: chains, deployment loader, call builders (each returns `calls[]`), relay policy and relay handler, server send with 2D nonces, event and error decoding, explorer links, key loading. `@solvers/chain/browser` is the browser-safe entry |
| Shared | `packages/shared` | zod data contract, money math mirrored from the contracts (`feeSplit`, `royaltySplit`), address type, payment types, pure rules |
| API client | `packages/api-client` | Typed client of the API used by the web app and the scripts |
| API server | `apps/server` (PM2 `solvers-tempo-api`, port 3018) | Express 5: REST API, MCP connector, OAuth, relay, indexer, payments, agent-pay, creator flow, periodic jobs |
| Worker | `apps/server/src/worker` (PM2 `solvers-tempo-worker`) | ZIP extraction, validation and knowledge ingestion of creator submissions; Telegram linking. Holds no chain key |
| Web | `apps/web` (PM2 `solvers-tempo-web`, port 4018; dev 3001) | Next.js 16 App Router, Privy e-mail login with an embedded EVM wallet, dev wallet on test networks, routes in English with `/pt` |
| Database | Postgres 16 + pgvector | Mirror of the chain, payment ledger, sessions, memories, knowledge vectors (384 dimensions). Schema in `apps/server/src/db/schema.ts`, one baseline migration `0000_baseline.sql` |
| Solver packages | `agents/<slug>` | Data only (manifest, steps, knowledge, templates, evals); format in `PACKAGE_SPEC.md` |

Networks: Tempo mainnet chain id `4217`, testnet Moderato `42431`, local `anvil --tempo` `31337`. Tempo has no native
gas token: `msg.value` and `BALANCE` are always 0 and fees are paid in a TIP-20 stablecoin
(https://tempo.xyz/developers/docs/quickstart/evm-compatibility). The payment token is configured by `PAYMENT_TOKEN`
(pathUSD `0x20c0000000000000000000000000000000000000` on Moderato; the mainnet token is an owed decision) and its
decimals (6) are checked on-chain at boot.

## 2. Request paths at a glance

```
Browser (Privy / dev wallet) ──SIWE──> /api/auth ──cookie──> /api/* (catalog, intents, /api/tx/*, /api/me/*)
        │ batch of calls                                         │
        └── eth_fillTransaction / eth_sendRawTransaction ──> /api/relay (RELAY co-signs the fee) ──> Tempo RPC
Claude / ChatGPT ──OAuth (DCR + PKCE)──> /oauth ──Bearer──> /mcp (15 tools)
AI agent with a key ──SIWE──> /oauth/agent/* ──Bearer──> /mcp, /api/relay; or HTTP 402 at /api/agent-pay (MPP)
Mercado Pago ──webhook──> /webhooks/mercadopago ──> payments ──> PLATFORM key sends *For(buyer) ──> Tempo
Tempo ──eth_getLogs (poll)──> indexer ──> Postgres mirror ──> API / MCP answers
```

## 3. Transactions and fee sponsorship (D3)

Every transaction from a browser or an agent is a Tempo transaction (EIP-2718 type `0x76`) with an atomic list of
calls, for example `[token.approve(license, price), license.purchaseLicense(agentId, price, purchaseId)]`. The sender
signs; the platform's **RELAY** key signs as fee payer, which also chooses the fee token
(https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction). Users and agents never hold gas.

- **Relay endpoint** `POST /api/relay` (`apps/server/src/relay`): the JSON-RPC endpoint of viem's `withRelay`
  transport. It needs a session (web cookie or Bearer, or an MCP/agent OAuth access token) and answers only
  `eth_chainId`, `eth_fillTransaction`, `eth_sendRawTransaction[Sync]`. viem's `Relay.feePayer` co-signs the fill
  before the sender signs it (measured in phase 3).
- **Policy** (`checkSponsoredTransaction` in `packages/chain/src/relay.ts`): our chain id; at most 4 calls, each with
  value 0; targets are the six contracts, or the payment token with `approve`/`permit` whose spender is one of them; no
  contract creation, no `authorizationList`/`keyAuthorization`; our fee token only; gas limit
  `<= RELAY_MAX_GAS_PER_TX`, fee and priority-fee caps (`RELAY_MAX_FEE_PER_GAS`, `RELAY_MAX_PRIORITY_FEE_PER_GAS`);
  `validBefore` set, in the future and at most 120 s ahead; no future `validAfter`.
- **Server checks** (`relay/service.ts`): the sender is the session wallet; the whole batch is simulated with
  `estimateGas` and refused with the decoded custom error if it would revert (a sponsored revert still burns fees);
  rolling 24 h gas quotas per wallet (`RELAY_DAILY_GAS_PER_WALLET`), per IPv4 address or IPv6 /64
  (`RELAY_DAILY_GAS_PER_IP`) and globally (`RELAY_DAILY_GAS_GLOBAL`, admins alerted when reached), reserved under
  Postgres advisory locks at co-signing time; every decision goes to `relay_log`. `RELAY_ENABLED=false` answers 503.
- **Web**: `apps/web/src/lib/wallet/send.ts` sends one batch through the relay with `validBefore` = server time + 60 s;
  if the relay declines, nothing is signed (no fallback to a user-paid fee).
- **Server-sent transactions** (`apps/server/src/chain/lanes.ts`): PLATFORM, VERIFIER and the dev-only admin key send
  with `feePayer` = RELAY in-process. Each (key, purpose) has its own 2D nonce lane (`NONCE_LANES` in
  `packages/chain/src/send.ts`: 1 platform, 2 verifier, 3 usage, 4 admin), so lanes run in parallel. The hash is
  computed locally and written to `sent_txs` before broadcast; a lane is held (in-process queue plus a Postgres advisory
  lock shared with the CLIs) until the transaction lands or passes its `validBefore`; the "sent transactions" job
  settles the journal every minute (X25, X31).
- **Wallets that cannot sign `0x76`**: the contracts expose single-call `*WithPermit` variants (EIP-2612 permit on the
  payment token) and `packages/chain` has builders for them; no API route or web screen uses them yet.

## 4. Indexer (D9)

`apps/server/src/indexer`. There is no webhook: a poller calls `eth_getLogs` over the six contract addresses every
`INDEXER_POLL_MS` (1000 ms), up to `latest - INDEXER_CONFIRMATIONS` (1), in ranges of at most `INDEXER_BLOCK_BATCH`
(2000; Moderato's RPC refuses ranges above 100,000 blocks), starting at `INDEXER_START_BLOCK` or the deployment's
`deployBlock`.

- Cursor `kv['indexer:evm:<chainId>'] = { block, blockHash }`; if the stored hash no longer matches, it rewinds 32 blocks.
- Events are applied in `(blockNumber, logIndex)` order; `processed_events(tx_hash, log_index)` makes them idempotent
  (one receipt per batch, `logIndex` strictly increasing across its calls).
- Handlers re-read contract state by id with `eth_call` and write the mirror (agents with the eval of the current
  version, licenses with the owner after every `Transfer`, credits, reviews with the version at submission, escrows and
  milestones with the derived status, reputation, deferred payouts, `chain_txs`). Amounts come from event fields.
- `processTxHash(hash)` runs right after every server-sent transaction and after `/api/tx/confirm`, so a purchase is
  visible to the MCP connector without waiting for the poller.
- Governance events (`PauseChanged`, `ConfigUpdated`, `SatellitesSet`, role and default-admin events) invalidate the
  config cache and alert the admins on Telegram (only for events less than one hour old).
- Failures go to `indexer_failures` with exponential backoff (30 s up to 6 h, 12 attempts; RPC errors do not spend
  attempts). Manual recovery: `pnpm --filter @solvers/server cli:reindex --dead | --tx <hash>... | --from-block N [--to-block M]`.
- A version or price changed on-chain without review sets `agents.sync_flag = unapproved_chain_version`; the approved
  package keeps being served and sales through the API are blocked (`price_in_review`).

## 5. Payments

Detailed in `docs/payments.md`. Every charge buys one thing (license, credits or guarantee) for one buyer and carries
`purchaseId = keccak256("solvers:v1:" + chargeId)`; the ledger row (`payment_ledger`) is written before anything is
sent. The contracts accept a purchase id once per payer (`DuplicatePurchase`, X22). Providers:

| Provider | Who sends the purchase | Used by |
|---|---|---|
| `direct-wallet` | the buyer (sponsored batch `[approve, purchase]`) | web checkout, agents with a wallet, scripts |
| `pix-intermediated` | the PLATFORM key, `*For(buyer, …)` from its stablecoin float | Pix via Mercado Pago (simulated off mainnet; off on mainnet) |
| `agent-pay` | the PLATFORM key, after an MPP payment into the float (X24) | AI agents over HTTP 402 (`docs/agent-payments.md`) |

A reconcile job (every 30 s) expires stale charges, fulfils confirmed ones and resumes interrupted fulfilments from the
chain (`purchaseRef(payer, purchaseId)` and the `sent_txs` journal). Economics (fee split, minimum price, deferred
payouts) are in `docs/economics.md`; float and treasury operations in `docs/treasury.md`.

## 6. Contracts, roles and upgrades

| Contract | Owns |
|---|---|
| `SolversRegistry` | config (treasury, `feeBps`, `platformRoyaltyBps`, `minStake`, `minPrice`), roles, pause bits, agents (`agentId = bytes32(bytes16(manifest.id))`, D1), version-scoped evals (D6), supply cap, buyer reputation, purchase ids |
| `SolversLicense` | ERC-721 licenses, primary-sale split, royalty on every transfer (`docs/royalties.md`), ERC-2981 `royaltyInfo` (informational), review binding |
| `SolversCredits` | pay-per-use credits, verified uses, usage batches (Merkle root) |
| `SolversReviews` | one review per (agent, author), rating sums; needs a license or purchased credits |
| `SolversEscrow` | milestone guarantees (up to 5), derived status, vault accounting; no closing step (D19) |
| `SolversStaking` | creator stake, 30-day exit (at most 2 extensions of 30 days), slash after 72 h within a 14-day window |

Every purchase goes through one Registry check, `authorizeSale`: not paused (`ENTRIES`), agent `Active`, stake
`>= minStake`, purchase id unused for this payer, and per kind: licenses and credits refuse the creator as buyer
(`SelfPurchase`, D12/X11), licenses check the cap (`SoldOut`), escrows refuse a buyer with 3 lost disputes. Each sale
emits `SaleAuthorized`.

**Roles** live only in the Registry (OZ `AccessControlDefaultAdminRules`); the satellites ask `registry.hasRole`.

| Role / key | Holder | Can do |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | cold ADMIN key (Safe possible later via the 2-step transfer) | config, any pause bit, approve/suspend agents, resolve disputes, slashes, stake-exit extensions, base URI, `sweepStray`, role grants, every upgrade |
| `PLATFORM_ROLE` | PLATFORM key (hot, holds the float) | `purchaseLicenseFor`, `buyCreditsFor`, `createEscrowFor` |
| `USAGE_ROLE` | same PLATFORM key | `consumeCredits`, `recordUsageBatch` |
| `VERIFIER_ROLE` | VERIFIER key (hot) | `markPassed`, `setEval` |
| `GUARDIAN_ROLE` | guardian key(s) | add pause bits only, never `TRANSFERS` (X9) |
| (no role) | RELAY key (hot) | pays network fees only; boot validation refuses it if it holds any role |
| (address) | TREASURY (cold) | receives the platform fee, the platform royalty share and executed slashes |

Pause bits: `ENTRIES` (1) stops registration and purchases; `PAYMENTS` (2) stops escrow releases and dispute
resolution; `TRANSFERS` (4, admin only) stops license transfers. Never paused: `markPassed`, `openDispute`,
`cancelUndelivered`, `resolveStaleDispute`, staking, reviews, `claim`, admin operations.

**Upgradeability (D2)**: each contract is an `ERC1967Proxy` with `UUPSUpgradeable`; only the Registry's default admin
can upgrade any of the six. Storage uses one ERC-7201 namespace per contract (`solvers.storage.<Name>`), append-only;
the committed `contracts/storage-layouts/*.json` are checked by `node script/check-layouts.mjs` and the OZ upgrade
validator runs on every deploy and upgrade. Upgrades are validated against the build of the commit that produced the
live implementation (`script/Upgrade.s.sol`, X16); on mainnet the validated implementation is deployed by
`UPGRADE_MODE=prepare` and the default admin sends `upgradeToAndCall` as a sponsored transaction with
`cli:admin upgrade <contract> <implementation>`, so the cold key holds no tokens (X21). The admin handover and the
admin-transfer delay have sponsored commands too (`cli:admin accept`, `admin-delay`, `admin-delay-rollback`); only the
Registry carries the delay. Procedure in `docs/deploy-runbook.md` §4.6-4.7.

**Money movement (D5, X5)**: shares are pushed from the payer to the creator and the treasury at purchase. If a
recipient cannot receive (a TIP-403 receive policy or a token-level policy), the amount is held in the contract as
`deferred[recipient]` and paid by `claim()`; sales and releases are never blocked by a recipient. Vault deposits
(escrow, stake, deferred) are balance-diff checked.

## 7. Authentication (D7, D8)

- **Web**: `GET /api/auth/nonce` → SIWE message (EIP-4361, built with `viem/siwe`) → `POST /api/auth/verify` → httpOnly
  session cookie (24 h). Nonces are single-use, bound to a purpose (`login`, `oauth`, `agent`), valid 5 minutes; domain
  and URI must be in `SIWE_DOMAINS` (default: the hosts of `PUBLIC_WEB_URL` and `PUBLIC_API_URL`).
- **Privy**: e-mail login creates an embedded EVM wallet; the web signs SIWE with it. `POST /api/auth/privy/link`
  verifies Privy tokens with `jose` (X26) to link the e-mail (only its hash is stored); off until `PRIVY_APP_ID` and
  `PRIVY_VERIFICATION_KEY` are set.
- **MCP clients**: OAuth 2.1 with dynamic client registration and PKCE S256 (`/oauth/register`, `/oauth/authorize` →
  web `/connect` consent screen, `/oauth/token`, `/oauth/revoke`, metadata at `/.well-known`).
- **Agents with a key**: two calls, `/oauth/agent/nonce` and `/oauth/agent/token` (`docs/agent-login.md`).
- Only plain secp256k1 signatures sign in (X30). Addresses are stored lowercase and displayed checksummed.
- **Memory key**: HKDF over the EIP-191 signature of the constant `Solvers memory key v1`; deterministic for EOAs,
  smart-contract wallets cannot unlock memories (D8). The key is stored wrapped by `SERVER_KEK`: encryption at rest.

## 8. Jobs

API process (`apps/server/src/jobs.ts`): indexer (`INDEXER_POLL_MS`), payments reconcile (30 s), float balance alert
(10 min), publication finishing (1 min), `sent_txs` settlement (1 min), escrow auto-release and stale disputes (1 min,
sent from PLATFORM on its lane, X27), usage batches (10 min, `recordUsageBatch` on the usage lane), guarantee and
dispute texts (1 min), acceptance-plan cleanup and low-rating delist (hourly), submissions cleanup (6 h). The worker
runs the creator-flow queue.

## 9. Further reading

`docs/economics.md`, `docs/royalties.md`, `docs/payments.md`, `docs/treasury.md`, `docs/license-cap.md`,
`docs/agent-login.md`, `docs/agent-payments.md`, `docs/deploy-runbook.md`, `docs/qa.md`, `PACKAGE_SPEC.md`.
