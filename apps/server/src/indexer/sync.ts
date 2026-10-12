// "Read the contract state by id (eth_call) and mirror it into the database" (D9). Every function is idempotent: the
// mirror always reflects the CURRENT chain state, so any number of replays, in any order, converges.
//
// `read*` functions only call the RPC (optionally memoized per indexer run in `Reads`); `write*` functions only touch
// the database (a transaction or `db`); `sync*` = read + write, for callers outside the indexer (store, jobs, CLIs).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { decodeSolversError } from "@solvers/chain";
import { solversCreditsAbi, solversEscrowAbi, solversLicenseAbi, solversRegistryAbi, solversReviewsAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, bytes32ToAgentId } from "@solvers/shared";
import { chainContext } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { PLATFORM_AGENT_IDS } from "../runtime/platform-agents.js";
import { resolvePublishedText } from "../store/review-rules.js";
import { withApprovalFlag, type ApprovedVersion } from "./approved-version.js";
import type { Q } from "./db-types.js";
import { autoReleaseAtOf, escrowStatusFromMilestones, MILESTONE_STATUS, mirroredMilestoneStatus } from "./escrow-status.js";
import type { ChainTxSpec } from "./kinds.js";
import { upsertLicenseRow } from "./license-mirror.js";
import { agentMirrorValues, type AgentChainState } from "./mirror.js";

// ---------- ids and read memo ----------

/** Memo of RPC reads for one indexer run (state is read at `latest`, which is at or past every block of the run). */
export type Reads = Map<string, Promise<unknown>>;
export const newReads = (): Reads => new Map();

function memo<T>(reads: Reads | undefined, key: string, fn: () => Promise<T>): Promise<T> {
  if (!reads) return fn();
  const hit = reads.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = fn();
  reads.set(key, p);
  p.catch(() => reads.delete(key));
  return p;
}

/** DB id (32 hex, D1) of an on-chain agentId; null when the id is not D1-shaped (low 16 bytes not zero). */
export function dbAgentIdOf(agentId: string): string | null {
  try {
    return bytes32ToAgentId(agentId);
  } catch {
    return null;
  }
}

/** bytes32 agentId for a DB id (32 hex) or an already bytes32 value. */
export function agentBytes32(id: string): Hex {
  const s = id.trim().toLowerCase();
  return (s.length === 66 && s.startsWith("0x") ? s : agentIdToBytes32(s)) as Hex;
}

/**
 * An on-chain agent with the fixed id of a platform Solver is NOT the platform's: `registerAgent` is public and any
 * wallet can register that id. The indexer ignores it entirely (warning in the log); otherwise the platform row would be
 * overwritten.
 */
export class PlatformAgentIgnored extends Error {
  constructor(readonly agentId: string) {
    super(`on-chain agent uses the reserved platform id ${agentId}: ignored`);
    this.name = "PlatformAgentIgnored";
  }
}

/** The DB id to mirror for an on-chain agentId, or null (foreign id shape or reserved platform id: not mirrored). */
export function mirrorableAgentId(agentId: string): string | null {
  const id = dbAgentIdOf(agentId);
  if (!id) {
    console.warn(`[indexer] agent ${agentId} is not a package id (D1): not mirrored`);
    return null;
  }
  if (PLATFORM_AGENT_IDS.includes(id)) {
    console.warn(`[indexer] WARNING: the reserved platform id ${id} was registered on-chain; ignored (the platform row is not mirrored)`);
    return null;
  }
  return id;
}

const lower = (a: string) => a.toLowerCase();
const isRevert = (e: unknown, name: string) => decodeSolversError(e).name === name;
const unixDate = (secs: number | bigint): Date | null => (Number(secs) > 0 ? new Date(Number(secs) * 1000) : null);
const ctx = () => chainContext();

// ---------- agents ----------

/**
 * Versions approved by review (`agent_published_versions`), most recent first: the chain is checked against them
 * (PACKAGE_SPEC.md 15.4).
 */
