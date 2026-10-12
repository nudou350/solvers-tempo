import "./helpers/fake-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKHASH_EXPIRY_MARGIN,
  formatUnits,
  paymentMessage,
  refundOutcome,
  solanaExplorerTxUrl,
  transferRequestUrl,
  validatePayment,
  type PaymentTx,
} from "../src/solana-pay/rules.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "7KHHTBCFRCj58wnZKDPsnsFo6tvpP313AFagqxoeUcMj";
const RECIPIENT_ATA = "AtaRecipient1111111111111111111111111111111";
const PAYER = "PayerWa11et11111111111111111111111111111111";
const PAYER_ATA = "AtaPayer11111111111111111111111111111111111";
const REFERENCE = "Ref1111111111111111111111111111111111111111";
const AMOUNT = 19_000_000n;

const expect = { reference: REFERENCE, recipient: RECIPIENT, recipientAta: RECIPIENT_ATA, mint: MINT, amount: AMOUNT };

/** A transfer of `amount` from the payer's token account to `to` (owned by `toOwner`), carrying `keys` extra accounts. */
function transfer(
  amount: bigint,
  o: { mint?: string; to?: string; toOwner?: string; err?: unknown; keys?: string[]; recipientPre?: bigint | null; signers?: string[] } = {},
): PaymentTx {
  const mint = o.mint ?? MINT;
  const pre = o.recipientPre === undefined ? 1_000n : o.recipientPre;
  return {
    err: o.err ?? null,
    accountKeys: [PAYER, PAYER_ATA, o.to ?? RECIPIENT_ATA, ...(o.keys ?? [REFERENCE]), mint],
    signers: o.signers ?? [PAYER],
    preTokenBalances: [
      { accountIndex: 1, mint, owner: PAYER, amount: 100_000_000n },
      ...(pre === null ? [] : [{ accountIndex: 2, mint, owner: o.toOwner ?? RECIPIENT, amount: pre }]),
    ],
    postTokenBalances: [
      { accountIndex: 1, mint, owner: PAYER, amount: 100_000_000n - amount },
      { accountIndex: 2, mint, owner: o.toOwner ?? RECIPIENT, amount: (pre ?? 0n) + amount },
    ],
  };
}

test("amount: base units as a decimal without trailing zeros", () => {
  assert.equal(formatUnits(19_000_000n, 6), "19");
  assert.equal(formatUnits(5_700_000n, 6), "5.7");
  assert.equal(formatUnits(5_070_000n, 6), "5.07");
  assert.equal(formatUnits(1n, 6), "0.000001");
  assert.equal(formatUnits(500_000n, 6), "0.5");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(123n, 0), "123");
  assert.equal(formatUnits(10n ** 24n, 6), "1000000000000000000");
  assert.throws(() => formatUnits(-1n, 6));
});

test("url: Solana Pay transfer request with the spl-token, reference and url-encoded label, message and memo", () => {
  const url = transferRequestUrl({
    recipient: RECIPIENT,
    amountUnits: 5_700_000n,
    decimals: 6,
    mint: MINT,
    reference: REFERENCE,
    label: "Solvers",
    message: "Solvers license & more",
    memo: "sol_abc 1",
  });
  assert.equal(
    url,
    `solana:${RECIPIENT}?amount=5.7&spl-token=${MINT}&reference=${REFERENCE}&label=Solvers&message=Solvers%20license%20%26%20more&memo=sol_abc%201`,
  );
  const u = new URL(url);
  assert.equal(u.protocol, "solana:");
  assert.equal(u.searchParams.get("amount"), "5.7");
  assert.equal(u.searchParams.get("message"), "Solvers license & more");
  // optional fields are left out; a zero amount is never requested
  assert.equal(transferRequestUrl({ recipient: RECIPIENT, amountUnits: 19_000_000n, decimals: 6, mint: MINT, reference: REFERENCE }), `solana:${RECIPIENT}?amount=19&spl-token=${MINT}&reference=${REFERENCE}`);
  assert.throws(() => transferRequestUrl({ recipient: RECIPIENT, amountUnits: 0n, decimals: 6, mint: MINT, reference: REFERENCE }));
});

