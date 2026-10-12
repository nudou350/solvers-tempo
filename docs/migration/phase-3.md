# Phase 3 — Chain client + shared

Date: 2026-10-11. Plan sections: §3.2 (packages), §5 (payment types), §6 phase 3, §10 items 6-9.

## What was built

| Package | What |
|---|---|
| `@solvers/shared` (3a) | Previous-chain and dropped-feature code removed. New `evm.ts` (`Address` zod type stored lowercase / displayed checksummed, `Hex`, `Bytes32`, `TxHash`, `agentIdToBytes32` = `bytes32(bytes16(manifest.id))` per D1 and its inverse, `purchaseIdFor(chargeId)` = `keccak256("solvers:v1:" + chargeId)`, network helpers), `money.ts` (`feeSplit`, `royaltySplit` with the 2500-bps platform clamp, `toUnits`/`fromUnits` with explicit decimals, constants), `onchain.ts` (status codes, pause bits, purchase kinds mirroring the contracts), `payments.ts` (plan §5 `PaymentProvider`, `ChargeStatus`, `ChargeIntent`, `Charge`, provider ids). `PublicConfig`, `TxResponse = { calls, feePayer: true, chainId, purchaseId? }`, Pix charge, SIWE and purchase-intent schemas in `extras.ts`; publication confirm takes a 66-char tx hash; sold-out text never mentions a secondary market. Thin deprecated `usdcToUnits`/`unitsToUsdc` aliases remain for the ~100 call sites in the parked apps (removed when phases 4-5 port them). |
| `@solvers/api-client` (3a) | Dropped-feature methods removed; `WalletLike = { address, signMessage, sendCalls(calls) }`; SIWE login (`createSiweMessage` from `viem/siwe`, viem 2.x); `build*` return `TxResponse`; `confirm(txHash)`; `createPurchaseIntent`, `getLicenseMetadata`, payouts/claim, transfer quote. The route table at the top of `src/index.ts` is the contract phase 4 implements. |
| `@solvers/contracts-client` | `@wagmi/cli` 2.10 + foundry plugin generates `src/generated/abis.ts` (the six ABIs) from `contracts/out`; `scripts/generate.mjs` also writes `src/generated/addresses.ts` from `deployments/<chainId>.json` (public networks only; 31337 is loaded at runtime). `generate:check` fails when the committed files are stale. Exports `solversAbi` (union for log/error decoding). |
| `@solvers/chain` | viem only: `getChain` (tempo, tempoModerato, local 31337 on Moderato's Tempo config), `loadDeployment`, call builders for every user/creator/admin/server action including pricing, royalty, metadata, supply cap, the stake lifecycle and the single-call permit variants (each returns `calls[]`), `checkSponsoredTransaction` (the D3 policy as a pure function: chain, ≤4 calls, value 0, targets = our six contracts or token `approve`/`permit` towards them, no contract creation, no `authorizationList`/`keyAuthorization`, our fee token only, caps on gas, `maxFeePerGas`, `maxPriorityFeePerGas`, `validBefore` within 120 s, no future `validAfter`) and `createSponsorRelay` (viem `Relay` + `Relay.feePayer`; answers only `eth_chainId`, `eth_fillTransaction`, `eth_sendRawTransaction[Sync]`; `handle(body, ctx)` runs each request inside an `AsyncLocalStorage` context so the server's `check(tx, ctx)` sees the session wallet and IP for sender and quota checks; `onSponsored(event, ctx)` for `relay_log`), `relayedWalletClient` (`withRelay(http(rpc), http(relayUrl), { policy: "sign-and-broadcast" })`), `serverWalletClient`, `sendCalls` (fee payer, `nonceKey`, `validBefore`), `NONCE_LANES` (1 platform, 2 verifier, 3 usage, 4 admin), `parseSolversEvents` (sorted by block, logIndex), `decodeSolversError` (custom errors by name + TIP-20 selectors, English fallback messages), `explorerUrl`, `loadPrivateKey`/`loadAccount` (hex or key file; errors never echo the key). |

## Spike (plan §6 phase 3 step 4) — results

