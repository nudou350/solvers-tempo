# Signing in: web, MCP clients and agents

Every sign-in proves control of an EVM address with **SIWE** (Sign-In with Ethereum, EIP-4361), built and verified
with `viem/siwe` (D7). Code: `apps/server/src/auth` (web), `apps/server/src/oauth` (MCP clients and agents),
`packages/api-client` (SIWE on the client side). Only plain secp256k1 signatures are accepted for sign-in (X30):
Privy embedded wallets, injected wallets and agent keys are all EOAs.

## 1. Common rules

- Nonces are random, single use, valid **5 minutes**, and bound to a purpose: `login` (web), `oauth` (consent page of an
  MCP client) or `agent` (agent login). A nonce of one purpose is refused by the others.
- The SIWE message names the chain id (`CHAIN_ID`), a domain and URI that must be in `SIWE_DOMAINS` (default: the hosts
  of `PUBLIC_WEB_URL` and `PUBLIC_API_URL`), version 1, `issuedAt` and `expirationTime`. The address is written in its
  checksummed form; the server stores it lowercase.
- The statements say that signing authorizes no payment and costs nothing:
  - web: "Sign in to Solvers. This does not authorize any payments and costs nothing."
  - agent: "Authorize this agent to use Solvers specialists. This does not authorize payments."
- **Memory key** (optional, D8): a second signature of the constant message `Solvers memory key v1` (EIP-191). The server
  derives the encryption key of the wallet's memories with HKDF and keeps it wrapped with `SERVER_KEK` for the lifetime
  of the token. Smart-contract wallets cannot unlock memories. Without it, `get_memory`/`save_memory` answer that memory
  is unavailable.

## 2. Web

1. `GET /api/auth/nonce?address=0x…` → `{ nonce, chainId, statement, issuedAt, expiresAt, domain, uri, message }`.
2. The wallet signs `message` (Privy embedded wallet after e-mail login, or the dev wallet on test networks).
3. `POST /api/auth/verify { message, signature }` → httpOnly session cookie (24 h); clients outside the browser may ask
   for the token in the body (`returnToken: true`).
4. `GET /api/auth/me`, `POST /api/auth/logout`. `POST /api/auth/privy/link` links the Privy e-mail to the wallet
   (Privy tokens verified with `jose`, X26; off until `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` are set).

## 3. MCP clients (Claude, ChatGPT): OAuth with DCR and PKCE

1. `POST /mcp` without a token answers 401 with the protected-resource metadata; the client discovers
   `/.well-known/oauth-authorization-server`.
2. Dynamic client registration: `POST /oauth/register` (redirect URIs must be `https`, or `http` on localhost).
3. `GET /oauth/authorize` (PKCE `S256` required) stores the request and redirects to the web app's `/connect` page,
   where the user signs in (e-mail or wallet) and signs the SIWE consent message (purpose `oauth`) and, optionally, the
   memory key. A self-contained fallback page that discovers injected wallets with EIP-6963 is served at
   `/oauth/authorize/extension`.
4. `POST /oauth/token` (`authorization_code` + `code_verifier`) → `access_token` (Bearer, 24 h), `refresh_token`
   (30 days, single use: every refresh rotates it), `scope: "solvers"`. `POST /oauth/revoke` revokes either token.
5. The client calls `POST /mcp` with `Authorization: Bearer <access_token>`.

Rate limits: 60 requests per minute per IP on `/oauth`.

## 4. Agents with their own key (two calls)

An AI agent that holds a secp256k1 key logs in with two HTTP calls: no browser, no client registration, no PKCE. The
endpoints are also listed in the authorization-server metadata as `agent_nonce_endpoint` and `agent_token_endpoint`
(non-standard fields, used by our own clients).

1. `GET /oauth/agent/nonce?address=0x…` (alias `wallet`) → a SIWE message with purpose `agent`, naming the API host.
   Limit: 10 nonces per minute per wallet.
2. Sign it with the agent key (EIP-191 `personal_sign`, e.g. viem `privateKeyToAccount(pk).signMessage({ message })`).
3. `POST /oauth/agent/token { address, message, signature, memorySignature? }` →
   `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope: "solvers" }`.
4. Use `Authorization: Bearer <access_token>` on `POST /mcp`; the same token is accepted by `POST /api/relay`, so the
   agent can send sponsored purchases from its own wallet.
5. Refresh: `POST /oauth/token` with `grant_type=refresh_token`, `refresh_token` and `client_id=agent`.

Reference client: `scripts/src/lib/agent-client.ts` (`connectAgent`, `refreshAgent`); full example:
`scripts/src/e2e-agent-use.ts`.

The token carries `client_id = "agent"`. That is how `/mcp` knows the caller is an agent:

| Where | Behaviour for agent tokens |
|---|---|
| `initialize` | agent-specific server instructions |
| `activate_solver` without a license | never a free trial; answers how to buy (MPP endpoint when `AGENT_PAY_ENABLED`, otherwise the direct wallet path) |
| `find_solver`, `get_purchase_link` | purchase instructions instead of the checkout link; no trial offer |
| `next_step` | adds: "You are an autonomous agent. Where a step asks for the user's confirmation, decide from context and record your assumption in `result_summary`." |

The login message authorizes no payment, and the server never moves the agent's funds because of a login. Buying is a
separate, explicit step: `docs/agent-payments.md` (MPP) or a direct purchase intent sent through the relay.