test("message and explorer links", () => {
  assert.equal(paymentMessage("license"), "Solvers license");
  assert.equal(paymentMessage("credits"), "Solvers credits");
  assert.equal(paymentMessage("escrow"), "Solvers guarantee");
  assert.equal(solanaExplorerTxUrl("sig", "devnet"), "https://explorer.solana.com/tx/sig?cluster=devnet");
  assert.equal(solanaExplorerTxUrl("sig", "mainnet-beta"), "https://explorer.solana.com/tx/sig");
});

test("validate: the exact amount to the recipient's token account is paid, and the payer is recorded", () => {
  assert.deepEqual(validatePayment(transfer(AMOUNT), expect), { status: "paid", received: AMOUNT, payer: PAYER, misdirected: 0n });
});

test("validate: overpaying is paid (the received amount is reported)", () => {
  assert.deepEqual(validatePayment(transfer(AMOUNT + 1n), expect), { status: "paid", received: AMOUNT + 1n, payer: PAYER, misdirected: 0n });
});

test("validate: a recipient token account created in the transaction starts at 0", () => {
  assert.equal(validatePayment(transfer(AMOUNT, { recipientPre: null }), expect).status, "paid");
});

test("validate: underpaying is reported, never paid", () => {
  assert.deepEqual(validatePayment(transfer(AMOUNT - 1n), expect), { status: "underpaid", received: AMOUNT - 1n, payer: PAYER, misdirected: 0n });
});

test("validate: another mint does not count", () => {
  assert.equal(validatePayment(transfer(AMOUNT, { mint: OTHER_MINT }), expect).status, "none");
});

test("validate: another recipient (or another token account of the recipient, or a forged owner) does not count", () => {
  assert.equal(validatePayment(transfer(AMOUNT, { to: "AtaSomeoneE1se11111111111111111111111111111", toOwner: "SomeoneE1se11111111111111111111111111111111" }), expect).status, "none");
  assert.equal(validatePayment(transfer(AMOUNT, { toOwner: PAYER }), expect).status, "none");
});

test("validate: USDC sent to a token account of the recipient that is not its associated account is reported as misdirected", () => {
  assert.deepEqual(validatePayment(transfer(AMOUNT, { to: "AtaOther11111111111111111111111111111111111" }), expect), {
    status: "none",
    received: 0n,
    payer: PAYER,
    misdirected: AMOUNT,
  });
});

test("validate: the payer must be a signer whose balance decreased (a delegated transfer out of a vault has no payer)", () => {
  // Paid either way (the money arrived), but the refund destination is unknown.
  assert.deepEqual(validatePayment(transfer(AMOUNT, { signers: ["Processor111111111111111111111111111111111"] }), expect), {
    status: "paid",
    received: AMOUNT,
    payer: null,
    misdirected: 0n,
  });
  // A signer whose balance did not move is not the payer either.
  assert.equal(validatePayment(transfer(AMOUNT, { signers: ["Processor111111111111111111111111111111111", RECIPIENT] }), expect).payer, null);
});

test("validate: a failed transaction does not count", () => {
  assert.equal(validatePayment(transfer(AMOUNT, { err: { InstructionError: [0, "Custom"] } }), expect).status, "none");
});

test("validate: a transaction without the charge's reference does not count", () => {
  assert.equal(validatePayment(transfer(AMOUNT, { keys: [] }), expect).status, "none");
  assert.equal(validatePayment(transfer(AMOUNT, { keys: ["Ref2222222222222222222222222222222222222222"] }), expect).status, "none");
});

test("validate: no movement into the recipient is none", () => {
  const tx = transfer(AMOUNT);
  const still: PaymentTx = { ...tx, postTokenBalances: tx.preTokenBalances };
  assert.equal(validatePayment(still, expect).status, "none");
});

test("refund outcome: landed, failed, still valid, or expired for good", () => {
  const last = 1_000n;
  assert.equal(refundOutcome("confirmed", 5_000n, last), "confirmed");
  assert.equal(refundOutcome("failed", 900n, last), "failed");
  assert.equal(refundOutcome("unknown", 900n, last), "pending");
  assert.equal(refundOutcome("unknown", last + BLOCKHASH_EXPIRY_MARGIN, last), "pending");
  assert.equal(refundOutcome("unknown", last + BLOCKHASH_EXPIRY_MARGIN + 1n, last), "expired");
});