export async function loadApprovedVersions(agentId: string, q: Q = db): Promise<ApprovedVersion[]> {
  const t = schema.agentPublishedVersions;
  return q
    .select({ version: t.version, versionHash: t.versionHash, priceUsdc: t.priceUsdc })
    .from(t)
    .where(eq(t.agentId, agentId))
    .orderBy(desc(t.approvedAt));
}

/** Reads the agent (Registry `getAgent` + `currentEval`, Reviews `ratingOf`, Credits `verifiedUsesOf`); null if absent. */
export function readAgent(agentId: string, reads?: Reads): Promise<AgentChainState | null> {
  const b32 = agentBytes32(agentId);
  return memo(reads, `agent:${b32}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    const reg = { address: d.registry, abi: solversRegistryAbi } as const;
    let view;
    try {
      view = await pc.readContract({ ...reg, functionName: "getAgent", args: [b32] });
    } catch (e) {
      if (isRevert(e, "AgentNotFound")) return null;
      throw e;
    }
    const [[measured, ev], [sum, count], uses] = await Promise.all([
      pc.readContract({ ...reg, functionName: "currentEval", args: [b32] }),
      pc.readContract({ address: d.reviews, abi: solversReviewsAbi, functionName: "ratingOf", args: [b32] }),
      pc.readContract({ address: d.credits, abi: solversCreditsAbi, functionName: "verifiedUsesOf", args: [b32] }),
    ]);
    return {
      agentId: dbAgentIdOf(b32) ?? b32.slice(2),
      view: {
        creator: lower(view.creator),
        status: Number(view.status),
        royaltyBps: Number(view.royaltyBps),
        totalSales: Number(view.totalSales),
        maxSupply: Number(view.maxSupply),
        price: view.price,
        pricePerUse: view.pricePerUse,
        disputesLost: Number(view.disputesLost),
        index: Number(view.index),
        stake: view.stake,
        versionHash: view.versionHash,
        version: view.version,
      },
      eval: { measured, scoreBps: Number(ev.scoreBps), evalHash: ev.evalHash },
      rating: { sum, count: Number(count) },
      verifiedUses: uses,
    };
  });
}

/** The agent's versionHash at `blockNumber` (historical eth_call); falls back to the current one when the node has pruned that state. */
export async function readVersionHashAt(agentId: string, blockNumber: bigint, reads?: Reads): Promise<Hex | null> {
  const b32 = agentBytes32(agentId);
  return memo(reads, `version:${b32}:${blockNumber}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    try {
      const v = await pc.readContract({ address: d.registry, abi: solversRegistryAbi, functionName: "getAgent", args: [b32], blockNumber });
      return lower(v.versionHash) as Hex;
    } catch (e) {
      if (isRevert(e, "AgentNotFound")) return null;
      const cur = await readAgent(agentId, reads);
      return cur ? (lower(cur.view.versionHash) as Hex) : null;
    }
  });
}

/** Eval stored for a given version (`evalOf`); null when that version was never measured. */
export async function readEvalOf(agentId: string, versionHash: Hex): Promise<{ scoreBps: number; evalHash: Hex } | null> {
  const { publicClient: pc, deployment: d } = ctx();
  const e = await pc.readContract({ address: d.registry, abi: solversRegistryAbi, functionName: "evalOf", args: [agentBytes32(agentId), versionHash] });
  return e.at === 0 ? null : { scoreBps: Number(e.scoreBps), evalHash: e.evalHash };
}

/**
 * Mirrors the agent. Version, hash and price are NOT copied blindly: the creator may call updateVersion/updatePricing
 * directly on-chain without review. They are written only if they match an approved version
 * (`agent_published_versions`); otherwise the row keeps the approved ones and `sync_flag` becomes
 * `unapproved_chain_version` (sales blocked; PACKAGE_SPEC.md 15.4). Never writes `platform_status`.
 */
