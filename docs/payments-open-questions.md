# Payments: open questions

Questions the owner (and, where marked, an accountant or lawyer) still has to answer about how Solvers takes money.
This file holds questions only: no answer, recommendation or conclusion is recorded here. Each answer, once given,
goes to `docs/migration/decisions.md` (owed item 3) and the relevant code or runbook.

How the flows work today (facts, for context): `docs/payments.md`, `docs/agent-payments.md`, `docs/treasury.md`,
`docs/economics.md`, `docs/migration/decisions.md` D4, D10 and X24, and the code in `apps/server/src/payments`,
`apps/server/src/pix` and `apps/server/src/agent-pay`. In short:

- **direct-wallet**: the buyer's own wallet pays the contracts; the platform only sponsors the network fee.
- **pix-intermediated**: the buyer pays one purchase in BRL to the platform's Mercado Pago account; the platform then
  buys that purchase on-chain for the buyer from its own stablecoin balance (the PLATFORM float). The contracts pay the
  creator share and the platform fee at that moment. Pix is disabled on mainnet in the code until these questions are
  answered.
- **agent-pay**: an AI agent pays the stablecoin price to the PLATFORM float over HTTP 402 (MPP), then the platform buys
  the license for the agent's wallet from the same float.

## 1. Merchant of record for Pix

1. Who is the seller of record when a buyer pays by Pix: the platform (which then buys the license on-chain for the
   buyer), the creator of the Solver, or both in some form?
2. Does the answer change for each purchase kind (lifetime license, pay-per-use credits, guaranteed task held in escrow
   and released per milestone, refunded on a lost dispute)?
3. Does the answer change if the creator is a company, an individual, or located outside Brazil?
4. Is the on-chain purchase the platform makes for the buyer (the `*For` call) a separate transaction for accounting
   purposes, or part of the same sale?

## 2. Invoices and receipts

1. Which documents must be issued for a Pix purchase, by whom, and to whom (buyer, creator, platform)?
2. Which documents, if any, are needed for the creator's on-chain payout and for the platform fee kept by the treasury?
3. For a guaranteed task, is a document due at payment, at each milestone release, or at refund?
4. What must the buyer-facing receipt contain (amount in BRL, token amount, exchange rate, transaction hash, creator)?
5. Are documents needed for purchases paid directly from a wallet or by an AI agent (no BRL involved)?

## 3. Exchange-rate documentation

1. Which exchange-rate source is acceptable for converting the USD-stablecoin price to BRL at charge time (the code
   records the rate used, with 8 decimals, and its source: a public quote API, or the configured fallback)?
2. Must the rate be the one of the payment moment, of the on-chain purchase moment, or of another reference?
3. How must the difference between the BRL received and the stablecoin spent (rounding to the cent, rate movement
   between charge and fulfilment, a price lowered before fulfilment) be documented?
4. How long must the ledger export (`cli:ledger-export`) and the rate evidence be kept, and in which format?

## 4. When a marketplace split would be preferable

1. Under which conditions would paying the creator directly in BRL through a payment-provider split (each creator
   onboarded at the provider) be preferable to the platform buying on-chain for the buyer?
2. What would the creator need to provide (registration, bank details, tax status) for a split to work?
3. If a split were used, how should the creator's on-chain share be handled, given that the contracts always pay the
   creator in the payment token at purchase time (the `pix-marketplace-split` provider is only a stub for this reason)?
4. Would a split change who issues documents (section 2) or who is the seller of record (section 1)?

## 5. On-ramp option

1. Would linking the buyer to a third-party on-ramp (BRL to stablecoin into the buyer's own wallet, then a normal
   wallet purchase) remove the platform from the BRL side entirely, and is that desirable?
2. Which on-ramp providers are acceptable, and what does each require from the platform (agreements, disclosures)?
3. Who handles disputes and refunds when the on-ramp step succeeded but the purchase did not happen?

## 6. Custody of agent-pay settlement

1. Agent payments settle into the PLATFORM float (a hot key the server uses to buy on the agent's behalf) and leave it
   seconds later in the on-chain purchase. Is holding the payment for that interval acceptable, and does it need to be
   disclosed to the paying agent's owner?
2. Should agent-pay settle into the cold treasury instead (the float would then need regular top-ups from the treasury
   equal to the agent purchase volume)?
3. How are refunds to an agent (the purchase became impossible after payment) documented, given that they are an
   on-chain transfer back to the paying wallet?
4. Is any limit or check required on who can pay (agents are anonymous wallets), or on the amounts accepted per
   purchase (today bounded by `AGENT_PAY_MIN_PRICE` / `AGENT_PAY_MAX_PRICE`)?

## 7. Float and treasury operations

1. Who may move funds between the treasury (cold) and the PLATFORM and RELAY floats, and how are those movements
   recorded?
2. Do the float balances held for Pix and agent purchases need to be reported in a specific way?
3. Who answers the low-balance alert (`FLOAT_LOW_BALANCE_UNITS`), and within what time?
