// Solana Pay provider lifecycle against the real ledger, with a fake Solana (SolanaGateway): charge creation (reference,
// transfer request, QR), payment lookup and validation (underpaid, misdirected, failed, exact, RPC lag, late inside the
// grace, one transaction for one charge), expiry and the late-payment re-scan, and the refund journal (sent once; a
// retry reuses the journaled transaction; a replacement only after the old one expired AND a second look found nothing;
// failed refunds retried a bounded number of times; manual when the destination or the keys cannot be trusted).
// Fulfilment on Tempo is the shared platform path (covered by payments-conformance.db.test.ts), so these tests stop at
// `confirmed` and drive the refund directly.
// Needs TEST_DATABASE_URL (disposable, migrated: container solvers-tempo-pg on 5546). No chain, no Solana network.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { ChargeIntent } from "@solvers/shared";
import { writeTestKeypair } from "./helpers/solana-keypair.js";
import type { LedgerRow } from "../src/payments/ledger.js";
import type { PaymentTx } from "../src/solana-pay/rules.js";
import type { SignatureState, SignedSolanaTx, SolanaGateway } from "../src/solana-pay/solana.js";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "set TEST_DATABASE_URL (disposable migrated database)" : false;

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER = "PayerWa11et11111111111111111111111111111111";
const VAULT_SIGNER = "Processor111111111111111111111111111111111";
const PRICE = 19_000_000n;
const BUYER = "0x2222222222222222222222222222222222222222";

/** In-memory Solana: payments are transactions registered under the references they carry. */
class FakeSolana implements SolanaGateway {
  readonly cluster = "devnet" as const;
  readonly mint = MINT;
  decimals = 6;
  mintCalls = 0;
  height = 1_000n;
  slot = 5_000n;
  /** What SOLANA_PAY_KEYPAIR is now (a key rotation changes it). */
  currentRecipient: string;
  /** Broadcasts land at once (otherwise they stay unseen until `statuses` says so); `failOnBroadcast` lands them failed. */
  landOnBroadcast = true;
  failOnBroadcast = false;
  readonly byReference = new Map<string, { signature: string; failed: boolean }[]>();
  readonly txs = new Map<string, PaymentTx>();
  readonly statuses = new Map<string, SignatureState>();
  readonly signed: (SignedSolanaTx & { to: string; amount: bigint; memo: string })[] = [];
  readonly broadcasts: { wire: string; resend: boolean }[] = [];
  /** Memo -> signature found in the recipient token account history; `memoScans` records each scan. */
  readonly memoHits = new Map<string, string>();
  readonly memoScans: { memo: string; sinceSlot: bigint }[] = [];
  onBroadcast: ((wire: string) => Promise<void>) | null = null;
  private n = 0;

  constructor(private readonly payTo: string) {
    this.currentRecipient = payTo;
  }

  recipient() {
    return this.currentRecipient;
  }
  async ata(owner: string, mint: string) {
    return `ata:${owner}:${mint}`;
  }
  async mintDecimals() {
    this.mintCalls++;
    return this.decimals;
  }
  async signaturesFor(reference: string) {
    return this.byReference.get(reference) ?? [];
  }
  async transaction(signature: string) {
    return this.txs.get(signature) ?? null;
  }
  async signatureState(signature: string) {
    return this.statuses.get(signature) ?? "unknown";
  }
  async blockHeight() {
    return this.height;
  }
  async signRefund(o: { to: string; amount: bigint; decimals: number; memo: string }) {
    this.n++;
    this.slot += 10n;
    const tx = { signature: `refund-${this.n}`, wire: `wire-${this.n}`, blockhash: `bh-${this.n}`, lastValidBlockHeight: this.height + 150n, slot: this.slot };
    this.signed.push({ ...tx, to: o.to, amount: o.amount, memo: o.memo });
    return tx;
  }
  async broadcast(wire: string, o: { resend?: boolean } = {}) {
    this.broadcasts.push({ wire, resend: o.resend === true });
    await this.onBroadcast?.(wire);
    const sig = wire.replace("wire-", "refund-");
    if (this.failOnBroadcast) this.statuses.set(sig, "failed");
    else if (this.landOnBroadcast) this.statuses.set(sig, "confirmed");
  }
  async findByMemo(memo: string, sinceSlot: bigint) {
    this.memoScans.push({ memo, sinceSlot });
    return this.memoHits.get(memo) ?? null;
  }

