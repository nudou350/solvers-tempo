# Solana Pay checkout (USDC on Solana)

A signed-in buyer can pay a purchase (licence, credits or guarantee) in USDC on Solana. The platform then completes the
purchase on Tempo from its float, exactly like Pix (`purchaseLicenseFor(buyer, …, purchaseId)`), so the licence lands in
the buyer's Tempo wallet and the connector sees it as usual. Contracts and login are unchanged.

## Flow

1. `POST /api/solana-pay/charges` (`PurchaseIntentInput`) writes a `payment_ledger` row (provider `solana-pay`, id
   `sol_…`) and returns a Solana Pay transfer request: `solana:<recipient>?amount=…&spl-token=<USDC>&reference=<key>&memo=<chargeId>`
   plus its QR (`SolanaPayCharge`).
2. The buyer scans it with Phantom (or any Solana Pay wallet). The per-charge `reference` key is carried by the transfer.
3. The GET route and the 30 s reconcile job look the reference up (`getSignaturesForAddress`) and accept only a
   successful, `confirmed` transaction that raises the recipient's USDC associated token account by at least the charge
   amount. One transaction pays one charge (bound under a lock).
4. Paid -> `confirmed` -> fulfilment on Tempo from the PLATFORM float -> `fulfilled`.
5. If the purchase cannot be completed (sold out, paused, price changed), the USDC is returned automatically to the
   wallet that signed the payment (journaled, never sent twice). Anything ambiguous becomes `refund_manual_required`
   with a Telegram alert.

Late payments are still found for 72 h after expiry. Underpaid, misdirected and overpaid transfers alert the admin.

## Configuration (`apps/server/.env`, see `infra/.env.example`)

| Variable | Notes |
|---|---|
| `SOLANA_PAY_ENABLED` | `true` to offer it (default off) |
| `SOLANA_CLUSTER` | follows Tempo: `devnet` on the testnet, `mainnet-beta` on mainnet |
| `SOLANA_RPC_URL` | default: the cluster's public RPC |
| `SOLANA_PAY_MINT` | default: Circle USDC of the cluster (mainnet refuses another mint unless `SOLANA_PAY_ALLOW_CUSTOM_MINT=true`) |
| `SOLANA_PAY_KEYPAIR` | solana-keygen JSON; its address receives the payments and signs refunds (needs a little SOL) |
| `SOLANA_PAY_TTL_MIN` | charge lifetime, default 30 |

Testnet: recipient `7KHHTBCFRCj58wnZKDPsnsFo6tvpP313AFagqxoeUcMj` (key in `apps/server/.keys/solana-devnet-platform.json`,
on the VPS in `keys/`). Test USDC: https://faucet.circle.com (Solana Devnet, 20 USDC per 2 h); SOL: https://faucet.solana.com.
Phantom must be in testnet mode (Settings -> Developer settings -> Solana devnet).

## Scripts

```bash
cd scripts
npm run solana:balances                       # SOL/USDC of the test payer and the recipient
npm run e2e:solana-pay                        # end to end against API_URL (spends one licence of test USDC)
npx tsx src/solana-pay-url.ts "solana:…"      # pay a checkout QR from the test payer (no phone needed)
```

## Operations

- The recipient is a hot wallet holding every USDC received on Solana: sweep it regularly on mainnet.
- The PLATFORM float on Tempo pays for every Solana Pay purchase; refill it like for Pix.
- `refund_manual_required` charges and alert-only payments (underpaid, misdirected, overpaid excess, after 72 h) are
  returned by hand; there is no admin command yet to mark them refunded.