export async function mirrorAgentAccount(s: AgentChainState, q: Q = db): Promise<string> {
  const id = s.agentId;
  if (PLATFORM_AGENT_IDS.includes(id)) throw new PlatformAgentIgnored(id);
  const full = agentMirrorValues(s);
  const approved = await loadApprovedVersions(id, q);
  const guarded = withApprovalFlag(full, approved);
  const updated = await q.update(schema.agents).set(guarded).where(eq(schema.agents.id, id)).returning({ id: schema.agents.id });
  if (updated.length === 0) {
    // No row yet (registered outside the publication flow, or the catalog row is written later): keep a minimal unlisted
    // row so the mirror is not lost. A diverging chain version never lands in it: the latest approved one does, if any.
    const latestApproved = guarded.syncFlag !== "ok" ? approved[0] : undefined;
    const versionCols = latestApproved
      ? { version: latestApproved.version, versionHash: latestApproved.versionHash.toLowerCase(), price: latestApproved.priceUsdc }
      : {};
    await q
      .insert(schema.agents)
      .values({
        id,
        slug: id,
        name: "Uncatalogued Solver",
        tagline: "",
        description: "",
        category: "Other",
        creatorId: s.view.creator,
        listed: false,
        ...full,
        ...versionCols,
        syncFlag: guarded.syncFlag,
      })
      .onConflictDoNothing();
  }
  return id;
}

/** Writes the eval of a version that is not the current one (D6: kept with its versionHash, read as "not measured"). */
export async function writeEval(q: Q, agentId: string, versionHash: Hex, e: { scoreBps: number; evalHash: Hex }): Promise<void> {
  await q
    .update(schema.agents)
    .set({ evalScoreBps: e.scoreBps, evalHash: lower(e.evalHash), evalVersionHash: lower(versionHash).replace(/^0x/, "") })
    .where(eq(schema.agents.id, agentId));
}

/** Re-reads and mirrors one agent (DB id or bytes32). Returns the DB id, or null when absent / not mirrorable. */
export async function syncAgent(agentId: string, reads?: Reads): Promise<string | null> {
  const id = mirrorableAgentId(agentBytes32(agentId));
  if (!id) return null;
  const s = await readAgent(id, reads);
  return s ? mirrorAgentAccount(s) : null;
}

// ---------- reputation ----------

export type ReputationState = { purchases: number; disputesOpened: number; disputesLost: number };

export function readReputation(wallet: string, reads?: Reads): Promise<ReputationState> {
  return memo(reads, `rep:${lower(wallet)}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    const r = await pc.readContract({ address: d.registry, abi: solversRegistryAbi, functionName: "reputationOf", args: [wallet as Address] });
    return { purchases: Number(r.purchases), disputesOpened: Number(r.disputesOpened), disputesLost: Number(r.disputesLost) };
  });
}

export async function writeReputation(q: Q, wallet: string, r: ReputationState): Promise<void> {
  const values = { ...r, updatedAt: new Date() };
  await q
    .insert(schema.userReputation)
    .values({ wallet: lower(wallet), ...values })
    .onConflictDoUpdate({ target: schema.userReputation.wallet, set: values });
}

export async function syncReputation(wallet: string): Promise<void> {
  await writeReputation(db, wallet, await readReputation(wallet));
}

// ---------- credits ----------

export type CreditsState = { remaining: number; purchased: number };

export function readCredits(agentId: string, owner: string, reads?: Reads): Promise<CreditsState> {
  const b32 = agentBytes32(agentId);
  return memo(reads, `credits:${b32}:${lower(owner)}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    const [remaining, purchased] = await pc.readContract({ address: d.credits, abi: solversCreditsAbi, functionName: "creditsOf", args: [b32, owner as Address] });
    return { remaining: Number(remaining), purchased: Number(purchased) };
  });
}

export async function writeCredits(q: Q, agentId: string, owner: string, c: CreditsState): Promise<void> {
  const values = { ...c, updatedAt: new Date() };
  await q
    .insert(schema.credits)
    .values({ agentId, ownerWallet: lower(owner), ...values })
    .onConflictDoUpdate({ target: [schema.credits.agentId, schema.credits.ownerWallet], set: values });
}

export async function syncCredits(agentId: string, owner: string): Promise<void> {
  const id = mirrorableAgentId(agentBytes32(agentId));
  if (id) await writeCredits(db, id, owner, await readCredits(id, owner));
}