  /**
   * A transfer of `amount` of `mint` from PAYER to the recipient's token account (or `toAccount`) carrying `references`.
   * `delegated`: moved out of PAYER's account by another signer (a pool or processor vault): no trusted payer.
   */
  pay(references: string[], amount: bigint, o: { failed?: boolean; mint?: string; delegated?: boolean; toAccount?: string; unlisted?: boolean } = {}): string {
    const signature = `pay-${randomBytes(6).toString("hex")}`;
    const mint = o.mint ?? MINT;
    const to = o.toAccount ?? `ata:${this.payTo}:${MINT}`;
    this.txs.set(signature, {
      err: o.failed ? { InstructionError: [0, { Custom: 1 }] } : null,
      accountKeys: [o.delegated ? VAULT_SIGNER : PAYER, `ata:${PAYER}:${mint}`, to, ...references, mint],
      signers: [o.delegated ? VAULT_SIGNER : PAYER],
      preTokenBalances: [
        { accountIndex: 1, mint, owner: PAYER, amount: 100_000_000n },
        { accountIndex: 2, mint, owner: this.payTo, amount: 0n },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner: PAYER, amount: 100_000_000n - amount },
        { accountIndex: 2, mint, owner: this.payTo, amount },
      ],
    });
    if (!o.unlisted) {
      for (const r of references) this.byReference.set(r, [...(this.byReference.get(r) ?? []), { signature, failed: o.failed === true }]);
    }
    return signature;
  }

  /** The RPC lists a signature under `reference` but cannot serve its transaction (yet). */
  lag(reference: string): string {
    const signature = `lagging-${randomBytes(6).toString("hex")}`;
    this.byReference.set(reference, [...(this.byReference.get(reference) ?? []), { signature, failed: false }]);
    return signature;
  }
}

type Mods = {
  provider: typeof import("../src/solana-pay/provider.js");
  ledger: typeof import("../src/payments/ledger.js");
  db: typeof import("../src/db/index.js");
  shared: typeof import("@solvers/shared");
};

// Exposes the protected payment check, refund and reconcile step; records fulfilments instead of buying on Tempo.
function testProvider(base: Mods["provider"]["SolanaPayProvider"]) {
  return class extends base {
    readonly fulfilled: string[] = [];
    state(row: LedgerRow, now: Date) {
      return this.paymentState(row, now);
    }
    refundNow(row: LedgerRow, reason: string) {
      return this.sendRefund(row, reason);
    }
    reconcileRow(row: LedgerRow, now: Date) {
      return this.reconcileOne(row, now);
    }
    override async fulfill(chargeId: string) {
      this.fulfilled.push(chargeId);
      return this.view(await this.load(chargeId));
    }
  };
}

