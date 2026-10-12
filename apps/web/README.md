# @solvers/web

Solvers storefront in Next.js 16 (App Router, React 19, plain CSS from the design). Talks to the API in `apps/server`
on the same origin (`/api/...`). Read `AGENTS.md` before writing Next code (the installed Next differs from older docs).

## Run

```bash
# 1. API on 3018 (another terminal): apps/server, `pnpm dev`
# 2. Web in dev on 3001 (next.config rewrites /api, /mcp, /oauth, /preview, /.well-known and /health to the API)
pnpm --filter @solvers/web dev

# Production (port 4018, PM2 solvers-tempo-web). In production nginx serves /api on the same domain.
pnpm --filter @solvers/web build
PORT=4018 API_INTERNAL_URL=http://127.0.0.1:3018 node apps/web/start.mjs
```

Checks: `pnpm --filter @solvers/web typecheck` (`next typegen && tsc --noEmit`) and `pnpm --filter @solvers/web test`
(`check-messages.mjs` + `node:test` unit tests in `test/`; `test/wallet-send.test.ts` runs against `anvil --tempo`
and is skipped when anvil is not installed).

## Environment

`NEXT_PUBLIC_*` values are inlined at build time: rebuild after changing them. Template: `.env.example` (copy to
`.env.local`, never committed).

| Variable | When | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | build | Tempo chain this build targets: `42431` (Moderato testnet), `4217` (mainnet), `31337` (local). Configures Privy's chain and blocks the dev wallet on mainnet. The API's `/api/config` must report the same id. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | build | E-mail login with a Privy EVM embedded wallet. |
| `NEXT_PUBLIC_ALLOW_DEV_WALLET` | build | `1` offers the dev wallet (a test key kept in this browser's localStorage). Refused when the chain is 4217. |
| `NEXT_PUBLIC_API_URL` | build | API origin for the browser. Empty (default) = same origin. |
| `NEXT_PUBLIC_SHOW_DEV_KIT` | build | `1` shows `/dev/kit` in production builds (always shown in dev). |
| `API_INTERNAL_URL` | runtime | API URL for server components (catalog). Default `http://127.0.0.1:3018`. |
| `API_DEV_URL` | dev | Target of the `next dev` rewrites. Default `http://localhost:3018`. |
| `PORT` / `HOSTNAME` | runtime | Used by `start.mjs`. Default `4018` / `127.0.0.1`. |

## Sign-in, wallet and transactions

- `src/lib/wallet` (`WalletProvider`, `useWallet()`): Privy (`@privy-io/react-auth`, EVM embedded wallet created on
  login, Tempo chain from `viem/chains`) and the dev wallet (viem local account). Both send ONE Tempo 0x76 batch per
  operation with the network fee paid by the platform relay (`POST /api/relay`, viem `withRelay`); if the relay does not
  co-sign, nothing is signed or sent (`SponsorDeclinedError`), so a person never pays a fee by surprise.
- `src/lib/session.tsx` (`SessionProvider`, `useSession()`): Sign-In with Ethereum through `/api/auth/nonce` +
  `/api/auth/verify`, httpOnly session cookie; with Privy, the e-mail is linked through `/api/auth/privy/link`.
- `src/lib/tx.ts`: `runTx(tx, wallet)` / `useTx()` send the calls returned by the API and wait for `/api/tx/confirm`.
  `src/lib/error-text.ts` turns API codes and contract custom errors (by name) into text in the page language.
- `src/lib/explorer.ts`: explorer links from `PublicConfig.explorerUrl`; `src/lib/config.ts`: `usePublicConfig()`.

## Routes

| Route | Screen |
|---|---|
| `/` | Home: search by need, categories, top rated, trending, new |
| `/solvers/[slug]` | Solver page |
| `/creators/[id]` | Creator profile |
| `/checkout?agent=<slug>&type=permanent\|guarantee` | Checkout (wallet or Pix) |
| `/checkout/done` | Purchase done |
| `/install?agent=<slug>` | Connector install guide |
| `/connect?req=...` | Connector consent (destination of the server's `/oauth/authorize`) |
| `/library`, `/library/memories` | Licenses, usage and memories |
| `/guarantees` | Guaranteed tasks |
| `/profile` | Profile and reputation |
| `/creator`, `/creator/publish`, `/creator/submissions/[id]` | Creator area |
| `/admin/reviews` | Review queue (admin wallets) |
| `/dev/kit` | Component kit and a test session (dev, or `NEXT_PUBLIC_SHOW_DEV_KIT=1`) |