| | Question | Result | Evidence |
|---|---|---|---|
| a | Privy signs a 0x76 tx and lists Tempo chain ids | **Supported by the SDK, not yet proven live.** The installed `@privy-io/react-auth` 3.48.1 exports `@privy-io/react-auth/tempo` with `toViemAccount` (its `signTransaction` takes viem's Tempo account type), `useSignTransaction` (signs a type-118 tx without broadcasting) and `useSendTransaction(..., { sponsor })`; chains come from `viem/chains` (`tempo`, `tempoModerato`). So the plan's path (Privy account → viem wallet client with `withRelay` → our relay) is supported by the SDK; the dev wallet (viem local account) uses the identical path and is proven end to end below. A live Privy run needs the Privy app configured for EVM/Tempo (owner's dashboard step, listed in phase 5). | `node_modules/@privy-io/react-auth/dist/dts/tempo.d.ts`; docs.privy.io/recipes/tempo/send-transactions (plan T11) |
| b | viem relay API, `validate`, `nonceKey`/`validBefore`, fee token, fee-payer signature covers the user payload | `Relay.create({ client, plugins: [Relay.feePayer({ account, feeToken, validate, onSponsored })] })`. With `withRelay`, the client sends `eth_fillTransaction` to the relay, which fills gas/fees, runs `validate` and returns the fill **already co-signed** (before the sender signs); the client signs and broadcasts through the public RPC. The fee-payer signature (`getFeePayerSignPayload(envelope, { sender })`) covers the sender and every field, so nothing can be changed afterwards, but a co-signed fill can be broadcast until `validBefore`. Raw sends without the fee-payer signature are validated and co-signed the same way. `onSponsored` fires at co-signing (for fills without a tx hash). On fills the sponsor's `feeToken` overrides the client's; on the raw path the client's wins, so the policy refuses any other fee token. Measured on anvil: a buyer's `[approve, purchaseLicense]` batch sponsored through the relay costs the buyer exactly the price; the relay key pays the fee; the receipt's `feePayer` is the relay; a client-chosen fee token is replaced by pathUSD; an excessive priority fee is refused. | `viem/tempo/Relay.ts`, `internal/relay/feePayer.ts`, `Transport.ts` (viem 2.57.4); `packages/chain/src/anvil.test.ts` (b) |
| c | Simulating a 0x76 batch; per-key nonces; `eth_getLogs` limits | `estimateGas({ account, calls })` simulates the whole batch (state of call 1 visible to call 2) and returns the custom revert, decoded as `SoldOut`; a valid batch estimates ~0.9M. Per-key nonces: `Actions.nonce.getNonce({ account, nonceKey })` (NONCE precompile); two different server keys on lanes 1 and 2 sent in parallel both landed (a third tx, deliberately sent by a key without the role, reverts as expected; two transactions on the SAME key and different lanes are exercised in phase 4 by the lane allocator). **Moderato RPC caps `eth_getLogs` at 100,000 blocks** (`-32602 query exceeds max block range 100000`); the indexer batch (2,000) is far below. | `anvil.test.ts` (c) and lanes test; `curl` against `https://rpc.moderato.tempo.xyz` (latest block 39,085,406, spans 1k/10k/100k OK, 1M refused) |
| d | `logIndex` numbering in batched receipts | One receipt per batch; `logIndex` starts at 0 and increases strictly across all calls (token `Approval`, TIP-20 `Transfer`s, `SaleAuthorized`, `LicensePurchased`, ERC-721 `Transfer`), so `(tx_hash, log_index)` is a valid idempotency key (D9). | `anvil.test.ts` (b) |

Extra facts measured: a transaction with `validBefore` in the past is rejected (the policy refuses it at fill time); transactions outside the relay policy (token
`transfer`, unknown target) are refused with the reason logged; Foundry's sponsored `cast send` under-estimates gas while
viem's relay fill estimates correctly (X19 is a CLI-only limitation).

## VERIFY items closed (plan §10)

| # | Item | Result |
|---|---|---|
| 6 | TIP-20 permit domain | closed in phase 2 (`EIP712Domain(name, "1", chainId, token)`); used by the permit builders |
| 7 | Privy 0x76 signing and chain support | SDK support confirmed from the installed typings (spike a); live check pending the owner's Privy app configuration (phase 5) |
| 8 | viem Tempo relay API names/semantics; per-key nonce RPC; batch simulation RPC; `eth_getLogs` limits | closed (spike b, c) |
| 9 | `logIndex` numbering in 0x76 receipts | closed (spike d) |

## Tests

| Package | Tests | Notes |
|---|---|---|
| shared | 51 | money vectors identical to the contracts (`5_000_009 @ 1000`, `19 @ 500/1000`, `1_000_001 @ 333/333`, `100 @ 2000/1000` clamp), address rules, agent id round trip, purchase id, schemas |
| api-client | 6 | SIWE message and signature recovery, intent → wallet → confirm, removed methods |
| contracts-client | 3 | generated ABIs/events/errors, deployments shape |
| chain | 18 | 10 unit (policy incl. every refusal reason, builders, Solvers and TIP-20 error decoding, explorer, keys, chains, deployment validation) + 8 on a spawned `anvil --tempo` with the six proxies deployed by viem from `contracts/out` and the relay served over HTTP (skipped when anvil is absent) |

`pnpm build && pnpm typecheck && pnpm test` green (8/8 turbo tasks). Typecheck now includes test files
(`tsconfig.check.json` in each package).

## Review

Independent reviewer sub-agent: no critical findings. Fixed: the relay capped gas but not the fee price or fee token (a single high-tip transaction could drain the RELAY key) — now capped, with `authorizationList`/`keyAuthorization` refused and our fee token enforced; the policy hook had no request context and the relay proxied every RPC method — now an `AsyncLocalStorage` context and a method allow-list; the spike (b) description understated that fills are co-signed before the sender signs (corrected above; phase 4 counts quotas at co-signing and keys `relay_log` by `signPayload`); missing call builders added; TIP-20 errors decoded through an ABI (incl. `InsufficientBalance`, `ContractPaused`); `numberToUnits` no longer rounds real extra decimals (only binary float noise is tolerated); `deployBlock` required; explorer link kind explicit; `generate.mjs` path handling; stale `purchaseRef` comment. Server dependencies for phase 4 (viem, the contracts client, `mppx`) were added to `apps/server/package.json` with this commit's lockfile.

## Not covered / carried forward

- Privy live signing on Moderato: needs the owner's Privy app (EVM + Tempo chains); phase 5 lists the exact settings.
- Privy 3.48.1 pins viem 2.56.5; the workspace uses ^2.57.4 (relay handler needs ≥ 2.57). Two copies in the web bundle
  until phase 5 decides (pnpm override to 2.57.x if Privy works with it).
- `contracts.yml` does not yet run `generate:check` (needs pnpm in that job); added with `ci.yml` in phase 7.
- X3 (Privy's transitive packages of the previous chain) unchanged.

## Old repo check

`?? LICENSE`, `?? texts.json`, HEAD `1348d92911cf1f089aa062d08771a29a47f74efd` (unchanged).