describe("solana pay provider (fake Solana, real ledger)", { skip }, () => {
  let m: Mods;
  let fake: FakeSolana;
  let recipient: string;
  const agentIds: string[] = [];
  let p: InstanceType<ReturnType<typeof testProvider>>;

  before(async () => {
    const kp = writeTestKeypair();
    recipient = kp.address;
    Object.assign(process.env, {
      DATABASE_URL: url,
      CHAIN_ID: "31337",
      JWT_SECRET: "j".repeat(40),
      SERVER_KEK: Buffer.alloc(32, 7).toString("base64"),
      SOLANA_PAY_ENABLED: "true",
      SOLANA_PAY_KEYPAIR: kp.path,
      SOLANA_PAY_TTL_MIN: "30",
    });
    m = {
      provider: await import("../src/solana-pay/provider.js"),
      ledger: await import("../src/payments/ledger.js"),
      db: await import("../src/db/index.js"),
      shared: await import("@solvers/shared"),
    };
    // createCharge records PLATFORM as the on-chain payer; nothing here talks to the chain.
    const chain = await import("../src/chain/index.js");
    chain.setChainContext({ accounts: { platform: { address: "0x00000000000000000000000000000000000000aa" } } } as never);
  });

  beforeEach(() => {
    fake = new FakeSolana(recipient);
    const P = testProvider(m.provider.SolanaPayProvider);
    p = new P(() => fake, { confirmTimeoutMs: 3, pollMs: 1, sleep: async () => undefined });
  });

  after(async () => {
    if (!m) return;
    const { inArray } = await import("drizzle-orm");
    if (agentIds.length) await m.db.db.delete(m.db.schema.paymentLedger).where(inArray(m.db.schema.paymentLedger.agentId, agentIds));
    await m.db.pool.end();
  });

  async function newCharge(price = PRICE) {
    const agentId = `solpay-${randomBytes(8).toString("hex")}`;
    agentIds.push(agentId);
    const intent: ChargeIntent = { kind: "license", agentId, buyer: BUYER, expectedPrice: price };
    const charge = await p.createCharge(intent, { now: new Date() });
    return (await m.ledger.loadCharge(charge.id))!;
  }
  const reload = async (id: string) => (await m.ledger.loadCharge(id))!;
  const payload = (row: { providerPayload: unknown }) => (row.providerPayload ?? {}) as Record<string, unknown>;
  const alerts = async (id: string) => (payload(await reload(id)).alerts ?? []) as string[];
  const expiresAt = (row: LedgerRow) => new Date(String(payload(row).expiresAt)).getTime();

  /** An unpaid charge already expired `agoMs` ago (on the ledger clock). */
  async function expiredCharge(agoMs: number) {
    const row = await newCharge();
    await m.ledger.patchCharge(row.id, { payload: { expiresAt: new Date(Date.now() - agoMs).toISOString() } });
    return (await m.ledger.transition(row.id, ["pending_payment"], "expired"))!;
  }

  it("create: own reference, Solana Pay URL, PNG QR and the API view; the mint is checked once", async () => {
    const row = await newCharge();
    assert.equal(row.status, "pending_payment");
    assert.equal(row.provider, "solana-pay");
    assert.match(row.id, /^sol_[0-9a-f]{24}$/);
    const c = p.toSolanaPayCharge(row);
    assert.ok(m.shared.SolanaPayCharge.safeParse(c).success, JSON.stringify(m.shared.SolanaPayCharge.safeParse(c).error?.issues));
    assert.equal(c.reference, row.providerChargeId);
    assert.equal(c.recipient, recipient);
    assert.equal(c.mint, MINT);
    assert.equal(c.cluster, "devnet");
    assert.equal(c.amount, "19");
    assert.equal(c.amountUnits, PRICE.toString());
    assert.equal(c.tokenSymbol, "USDC");
    assert.equal(c.url, `solana:${recipient}?amount=19&spl-token=${MINT}&reference=${c.reference}&label=Solvers&message=Solvers%20license&memo=${row.id}`);
    assert.deepEqual([...Buffer.from(c.qrCodeBase64, "base64").subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(c.solanaSignature, null);
    assert.equal(c.refundSignature, null);
    assert.equal(c.txHash, null);
    const other = await newCharge();
    assert.notEqual(other.providerChargeId, row.providerChargeId);
    assert.equal(fake.mintCalls, 1, "mint decimals are checked once and cached");
  });

  it("a mint whose decimals differ from the Tempo token refuses the charge (503 solana_pay_unavailable)", async () => {
    fake.decimals = 9;
    await assert.rejects(newCharge(), (e: unknown) => (e as { code?: string }).code === "solana_pay_unavailable");
    const [row] = await m.db.db
      .select()
      .from(m.db.schema.paymentLedger)
      .where((await import("drizzle-orm")).eq(m.db.schema.paymentLedger.agentId, agentIds.at(-1)!));
    assert.equal(row?.status, "failed");
  });

  it("underpaid and failed transactions keep it pending; the exact payment confirms it and binds signature and payer", async () => {
    const row = await newCharge();
    const ref = row.providerChargeId!;
    fake.pay([ref], PRICE - 1n);
    fake.pay([ref], PRICE, { failed: true });
    fake.pay([ref], PRICE, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    assert.equal((await p.confirm(row.id)).status, "pending_payment");
    const sig = fake.pay([ref], PRICE);
    assert.equal((await p.confirm(row.id)).status, "confirmed");
    const after = await reload(row.id);
    assert.equal(payload(after).solanaSignature, sig);
    assert.equal(payload(after).payer, PAYER);
    assert.equal(payload(after).paidUnits, PRICE.toString());
    const c = p.toSolanaPayCharge(after);
    assert.equal(c.solanaSignature, sig);
    assert.equal(c.solanaExplorerUrl, `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    // idempotent
    assert.equal((await p.confirm(row.id)).status, "confirmed");
  });

  it("underpaid and misdirected payments alert the admin once per charge and transaction (survives re-checks)", async () => {
    const row = await newCharge();
    const ref = row.providerChargeId!;
    const under = fake.pay([ref], PRICE - 1n);
    const stray = fake.pay([ref], PRICE, { toAccount: "AtaNotAssociated111111111111111111111111111" });
    for (let i = 0; i < 3; i++) assert.equal((await p.confirm(row.id)).status, "pending_payment");
    assert.deepEqual((await alerts(row.id)).sort(), [`misdirected:${stray}`, `underpaid:${under}`].sort());
  });

  it("RPC lag: a listed signature whose transaction cannot be read keeps the charge pending, even past the grace", async () => {
    const row = await newCharge();
    fake.lag(row.providerChargeId!);
    assert.equal(await p.state(row, new Date(expiresAt(row) + 60 * 60_000)), "pending");
  });

  it("expiry: still pending inside the 5 min grace, expired after it; a payment inside the grace still counts", async () => {
    const row = await newCharge();
    const exp = expiresAt(row);
    assert.equal(await p.state(row, new Date(exp + 4 * 60_000)), "pending");
    assert.equal(await p.state(row, new Date(exp + 6 * 60_000)), "expired");
    fake.pay([row.providerChargeId!], PRICE);
    assert.equal(await p.state(await reload(row.id), new Date(exp + 4 * 60_000)), "paid");
  });

  it("the reconcile step expires it after the grace (never on the local clock alone)", async () => {
    const row = await newCharge();
    const exp = expiresAt(row);
    assert.equal((await p.reconcileRow(row, new Date(exp + 60_000))).status, "pending_payment");
    assert.equal((await p.reconcileRow(await reload(row.id), new Date(exp + 6 * 60_000))).status, "expired");
  });

  it("late payment: an expired charge is re-scanned for 72 h; a valid payment revives it and goes to fulfilment", async () => {
    const late = await expiredCharge(2 * 60 * 60_000); // expired 2 h ago
    const quiet = await expiredCharge(3 * 60 * 60_000);
    const old = await expiredCharge(73 * 60 * 60_000); // outside the window
    assert.equal(p.lateScanOpen(late), true);
    assert.equal(p.lateScanOpen(old), false);
    fake.pay([late.providerChargeId!], PRICE);
    fake.pay([old.providerChargeId!], PRICE);
    const now = new Date();
    assert.ok((await p.scanLate(now)) >= 1);
    assert.equal((await reload(late.id)).status, "confirmed");
    assert.deepEqual(p.fulfilled, [late.id]);
    assert.equal(payload(await reload(quiet.id)).lateCheckedAt, now.toISOString(), "checked, nothing found");
    assert.equal((await reload(quiet.id)).status, "expired");
    const o = await reload(old.id);
    assert.equal(o.status, "expired");
    assert.equal(payload(o).lateCheckedAt, undefined, "not scanned after the window");
  });

  it("one Solana transaction pays one charge, even when it carries two references", async () => {
    const a = await newCharge();
    const b = await newCharge();
    fake.pay([a.providerChargeId!, b.providerChargeId!], PRICE);
    assert.equal((await p.confirm(a.id)).status, "confirmed");
    assert.equal((await p.confirm(b.id)).status, "pending_payment");
    assert.equal(payload(await reload(b.id)).solanaSignature, undefined);
  });

  async function paidAndRefunding(o: { delegated?: boolean } = {}) {
    const row = await newCharge();
    fake.pay([row.providerChargeId!], PRICE, o);
    assert.equal((await p.confirm(row.id)).status, "confirmed");
    const moving = await m.ledger.transition(row.id, ["confirmed"], "refunding", { error: "SoldOut" });
    assert.ok(moving);
    return moving;
  }
  /** Lets the next refund call take the claim at once (the real claim goes stale after STALE_REFUNDING_MS). */
  const releaseClaim = (id: string) => m.ledger.patchCharge(id, { payload: { refundClaimedAt: null } });
  const retry = async (id: string) => {
    await releaseClaim(id);
    return p.refundNow(await reload(id), "SoldOut");
  };

  it("refund: transferChecked of the amount back to the payer with a memo, journaled, sent once", async () => {
    const row = await paidAndRefunding();
    const done = await p.refundNow(row, "SoldOut");
    assert.equal(done.status, "refunded");
    assert.equal(fake.signed.length, 1);
    assert.deepEqual({ to: fake.signed[0]!.to, amount: fake.signed[0]!.amount, memo: fake.signed[0]!.memo }, { to: PAYER, amount: PRICE, memo: `refund:${row.id}` });
    const pl = payload(done);
    assert.equal(pl.refund, "solana");
    assert.equal(pl.refundSignature, "refund-1");
    assert.equal(pl.refundReason, "SoldOut");
    assert.equal(p.toSolanaPayCharge(done).refundSignature, "refund-1");
    // again: nothing is signed or sent
    assert.equal((await retry(row.id)).status, "refunded");
    assert.equal(fake.signed.length, 1);
  });

  it("refund: the journal is written before the broadcast; a retry reuses the journaled transaction once it landed", async () => {
    const row = await paidAndRefunding();
    fake.landOnBroadcast = false;
    const journaled: unknown[] = [];
    fake.onBroadcast = async (wire) => {
      journaled.push(payload(await reload(row.id)).refundSignature);
    };
    await assert.rejects(p.refundNow(row, "SoldOut"), /not confirmed yet/);
    assert.equal(journaled[0], "refund-1", "the signature was on the ledger before the first broadcast");
    let now = await reload(row.id);
    assert.equal(now.status, "refunding");
    assert.equal(p.toSolanaPayCharge(now).refundSignature, null, "not shown until it is final");
    // While its blockhash is valid it is only rebroadcast, never replaced.
    await assert.rejects(retry(row.id), /not confirmed yet/);
    assert.equal(fake.signed.length, 1);
    // It lands later: the retry reuses it.
    fake.statuses.set("refund-1", "confirmed");
    now = await retry(row.id);
    assert.equal(now.status, "refunded");
    assert.equal(payload(now).refundSignature, "refund-1");
    assert.equal(fake.signed.length, 1);
  });

  it("refund: only after the journaled transaction expired, and a second look found nothing, is a new one signed", async () => {
    const row = await paidAndRefunding();
    fake.landOnBroadcast = false;
    await assert.rejects(p.refundNow(row, "SoldOut"), /not confirmed yet/);
    assert.equal(fake.signed.length, 1);
    const firstSlot = fake.signed[0]!.slot;
    fake.height += 1_000n; // past lastValidBlockHeight + margin, refund-1 never seen
    fake.landOnBroadcast = true;
    const done = await retry(row.id);
    assert.equal(done.status, "refunded");
    assert.equal(fake.signed.length, 2);
    assert.deepEqual(fake.memoScans, [{ memo: `refund:${row.id}`, sinceSlot: firstSlot }], "memo history scanned back to the first refund");
    assert.equal(payload(done).refundSignature, "refund-2");
    assert.equal(payload(done).refundAttempts, 2);
  });

  it("refund: an RPC that says 'never seen' is double-checked; the transaction itself or a memo hit is reused, never doubled", async () => {
    // The transaction can be read even though getSignatureStatuses does not know it.
    const a = await paidAndRefunding();
    fake.landOnBroadcast = false;
    await assert.rejects(p.refundNow(a, "SoldOut"), /not confirmed yet/);
    fake.height += 1_000n;
    fake.txs.set("refund-1", { err: null, accountKeys: [], signers: [], preTokenBalances: [], postTokenBalances: [] });
    const doneA = await retry(a.id);
    assert.equal(doneA.status, "refunded");
    assert.equal(payload(doneA).refundSignature, "refund-1");
    assert.equal(fake.signed.length, 1);

    // Neither status nor transaction, but the recipient account history has a transaction with this charge's memo.
    const b = await paidAndRefunding();
    await assert.rejects(p.refundNow(b, "SoldOut"), /not confirmed yet/);
    assert.equal(fake.signed.length, 2);
    fake.height += 1_000n;
    fake.memoHits.set(`refund:${b.id}`, "refund-2");
    const doneB = await retry(b.id);
    assert.equal(doneB.status, "refunded");
    assert.equal(payload(doneB).refundSignature, "refund-2");
    assert.equal(fake.signed.length, 2, "no replacement was signed");
  });

  it("refund: a journaled transaction that landed but failed gets a fresh one, at most 3 times, then manual (alert once)", async () => {
    const row = await paidAndRefunding();
    fake.failOnBroadcast = true;
    await assert.rejects(p.refundNow(row, "SoldOut"), /needs an admin/);
    assert.equal(fake.signed.length, 3);
    let now = await reload(row.id);
    assert.equal(now.status, "refunding");
    assert.equal(now.error, m.provider.REFUND_MANUAL_REQUIRED);
    assert.equal(payload(now).refundFailures, 3);
    assert.deepEqual(await alerts(row.id), ["refund-manual"]);
    // The reconcile job leaves it alone (even long after the claim went stale).
    now = await p.reconcileRow(now, new Date(Date.now() + 24 * 60 * 60_000));
    assert.equal(now.status, "refunding");
    assert.equal(fake.signed.length, 3);
  });

  it("refund: a payment with no signer that paid (delegated, e.g. out of a vault) is manual: nothing sent, alert once", async () => {
    const row = await paidAndRefunding({ delegated: true });
    assert.equal(payload(await reload(row.id)).payer, null);
    await assert.rejects(p.refundNow(row, "SoldOut"), /needs an admin/);
    await assert.rejects(retry(row.id), /needs an admin/);
    assert.equal(fake.signed.length, 0);
    const now = await reload(row.id);
    assert.equal(now.status, "refunding");
    assert.equal(now.error, m.provider.REFUND_MANUAL_REQUIRED);
    assert.match(String(payload(now).refundManual), /signer/);
    assert.deepEqual(await alerts(row.id), ["refund-manual"], "alerted once");
    assert.equal(p.toSolanaPayCharge(now).refundSignature, null);
    assert.equal((await p.reconcileRow(now, new Date(Date.now() + 24 * 60 * 60_000))).status, "refunding");
    assert.equal(fake.signed.length, 0);
  });

  it("refund: a rotated recipient key (the charge was paid to another wallet) is manual", async () => {
    const row = await paidAndRefunding();
    fake.currentRecipient = "RotatedKey111111111111111111111111111111111";
    await assert.rejects(p.refundNow(row, "SoldOut"), /needs an admin/);
    assert.equal(fake.signed.length, 0);
    const now = await reload(row.id);
    assert.equal(now.error, m.provider.REFUND_MANUAL_REQUIRED);
    assert.match(String(payload(now).refundManual), /SOLANA_PAY_KEYPAIR is now/);
  });

  it("refund: concurrent calls on one refunding charge sign once (claim)", async () => {
    const row = await paidAndRefunding();
    const results = await Promise.all([p.refundNow(row, "SoldOut"), p.refundNow(row, "SoldOut"), p.refundNow(row, "SoldOut")]);
    assert.equal(fake.signed.length, 1);
    assert.ok(results.some((r) => r.status === "refunded"));
    assert.equal((await reload(row.id)).status, "refunded");
  });
});
