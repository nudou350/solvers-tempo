// DB mirror of an on-chain agent (pure: no env, no database).
// IMPORTANT: these values must NEVER contain `platformStatus`. The indexer rewrites them on every agent event; the
// platform kill switch lives in another column and survives (PACKAGE_SPEC.md 15.4).

import type { Hex } from "viem";

/** Index = on-chain `AgentStatus` (Pending, Active, Suspended, Retired). `retired` (stake exit requested) means no new
 * sales, no trial and out of the store, but PAID rights (lifetime license, open guarantee) keep working. */
export const AGENT_STATUS = ["pending", "active", "suspended", "retired"] as const;

/** `SolversRegistry.getAgent` (the fields the mirror uses). */
export type AgentView = {
  creator: string;
  status: number;
  royaltyBps: number;
  totalSales: number;
  maxSupply: number;
  price: bigint;
  pricePerUse: bigint;
  disputesLost: number;
  index: number;
  stake: bigint;
  versionHash: Hex;
  version: string;
};

/** Everything the indexer reads to mirror one agent (Registry + Reviews + Credits views). */
export type AgentChainState = {
  /** DB id: the 32-hex manifest id (D1). */
  agentId: string;
  view: AgentView;
  /** `currentEval`: the eval of the CURRENT versionHash, if measured (D6). */
  eval: { measured: boolean; scoreBps: number; evalHash: Hex };
  rating: { sum: bigint; count: number };
  verifiedUses: bigint;
};

export function agentMirrorValues(s: AgentChainState) {
  const v = s.view;
  // DB form of version hashes: 64 lowercase hex without 0x (same as the package hash and agent_published_versions).
  const versionHash = v.versionHash.toLowerCase().replace(/^0x/, "");
  return {
    version: v.version,
    versionHash,
    price: v.price,
    pricePerUse: v.pricePerUse,
    royaltyBps: v.royaltyBps,
    status: AGENT_STATUS[v.status] ?? "pending",
    totalSales: BigInt(v.totalSales),
    // maxSupply 0 = unlimited.
    maxLicenses: v.maxSupply === 0 ? null : v.maxSupply,
    verifiedUses: s.verifiedUses,
    ratingSum: s.rating.sum,
    ratingCount: s.rating.count,
    disputesLost: v.disputesLost,
    stake: v.stake,
    chainIndex: v.index,
    // D6: an eval is written only with the version it measured. When the current version has none, the columns keep
    // the last eval of an older version, which readers treat as "not measured for this version".
    ...(s.eval.measured ? { evalScoreBps: s.eval.scoreBps, evalHash: s.eval.evalHash.toLowerCase(), evalVersionHash: versionHash } : {}),
    updatedAt: new Date(),
  };
}
