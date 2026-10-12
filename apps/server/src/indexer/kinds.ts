// Which money-moving events become a `chain_txs` row, and with which amounts (pure). Amounts always come from the
// event fields (D9: never from token balance deltas).

export type ChainTxKind = "purchase" | "credits" | "escrow" | "royalty" | "release" | "refund" | "slash" | "claim" | "stake";

export type ChainTxSpec = {
  kind: ChainTxKind;
  /** Whose history the row belongs to (buyer, payer of the royalty, claimer, creator for stake/slash). */
  wallet: string | null;
  /** Gross amount moved. Stake withdrawals are negative (stake returned to the creator). */
  amount: bigint;
  fee: bigint | null;
  creatorAmount: bigint | null;
  creatorWallet: string | null;
  feeBps: number | null;
};

/** What the event alone does not say: the agent's creator, or the escrow's parties and frozen fee. */
export type KindContext = {
  creator?: string | null;
  escrow?: { buyer: string; creator: string; feeBps: number } | null;
};

export type EventLike = { eventName: string; args: Readonly<Record<string, unknown>> };

const lower = (v: unknown): string | null => (typeof v === "string" ? v.toLowerCase() : null);
const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(v as number | string));

/** Fee in bps implied by an executed split (rounded); null for a zero gross. */
export function impliedFeeBps(gross: bigint, fee: bigint): number | null {
  if (gross <= 0n) return null;
  return Number((fee * 10_000n + gross / 2n) / gross);
}

export function chainTxFor(ev: EventLike, ctx: KindContext = {}): ChainTxSpec | null {
  const a = ev.args;
  const creator = lower(ctx.creator ?? null);
  switch (ev.eventName) {
    case "LicensePurchased": {
      const price = big(a.price);
      const fee = big(a.fee);
      return { kind: "purchase", wallet: lower(a.buyer), amount: price, fee, creatorAmount: big(a.creatorAmount), creatorWallet: creator, feeBps: impliedFeeBps(price, fee) };
    }
    case "CreditsBought": {
      const total = big(a.total);
      const fee = big(a.fee);
      return { kind: "credits", wallet: lower(a.buyer), amount: total, fee, creatorAmount: big(a.creatorAmount), creatorWallet: creator, feeBps: impliedFeeBps(total, fee) };
    }
    case "EscrowCreated":
      // Deposit into the escrow: nothing reached the creator or the platform yet.
      return { kind: "escrow", wallet: lower(a.buyer), amount: big(a.total), fee: null, creatorAmount: null, creatorWallet: creator, feeBps: Number(a.feeBps) };
    case "RoyaltyPaid": {
      const c = big(a.creatorAmount);
      const p = big(a.platformAmount);
      return { kind: "royalty", wallet: lower(a.from), amount: c + p, fee: p, creatorAmount: c, creatorWallet: lower(a.creator), feeBps: null };
    }
    case "MilestonePaid": {
      const amount = big(a.amount);
      const fee = big(a.fee);
      return {
        kind: "release",
        wallet: lower(ctx.escrow?.buyer ?? null),
        amount,
        fee,
        creatorAmount: amount - fee,
        creatorWallet: lower(a.creator),
        feeBps: ctx.escrow?.feeBps ?? impliedFeeBps(amount, fee),
      };
    }
    case "MilestoneRefunded":
      // The money went back to the buyer: nothing to the platform or the creator.
      return { kind: "refund", wallet: lower(a.buyer), amount: big(a.amount), fee: 0n, creatorAmount: 0n, creatorWallet: lower(ctx.escrow?.creator ?? null), feeBps: null };
    case "SlashExecuted":
      // Confiscated stake goes to the treasury.
      return { kind: "slash", wallet: creator, amount: big(a.amount), fee: big(a.amount), creatorAmount: 0n, creatorWallet: creator, feeBps: null };
    case "PayoutClaimed":
      return { kind: "claim", wallet: lower(a.to), amount: big(a.amount), fee: null, creatorAmount: null, creatorWallet: null, feeBps: null };
    case "StakePulled":
    case "StakeToppedUp":
      return { kind: "stake", wallet: lower(a.creator), amount: big(a.amount), fee: null, creatorAmount: null, creatorWallet: lower(a.creator), feeBps: null };
    case "StakeWithdrawn":
      return { kind: "stake", wallet: lower(a.creator), amount: -big(a.amount), fee: null, creatorAmount: null, creatorWallet: lower(a.creator), feeBps: null };
    default:
      return null;
  }
}