// ---------- reviews ----------

export type ReviewState = { rating: number; createdAt: number; updatedAt: number; tokenId: bigint; contentHash: Hex };

export function readReview(agentId: string, author: string, reads?: Reads): Promise<ReviewState | null> {
  const b32 = agentBytes32(agentId);
  return memo(reads, `review:${b32}:${lower(author)}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    const r = await pc.readContract({ address: d.reviews, abi: solversReviewsAbi, functionName: "reviewOf", args: [b32, author as Address] });
    if (r.createdAt === 0) return null;
    return { rating: Number(r.rating), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt), tokenId: BigInt(r.tokenId), contentHash: r.contentHash };
  });
}

/**
 * Mirrors a review. The text is off-chain: only what the confirmed hash proves is published (a draft with the same
 * hash, or the text already published); a review made directly on-chain gets "". `versionHash` (agent version at
 * submission, D6) is written only when given; otherwise the stored one is kept.
 */
export async function writeReview(q: Q, agentId: string, author: string, r: ReviewState, versionHash?: string | null): Promise<void> {
  const authorWallet = lower(author);
  const contentHash = lower(r.contentHash);
  const bare = contentHash.replace(/^0x/, "");
  const drafts = schema.reviewDrafts;
  const draftWhere = and(eq(drafts.agentId, agentId), eq(drafts.authorWallet, authorWallet), inArray(drafts.contentHash, [contentHash, bare]));
  const [draft] = await q.select({ text: drafts.text }).from(drafts).where(draftWhere);
  const [current] = await q
    .select({ text: schema.reviews.text })
    .from(schema.reviews)
    .where(and(eq(schema.reviews.agentId, agentId), eq(schema.reviews.authorWallet, authorWallet)));
  const text = resolvePublishedText(bare, [draft?.text, current?.text]);
  const tokenId = r.tokenId > 0n ? r.tokenId.toString() : null;
  const set = { rating: r.rating, text, contentHash, tokenId, onchain: true, ...(versionHash ? { versionHash: lower(versionHash).replace(/^0x/, "") } : {}) };
  await q
    .insert(schema.reviews)
    .values({ id: `${agentId}:${authorWallet}`, agentId, authorWallet, createdAt: unixDate(r.createdAt) ?? new Date(), versionHash: versionHash ? lower(versionHash).replace(/^0x/, "") : null, ...set })
    .onConflictDoUpdate({ target: [schema.reviews.agentId, schema.reviews.authorWallet], set });
  if (draft) await q.delete(drafts).where(draftWhere);
}

export async function syncReview(agentId: string, author: string): Promise<void> {
  const id = mirrorableAgentId(agentBytes32(agentId));
  if (!id) return;
  const r = await readReview(id, author);
  if (r) await writeReview(db, id, author, r);
}

// ---------- licenses ----------

export type LicenseState = { tokenId: bigint; agentId: Hex; originalPrice: bigint; mintedAt: number; reviewId: bigint; owner: string | null };

/** `licenseOf` + `ownerOf`; null when the token was never minted; `owner` null when burned. */
export function readLicense(tokenId: bigint, reads?: Reads): Promise<LicenseState | null> {
  return memo(reads, `license:${tokenId}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    const lic = { address: d.license, abi: solversLicenseAbi } as const;
    let data;
    try {
      data = await pc.readContract({ ...lic, functionName: "licenseOf", args: [tokenId] });
    } catch (e) {
      if (isRevert(e, "ERC721NonexistentToken")) return null;
      throw e;
    }
    let owner: string | null = null;
    try {
      owner = lower(await pc.readContract({ ...lic, functionName: "ownerOf", args: [tokenId] }));
    } catch (e) {
      if (!isRevert(e, "ERC721NonexistentToken")) throw e;
    }
    const [agentId, originalPrice, mintedAt, reviewId] = data;
    return { tokenId, agentId, originalPrice, mintedAt: Number(mintedAt), reviewId, owner };
  });
}

