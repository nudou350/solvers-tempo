import type { Deployment, RelayPolicy } from "@solvers/chain";
import type { Address, Hex } from "viem";

// Pure rules of the platform relay (decisions.md D3): policy from env, sender check, daily gas quotas and the call
// summary written to relay_log. No env or database: tested in test/relay-rules.test.ts.

export const QUOTA_WINDOW_MS = 24 * 3600 * 1000;

export type RelayLimits = {
  maxGasPerTx: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Gas (sum of sponsored gas limits) per wallet per rolling 24 h. */
  dailyGasPerWallet: bigint;
  /** Gas per client network (IPv4 address or IPv6 /64, see `quotaIpKey`) per rolling 24 h. */
  dailyGasPerIp: bigint;
  /** Gas of every sponsored transaction together per rolling 24 h: the ceiling of what the RELAY key can spend. */
  dailyGasGlobal: bigint;
};

/**
 * The network a quota is counted against: the IPv4 address (also when IPv4-mapped), or the /64 prefix of an IPv6 address
 * (a single client usually controls a whole /64, so per-address quotas would be trivial to rotate around).
 */
export function quotaIpKey(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1]!;
  if (!v.includes(":")) return v;
  const [head = "", tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The sponsorship policy: our six contracts, the payment token as the only token target and the only fee token. */
export function relayPolicy(chainId: number, d: Pick<Deployment, "registry" | "license" | "credits" | "reviews" | "escrow" | "staking">, paymentToken: Address, l: RelayLimits): RelayPolicy {
  return {
    chainId,
    contracts: [d.registry, d.license, d.credits, d.reviews, d.escrow, d.staking],
    token: paymentToken,
    feeToken: paymentToken,
    maxGasPerTx: l.maxGasPerTx,
    maxFeePerGas: l.maxFeePerGas,
    maxPriorityFeePerGas: l.maxPriorityFeePerGas,
  };
}

/** The sender must be the session wallet: the relay never sponsors a transaction for someone else's account. */
export function senderRefusal(from: string | undefined, sessionWallet: string | undefined): string | null {
  if (!sessionWallet) return "no session";
  if (!from) return "transaction has no sender";
  return from.toLowerCase() === sessionWallet.toLowerCase() ? null : "sender does not match the session wallet";
}

/** Refusal when sponsoring `gas` more would exceed a daily quota (usage = gas already sponsored or reserved). */
export const GLOBAL_QUOTA_REFUSAL = "daily sponsorship budget of the platform exhausted";

export function quotaRefusal(
  gas: bigint,
  used: { wallet: bigint; ip: bigint | null; global: bigint },
  l: Pick<RelayLimits, "dailyGasPerWallet" | "dailyGasPerIp" | "dailyGasGlobal">,
): string | null {
  if (used.wallet + gas > l.dailyGasPerWallet) return "daily gas quota of this wallet exhausted";
  if (used.ip !== null && used.ip + gas > l.dailyGasPerIp) return "daily gas quota of this network address exhausted";
  if (used.global + gas > l.dailyGasGlobal) return GLOBAL_QUOTA_REFUSAL;
  return null;
}

/** What relay_log stores about the calls: target and 4-byte selector (never the calldata). */
export function callsSummary(calls: readonly { to?: Address | null | undefined; data?: Hex | undefined }[] | undefined): { to: string; selector: string }[] {
  return (calls ?? []).map((c) => ({ to: (c.to ?? "").toLowerCase(), selector: (c.data ?? "0x").slice(0, 10).toLowerCase() }));
}
