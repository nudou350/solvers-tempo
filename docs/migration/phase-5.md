# Phase 5 — Web

Date: 2026-10-11. Plan sections: §1 T11 (Privy), §2 D3/D5/D7/D8/D12/D15/D16, §3.4 (web inventory), §6 phase 5.

Built by four parallel sub-agents with file ownership (foundation, catalog+checkout, account, creator+admin) plus one
for the creator dashboard data, then integrated.

## What was built

| Area | What |
|---|---|
| Foundation | `WalletProvider`/`useWallet()` (Privy embedded wallet via `toViemAccount` from `@privy-io/react-auth/tempo`; a dev wallet — viem key in localStorage — only with `NEXT_PUBLIC_ALLOW_DEV_WALLET=1` and never on mainnet). `sendCalls` sends ONE Tempo 0x76 batch through `/api/relay` with `validBefore`; if the relay does not co-sign it throws before anything is signed (viem would otherwise fall back to a user-paid fee). `SessionProvider`/`useSession()` (SIWE via the api-client, cookie session, Privy e-mail link). `lib/tx.ts` (`runTx` → send → `/api/tx/confirm`; `useTx`, `useFaucet`, `ensureSigner`), error text for all 37 contract errors (en + pt), explorer links, `usePublicConfig()`. Header (network label off mainnet, balance, test-funds button), footer, `/connect` (the OAuth consent screen the server's `/oauth/authorize` redirects to), dev kit, home, ui. `@solvers/chain/browser` entry (the main entry imports Node modules). |
| Catalog + checkout | Prices in the payment token; sold-out wording without a secondary market (the cap can be raised); "transferable" line with creator % + platform % of the original price; creators see a note instead of buying their own Solver (D12). Checkout by wallet (`/api/purchases/intent` → `runTx`; the network fee is "covered by Solvers") or Pix (charge, QR/copy code, polling, simulated approval when the server allows it, refund/expired states); guards for owned, creator, sold out, below minimum, paused; done page polls the charge until fulfilled with an explorer link. |
| Account | Library with `TransferLicenseDialog`: recipient validation (format, checksum, zero, self, platform contracts), quote from the server (bps and exact amounts, nothing hard-coded), confirm, one batched `approve + transferWithRoyalty` with `maxRoyalty` = quote total, re-quote on `royalty_changed`. Balance chip and held payouts with Claim (D5). Guarantees: release, dispute, cancel after the deadline, refund of a stale dispute. Memories unlock with the wallet signature of `MEMORY_KEY_MESSAGE` (smart wallets explained). Profile history with explorer links. |
| Creator + admin | Dashboard KPIs in base units (`*Units` strings, bigint sums server-side) with "royalties from transfers"; per-Solver "Manage" panel with current values read from the mirror and the Staking contract (price per use, royalty before the first sale with creator + platform ≤ 25%, raise-only cap, metadata, stake top-up/exit/cancel/withdraw, slash contest). CoSign: one batched publication transaction, then confirm by hash, then the platform's `cli:approve`. Admin review: the approve button only relists (`{ agentId, listed }`); on-chain approval is the cold key's `cli:approve`. |

## Privy dashboard — what the owner configures (nothing was changed by us)

1. App id → `NEXT_PUBLIC_PRIVY_APP_ID` (web) and `PRIVY_APP_ID` (server) — Configuration > App settings. Reuse of the old app vs a new one is owed decision #6.
2. Allowed origins: `http://localhost:3001` and `https://solvers-tempo.wondervelop.com` — https://docs.privy.io/recipes/dashboard/allowed-domains
3. E-mail login on — https://docs.privy.io/authentication/user-authentication/login-methods/email
4. EVM embedded wallet created on login: set in code (`createOnLogin: "users-without-wallets"`), no dashboard toggle documented — https://docs.privy.io/basics/react/advanced/automatic-wallet-creation
5. Tempo chains: no dashboard step; set in code (`supportedChains`, `defaultChain`) — https://docs.privy.io/recipes/tempo/send-transactions, https://docs.privy.io/basics/react/advanced/configuring-evm-networks
6. Verification key → server `PRIVY_VERIFICATION_KEY` — https://docs.privy.io/authentication/user-authentication/access-tokens
7. "Return user data in an identity token" on (Authentication > Advanced), needed for the e-mail link — https://docs.privy.io/user-management/users/identity-tokens
8. Optional: disable confirmation modals (code sets `showWalletUIs: false`) — https://docs.privy.io/recipes/react/manage-wallet-UIs
9. Raw-hash signing is used (`secp256k1_sign`) — https://docs.privy.io/wallets/using-wallets/ethereum/sign-a-raw-hash

## Verification

- Live: web dev on :3001 against the API on :3018 (Moderato), dev wallet: SIWE sign-in, a license purchase minted token #24 in one 0x76 transaction whose fee was paid by the RELAY key; the buyer's balance dropped by exactly the price (19 USD); explorer link correct. Privy was not exercised live (needs the dashboard setup above).
- `apps/web/test`: unit tests (error mapping, dev-wallet mainnet guard, money formatting, recipient validation, royalty disclosure, checkout and creator rules) and `wallet-send.test.ts` on `anvil --tempo` (sponsored purchase with the dev wallet and with a Privy-style signer producing the identical transaction; a reverting batch decodes as `PriceChanged`; a declined batch signs nothing and costs nothing).
- X3/X33: the lockfile installs no previous-chain package; Privy's peer declarations remain as text; viem pinned to the workspace version.

## Gate

- `pnpm build && pnpm typecheck && pnpm test`: 11/11 turbo tasks (incl. `@solvers/scripts`, un-parked in phase 6).
  Web 56 tests + `check-messages` (13 namespaces, 2090 keys in en and pt); server 1232 tests, 1225 pass, 0 fail,
  7 skipped (paid packages absent); shared 51; api-client 9; chain 18; contracts-client 3; scripts 6.
- `forge test` 465/465; purge check clean outside `docs/migration/00-inventory.md`.

## Review

Independent reviewer sub-agent (diff + plan): no critical or high finding. Fixed:
- M1: a payment sent but not confirmed in time re-enabled Pay (double charge possible) → the checkout goes to the done
  page with `{ chargeId, txHash }` and Pay stays off.
- M2: `validBefore` from the browser clock (10 s margin against the relay's 120 s cap) → `PublicConfig.serverTime`,
  offset measured once per page load, `validBefore = server now + 60`.
- M3: "use another test wallet" deleted the key and then signed for it → `signIn` always calls `connect(kind)` with live
  state; the header asks for confirmation before deleting the dev key.
- M4: memory-unlock error codes out of sync with the server (`memory_signature_refused` 400; 401 = session expired).
- L1 Privy e-mail saved on first login; L2 SIWE `issuedAt` from the server nonce; L3 Privy chain checked against
  `/api/config` (refuses to sign on mismatch, build warning when `NEXT_PUBLIC_CHAIN_ID` is missing); L4 the restored
  wallet matching the server session wins; L5 a nonce-based script CSP in `src/proxy.ts` (`'strict-dynamic'`,
  `object-src 'none'`, `frame-ancestors 'none'`; every page now renders per request) — residual risk recorded as X34.
- Nits: webpack alias exact match, stub Proxy traps, root `node_modules` check before stubbing, unknown errors shown as
  localized generic text, KPI decimals, `UnitsString`, trial links.
Server bugs found by the phase-6 e2e runs and fixed here: Pix/agent-pay fulfilments are indexed at once (the license is
visible when the charge reads "fulfilled"); purchase intents refuse an on-chain version/price that was never reviewed
(`price_in_review`, same rule as the store); the default escrow planner writes the same record shape as the store's,
and the text sweep skips records without criteria hashes instead of failing.

## Not covered / carried forward

- Live Privy login/signing (owner's dashboard).
- Guarantee offer/limit amounts still arrive from the server as numbers (display-only).
- The relay does not tell the client why it declined; the web shows "network fee not covered".

## Old repo check

`?? LICENSE`, `?? texts.json`, HEAD `1348d92911cf1f089aa062d08771a29a47f74efd` (unchanged).