/** Mirrors a license read from the chain. Returns the current owner (null = burned, or not mirrorable). */
export async function writeLicense(
  q: Q,
  l: LicenseState,
  extra: { acquiredAt?: Date | null; lastOwner?: string | null; txHash?: string | null; versionHash?: string | null } = {},
): Promise<string | null> {
  const agentId = mirrorableAgentId(l.agentId);
  if (!agentId) return null;
  await upsertLicenseRow(q, {
    tokenId: l.tokenId.toString(),
    agentId,
    owner: l.owner,
    lastOwner: extra.lastOwner ?? null,
    originalPrice: l.originalPrice,
    reviewId: l.reviewId > 0n ? l.reviewId.toString() : null,
    acquiredAt: extra.acquiredAt ?? unixDate(l.mintedAt) ?? new Date(),
    txHash: extra.txHash ?? null,
    versionHash: extra.versionHash ?? null,
  });
  return l.owner;
}

/** Re-reads one license and mirrors it (store/runtime ownership re-check). Returns the current owner or null. */
export async function syncLicense(tokenId: bigint | string): Promise<string | null> {
  const l = await readLicense(BigInt(tokenId));
  return l ? writeLicense(db, l, { acquiredAt: new Date() }) : null;
}

/** Ownership re-check of a license (alias kept for the store and runtime). */
export const refreshLicenseOwner = syncLicense;

// ---------- escrows ----------

export type MilestoneState = {
  amount: bigint;
  status: number;
  passedAt: number;
  disputedAt: number;
  criteriaHash: Hex;
  deliverableHash: Hex;
  disputeReasonHash: Hex;
};
export type EscrowState = {
  escrowId: bigint;
  buyer: string;
  agentId: Hex;
  creator: string;
  total: bigint;
  feeBps: number;
  reviewWindowSecs: number;
  deliveryDeadline: number;
  milestones: MilestoneState[];
};

export function readEscrow(escrowId: bigint, reads?: Reads): Promise<EscrowState | null> {
  return memo(reads, `escrow:${escrowId}`, async () => {
    const { publicClient: pc, deployment: d } = ctx();
    let r;
    try {
      r = await pc.readContract({ address: d.escrow, abi: solversEscrowAbi, functionName: "escrowOf", args: [escrowId] });
    } catch (e) {
      if (isRevert(e, "EscrowNotFound")) return null;
      throw e;
    }
    const [buyer, agentId, creator, total, feeBps, reviewWindowSecs, deliveryDeadline, ms] = r;
    return {
      escrowId,
      buyer: lower(buyer),
      agentId,
      creator: lower(creator),
      total,
      feeBps: Number(feeBps),
      reviewWindowSecs: Number(reviewWindowSecs),
      deliveryDeadline: Number(deliveryDeadline),
      milestones: ms.map((m) => ({
        amount: m.amount,
        status: Number(m.status),
        passedAt: Number(m.passedAt),
        disputedAt: Number(m.disputedAt),
        criteriaHash: m.criteriaHash,
        deliverableHash: m.deliverableHash,
        disputeReasonHash: m.disputeReasonHash,
      })),
    };
  });
}

/**
 * Mirrors an escrow and its milestones. The escrow status is derived like the contract's `statusOf` (D19: nothing is
 * stored on-chain and nothing is ever closed). Off-chain milestone data (titles, criteria text, deliverables, verifier
 * report) is never touched; "submitted" survives a chain "pending".
 */
