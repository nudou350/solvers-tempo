# Agent payments (HTTP 402 with MPP)

An AI agent that holds only a key and some of the payment token can buy a lifetime license over plain HTTP, without a
browser, an account or gas. Solvers uses Tempo's **Machine Payments Protocol** (MPP): HTTP 402 with
`WWW-Authenticate: Payment`, the `tempo` method and the `charge` intent
(https://tempo.xyz/developers/docs/guide/machine-payments, server side:
https://tempo.xyz/developers/docs/guide/machine-payments/server). Decision D4; module `apps/server/src/agent-pay`;
libraries `mppx/express` (server) and `mppx/client` (agent), version 0.13.

The other way for an agent with a wallet is the direct path: sign in (`docs/agent-login.md`), `POST
/api/purchases/intent`, send the `[approve, purchaseLicense]` batch through `POST /api/relay` with its agent OAuth token
(`scripts/src/e2e-agent-use.ts` does this). Both end with the license in the agent's wallet.

## 1. Switches

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_PAY_ENABLED` | `false` | Mounts the routes; when off they answer 404 and the MCP texts give no MPP instructions |
| `MPP_SECRET_KEY` | — | Signs the MPP challenges (HMAC); required when enabled |
| `MPP_REALM` | host of `PUBLIC_API_URL` | Realm in the challenge |
| `AGENT_PAY_MIN_PRICE` / `AGENT_PAY_MAX_PRICE` | 5 / 100 | Accepted license prices, whole stablecoin units (never below the on-chain `minPrice`) |
| `AGENT_PAY_ORDER_TTL_SECS` | 900 | Order lifetime |

`GET /api/config` exposes `agentPay { enabled, protocol: "mpp", minPriceUnits, maxPriceUnits }`.

## 2. Flow

```
agent                                         API                                    Tempo
  | GET /api/agent-pay/solvers/<slug>          |  quote (no order)                      |
  | POST .../solvers/<id>/license              |  order row (ledger) + 402 challenge    |
  |<-- 402  WWW-Authenticate: Payment ...      |                                        |
  | signs a TIP-20 transfer (pull mode)        |                                        |
  | POST again, Authorization: Payment <cred>  |  verify challenge HMAC, bind payer,    |
  |                                            |  RELAY co-signs the fee, broadcast --->|  agent -> PLATFORM float
  |                                            |  PLATFORM: [approve, purchaseLicenseFor(agent)] --->|  license minted to agent
  |<-- 200 { status: "fulfilled", licenseId, txHash, settlementTx, ... }                |
```

1. **Quote** `GET /api/agent-pay/solvers/:idOrSlug` (public, `no-store`): `agentId`, `slug`, `name`, `priceUnits`,
   `decimals`, `token`, `chainId`, `available` + `reason` (`sold_out`, `price_out_of_range`, …), `limits`,
   `protocol: "mpp"`, `intent: "charge"`, `endpoint`.
2. **Order and challenge** `POST /api/agent-pay/solvers/:idOrSlug/license` without credentials: the server checks the
   Solver is sellable (active, not suspended, reviewed price, not sold out, price within bounds), writes the ledger row
   (provider `agent-pay`) and answers **402** with the challenge for exactly the current price. The challenge carries
   the order id and expires with the order. At most 5 open orders per client IP.
3. **Payment** (pull mode): the agent's MPP client signs a transfer of exactly the price of the payment token to the
   platform's PLATFORM address, with a memo bound to the challenge, and repeats the request with
   `Authorization: Payment <credential>`. The server checks the challenge was issued here, that the transaction pays
   this order (amount, recipient, memo), claims the order for the paying wallet (one in-flight payment per order, one
   wallet per order), co-signs the network fee with the RELAY key and broadcasts. The agent pays only the price.
   A credential with the hash of an already-mined payment (push mode) is also accepted.
4. **Fulfilment**: the PLATFORM key sends `[approve, purchaseLicenseFor(payer, agentId, price, purchaseId)]` from its
   float, exactly as for Pix (`docs/payments.md`). The license goes to **the wallet that paid**, never to an address
   supplied by the client. The answer is the order: `orderId`, `status`, `owner`, `licenseId`, `purchaseId`, `txHash`,
   `explorerUrl`, `settlementTx`, `refundTx`, `error`, `expiresAt`.
5. **Status** `GET /api/agent-pay/orders/:id` for clients that lost the 200.

If the license can no longer be minted after the payment (sold out, price changed, Solver suspended), the order is
refunded on-chain from the PLATFORM float to the payer. A second settlement for the same order is refunded once and the
admin is alerted.

## 3. Client example

From `scripts/src/e2e-agent-pay.ts`:

```ts
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const agent = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const mppx = Mppx.create({
  methods: [tempo.charge({ account: agent, mode: "pull", expectedChainId: 42431, getClient: () => publicClient })],
  polyfill: false,
});
const res = await mppx.fetch(`${API}/api/agent-pay/solvers/${agentId}/license`, { method: "POST" });
const order = await res.json(); // { status: "fulfilled", licenseId, txHash, settlementTx, ... }
```

Then log in to the MCP connector with the same key (`docs/agent-login.md`) and call `activate_solver`.

## 4. Rules

- License purchases only (no credits or guarantees over MPP); no free trial for agents.
- Errors: 409 `already_owned`, 409 `sold_out`, 400 `price_out_of_range`, 400 `creator_cannot_buy`, 400
  `invalid_payment`, 409 `order_closed` / `order_bound`, 429 `too_many_open_orders`.
- Settlement goes to the PLATFORM float, not to the treasury (X24): the fulfilment spends the same amount seconds later,
  the treasury still receives the platform fee through the contract split. Whether that custody interval is acceptable
  is an open question (`docs/payments-open-questions.md` §6).
- `mppx` replay protection is in memory, so only one API process may serve agent-pay (PM2 runs one
  `solvers-tempo-api`); one payment per order is enforced by the order row itself.
- x402 is not used: TIP-20 has no EIP-3009 and no x402 facilitator lists Tempo (plan T12,
  https://docs.x402.org/core-concepts/network-and-token-support).

## 5. Test

`cd scripts && npm run e2e:agent-pay` against an API started with `AGENT_PAY_ENABLED=true` and `MPP_SECRET_KEY`
(quote, 402, forged credential refused, paid purchase with exactly the price debited and no fee, order status, agent
login, MCP use, second purchase refused with nothing charged). Measured on Moderato in `docs/migration/phase-6.md`.