export async function writeEscrow(q: Q, e: EscrowState, extra: { purchaseId?: string | null; txHash?: string | null } = {}): Promise<boolean> {
  const agentId = mirrorableAgentId(e.agentId);
  if (!agentId) return false;
  const id = e.escrowId.toString();
  const names = e.milestones.map((m) => MILESTONE_STATUS[m.status] ?? "pending");
  const status = escrowStatusFromMilestones(names);
  const auto = autoReleaseAtOf(
    e.milestones.map((m, i) => ({ status: names[i]!, passedAt: m.passedAt })),
    e.reviewWindowSecs,
  );
  const t = schema.escrows;
  const common = {
    status,
    autoReleaseAt: unixDate(auto),
    total: e.total,
    creatorWallet: e.creator,
    reviewWindowSecs: e.reviewWindowSecs,
    deliveryDeadline: unixDate(e.deliveryDeadline),
    feeBps: e.feeBps,
  };
  await q
    .insert(t)
    .values({ id, agentId, buyerWallet: e.buyer, purchaseId: extra.purchaseId?.toLowerCase() ?? null, txHash: extra.txHash?.toLowerCase() ?? null, ...common })
    .onConflictDoUpdate({
      target: t.id,
      set: { ...common, purchaseId: sql`coalesce(${t.purchaseId}, excluded.purchase_id)`, txHash: sql`coalesce(${t.txHash}, excluded.tx_hash)` },
    });

  const ms = schema.milestones;
  const existing = await q.select({ idx: ms.idx, status: ms.status, disputedAt: ms.disputedAt }).from(ms).where(eq(ms.escrowId, id));
  for (const [idx, m] of e.milestones.entries()) {
    const chainStatus = names[idx]!;
    const cur = existing.find((r) => r.idx === idx);
    const passedAt = unixDate(m.passedAt);
    const disputedAt = unixDate(m.disputedAt);
    if (cur) {
      await q
        .update(ms)
        .set({ status: mirroredMilestoneStatus(chainStatus, cur.status), passedAt, amount: m.amount, ...(disputedAt ? { disputedAt } : {}) })
        .where(and(eq(ms.escrowId, id), eq(ms.idx, idx)));
    } else {
      await q
        .insert(ms)
        .values({ escrowId: id, idx, title: `Step ${idx + 1}`, criteria: "", criteriaHash: lower(m.criteriaHash), amount: m.amount, status: chainStatus, passedAt, disputedAt })
        .onConflictDoNothing();
    }
  }
  return true;
}

/** Re-reads and mirrors one escrow (jobs, verifier). False when it does not exist on-chain or is not mirrorable. */
export async function syncEscrow(escrowId: bigint | string): Promise<boolean> {
  const e = await readEscrow(BigInt(escrowId));
  return e ? writeEscrow(db, e) : false;
}

// ---------- deferred payouts ----------

/** `deferredOf(recipient)` on one of the paying contracts (License, Credits, Escrow, Staking share `SolversPayouts`). */
export async function readDeferred(contract: string, recipient: string): Promise<bigint> {
  return ctx().publicClient.readContract({ address: contract as Address, abi: solversEscrowAbi, functionName: "deferredOf", args: [recipient as Address] });
}

export async function writeDeferred(q: Q, contract: string, recipient: string, amount: bigint): Promise<void> {
  const values = { amount, updatedAt: new Date() };
  await q
    .insert(schema.payoutsDeferred)
    .values({ contract: lower(contract), recipient: lower(recipient), ...values })
    .onConflictDoUpdate({ target: [schema.payoutsDeferred.contract, schema.payoutsDeferred.recipient], set: values });
}

// ---------- chain_txs ----------

/** Records one money-moving event (idempotent per (tx_hash, log_index); a replay refreshes the same row). */
export async function recordChainTx(
  q: Q,
  ref: { txHash: string; logIndex: number; blockNumber: bigint; blockTime: Date | null; agentId: string | null },
  spec: ChainTxSpec,
): Promise<void> {
  const values = {
    wallet: spec.wallet,
    kind: spec.kind,
    agentId: ref.agentId,
    amount: spec.amount,
    fee: spec.fee,
    creatorAmount: spec.creatorAmount,
    creatorWallet: spec.creatorWallet,
    feeBps: spec.feeBps,
    blockNumber: ref.blockNumber,
    blockTime: ref.blockTime,
  };
  await q
    .insert(schema.chainTxs)
    .values({ txHash: ref.txHash.toLowerCase(), logIndex: ref.logIndex, ...values })
    .onConflictDoUpdate({ target: [schema.chainTxs.txHash, schema.chainTxs.logIndex], set: values });
}
