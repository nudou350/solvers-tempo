import {
  CREATOR_SIGNING_STEPS,
  MAX_LICENSES_CAP,
  MAX_TOTAL_ROYALTY_BPS,
  agentIdToBytes32,
  sameAddress,
  type CreatorSigningStep,
  type PublicationStep,
  type SubmissionStatus,
} from "@solvers/shared";

// Pure rules of the on-chain publication (PACKAGE_SPEC.md 15.2 and 15.3). No env, database or network: tested in
// test/publish-rules.test.ts. Everything starts from TWO things: the approved version (frozen at approval) and the agent's
// on-chain state read on the spot. The next step never comes from the client.

/**
 * Approved version, as `package_submissions.approved` stores it (price in token base units as a decimal string).
 * `pricePerUse` (base units) and `metadataUri` are optional: when the record carries them they are part of what was
 * approved and the chain must match; without them, registration uses pay-per-use 0 and the default metadata URL, and
 * later publications keep whatever the creator set on-chain (`POST /tx/creator/:id/pricing`, `/metadata`).
 */
export type ApprovedRecord = {
  versionHash: string;
  priceUsdc: string;
  royaltyBps: number;
  name: string;
  version: string;
  pricePerUse?: string;
  metadataUri?: string;
};

export type OnchainStatus = "pending" | "active" | "suspended" | "retired";

/**
 * The agent on-chain (Registry `getAgent`), decoded: addresses lowercase, `versionHash` as 64 lowercase hex characters
 * without `0x` (the package hash format used everywhere off-chain).
 */
export type ChainAgentState =
  | { exists: false }
  | {
      exists: true;
      creator: string;
      version: string;
      versionHash: string;
      price: bigint;
      status: OnchainStatus;
      pricePerUse?: bigint;
      metadataUri?: string;
      royaltyBps?: number;
      totalSales?: number;
      /** 0 = unlimited. */
      maxSupply?: number;
      stake?: bigint;
      disputesLost?: number;
      index?: number;
    };

/**
 * A step is a creator transaction (`register-agent`, `update-version`, `update-pricing`) or something that is not theirs:
 * `await-admin-approval` (new Solver registered: the admin's `approveAgent` is missing), `ready` (the chain matches the
 * approved record and the agent is Active: publication can finish) and `blocked` (suspended/retired on-chain, or the
 * agent belongs to another creator).
 */
export type { PublicationStep };

/** The steps the creator signs. */
export type CreatorStep = CreatorSigningStep;
export const isCreatorStep = (s: PublicationStep): s is CreatorStep => (CREATOR_SIGNING_STEPS as readonly string[]).includes(s);

export function approvedPriceUnits(a: ApprovedRecord): bigint {
  return BigInt(a.priceUsdc);
}

/** Pay-per-use price the approved record fixes (null: not part of the record, the creator's on-chain value stands). */
export function approvedPricePerUse(a: ApprovedRecord): bigint | null {
  return a.pricePerUse === undefined ? null : BigInt(a.pricePerUse);
}

/**
 * Pay-per-use price to send with a reviewed `updatePricing`: the approved one when the record has it, otherwise the
 * creator's current on-chain value (never a silent 0, which would switch credits off), capped at the new license price
 * (the Registry refuses `pricePerUse > price`).
 */
export function pricePerUseFor(a: ApprovedRecord, chain: ChainAgentState): bigint {
  const fixed = approvedPricePerUse(a);
  if (fixed !== null) return fixed;
  const current = chain.exists ? (chain.pricePerUse ?? 0n) : 0n;
  const price = approvedPriceUnits(a);
  return current > price ? price : current;
}

/** The creator royalty can still change on-chain (D15: only before the first sale). */
export function royaltyEditable(chain: ChainAgentState): boolean {
  return chain.exists && (chain.totalSales ?? 0) === 0;
}

/**
 * Terms besides version and price that differ from the approved record: the creator royalty (only while it is still
 * editable), and the pay-per-use price and metadata URI (only when the record fixes them).
 */
export function termsDiffer(a: ApprovedRecord, chain: ChainAgentState): { royalty: boolean; pricePerUse: boolean; metadataUri: boolean } {
  if (!chain.exists) return { royalty: false, pricePerUse: false, metadataUri: false };
  const ppu = approvedPricePerUse(a);
  return {
    royalty: royaltyEditable(chain) && chain.royaltyBps !== undefined && chain.royaltyBps !== a.royaltyBps,
    pricePerUse: ppu !== null && chain.pricePerUse !== undefined && chain.pricePerUse !== ppu,
    metadataUri: a.metadataUri !== undefined && chain.metadataUri !== undefined && chain.metadataUri !== a.metadataUri,
  };
}

/** `approved` from the jsonb column: checks the shape before trusting it (the on-chain transaction reads everything from here). */
export function parseApproved(raw: unknown): ApprovedRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.versionHash === "string" &&
    /^[0-9a-f]{64}$/.test(r.versionHash) &&
    typeof r.priceUsdc === "string" &&
    /^\d{1,19}$/.test(r.priceUsdc) &&
    typeof r.royaltyBps === "number" &&
    Number.isInteger(r.royaltyBps) &&
    r.royaltyBps >= 0 &&
    r.royaltyBps <= 10_000 &&
    typeof r.name === "string" &&
    r.name.length > 0 &&
    typeof r.version === "string" &&
    r.version.length > 0 &&
    (r.pricePerUse === undefined || (typeof r.pricePerUse === "string" && /^\d{1,19}$/.test(r.pricePerUse))) &&
    (r.metadataUri === undefined || (typeof r.metadataUri === "string" && r.metadataUri.length > 0))
  ) {
    return {
      versionHash: r.versionHash,
      priceUsdc: r.priceUsdc,
      royaltyBps: r.royaltyBps,
      name: r.name,
      version: r.version,
      ...(typeof r.pricePerUse === "string" ? { pricePerUse: r.pricePerUse } : {}),
      ...(typeof r.metadataUri === "string" ? { metadataUri: r.metadataUri } : {}),
    };
  }
  return null;
}

/** Off-chain hash (64 hex) -> bytes32 for the contracts. */
export function toChainHash(hex: string): `0x${string}` {
  const s = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`invalid 32-byte hash: ${hex}`);
  return `0x${s}`;
}

/** bytes32 from the contracts -> the off-chain form (64 lowercase hex, no `0x`). */
export function fromChainHash(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

const sameHash = (a: string, b: string) => fromChainHash(a) === fromChainHash(b);

/**
 * What is missing to publish, comparing the chain with the approved record. Order: register (does not exist) -> version
 * (hash or version differ; the same batch also fixes the price and terms) -> price and terms (the price, the creator
 * royalty while no license was sold, and the pay-per-use price / metadata URI when the record fixes them) -> admin
 * approval (Pending) -> ready (Active).
 * Idempotent: after each confirmed transaction the step advances by itself, with no stored state.
 *
 * `wallet` (optional) is the caller's wallet: an agent owned by ANOTHER creator blocks (the Registry would refuse the
 * transaction anyway: `NotCreator`).
 */
export function nextPublicationStep(approved: ApprovedRecord, chain: ChainAgentState, wallet?: string): PublicationStep {
  if (!chain.exists) return "register-agent";
  if (wallet && !sameAddress(chain.creator, wallet)) return "blocked";
  if (chain.version !== approved.version || !sameHash(chain.versionHash, approved.versionHash)) return "update-version";
  if (chain.price !== approvedPriceUnits(approved)) return "update-pricing";
  const terms = termsDiffer(approved, chain);
  if (terms.royalty || terms.pricePerUse || terms.metadataUri) return "update-pricing";
  if (chain.status === "pending") return "await-admin-approval";
  if (chain.status === "active") return "ready";
  return "blocked";
}

/** Submission states in which the creator can still sign. */
export const SIGNABLE_STATUSES: readonly SubmissionStatus[] = ["awaiting_creator_signature"];

/** States finalization can start from (includes `publishing`: resuming a process that died). */
export const FINALIZABLE_STATUSES: readonly SubmissionStatus[] = ["awaiting_creator_signature", "awaiting_onchain_approval", "publishing", "publish_failed"];

/**
 * Submission state after reading the chain (never goes back): `ready` -> finalize; `await-admin-approval` ->
 * `awaiting_onchain_approval`; anything else keeps waiting for the creator.
 */
export function statusAfterChain(current: SubmissionStatus, step: PublicationStep): SubmissionStatus | "finalize" {
  if (!FINALIZABLE_STATUSES.includes(current)) return current;
  if (step === "ready") return "finalize";
  if (step === "await-admin-approval" && current === "awaiting_creator_signature") return "awaiting_onchain_approval";
  return current;
}

/** Short label of the step for the creator/admin (shown by the web; never a decision code). */
export const STEP_LABEL: Record<PublicationStep, string> = {
  "register-agent": "Register the Solver on the network (your signature)",
  "update-version": "Publish the new version on the network (your signature)",
  "update-pricing": "Update the price and terms on the network (your signature)",
  "await-admin-approval": "Waiting for the team's final approval",
  ready: "Ready to go live",
  blocked: "Blocked: the Solver is suspended or belongs to another wallet on the network",
};

/** Does the step requested by the route match what the chain says? Returns the expected step when it does not. */
export function stepMismatch(requested: CreatorStep, actual: PublicationStep): PublicationStep | null {
  return requested === actual ? null : actual;
}

/**
 * Transfer royalty rule (D15): the manifest's `royaltyBps` is the CREATOR share; creator + platform share must not
 * exceed 2500 bps. Returns the refusal text or null.
 */
export function royaltyProblem(creatorBps: number, platformBps: number): string | null {
  if (!Number.isInteger(creatorBps) || creatorBps < 0) return "the creator royalty must be a non-negative integer (bps)";
  if (creatorBps + platformBps > MAX_TOTAL_ROYALTY_BPS) {
    return `the creator royalty (${creatorBps} bps) plus the platform royalty (${platformBps} bps) exceeds the ${MAX_TOTAL_ROYALTY_BPS} bps cap`;
  }
  return null;
}

/** License cap from the validated manifest (`supply.maxLicenses`); undefined = unlimited / not set. */
export function maxSupplyOf(manifest: unknown): number | undefined {
  const supply = (manifest as { supply?: { maxLicenses?: unknown } } | null | undefined)?.supply;
  const max = supply?.maxLicenses;
  return typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= MAX_LICENSES_CAP ? max : undefined;
}

/**
 * `AgentRegistration` for `registerAgent` (X6), built ONLY from the approved record (pay-per-use 0 and the default
 * metadata URL unless the record fixes them).
 */
export function registrationFor(agentId: string, approved: ApprovedRecord, defaultMetadataUri: string) {
  return {
    agentId: agentIdToBytes32(agentId),
    metadataUri: approved.metadataUri ?? defaultMetadataUri,
    version: approved.version,
    versionHash: toChainHash(approved.versionHash),
    price: approvedPriceUnits(approved),
    pricePerUse: approvedPricePerUse(approved) ?? 0n,
    royaltyBps: approved.royaltyBps,
  };
}

/**
 * Is this chain touch "the" publication transaction of the submission (`register_tx`)? Only an AgentRegistered or
 * AgentVersionUpdated matching the approved version and hash: checked here for indexer events, or already by
 * `checkCreatorTx` on the confirm route (`verified`). A price change, a metadata update or another version never is.
 */
export function isPublicationTouch(
  touch: { txHash?: string; kind?: string; verified?: boolean; version?: string; versionHash?: string },
  approved: { version: string; versionHash: string } | null,
): boolean {
  if (!touch.txHash || (touch.kind !== "registered" && touch.kind !== "version") || !approved) return false;
  if (touch.verified) return true;
  return touch.version === approved.version && fromChainHash(touch.versionHash ?? "") === fromChainHash(approved.versionHash);
}

// ---------- confirmation by tx hash ----------

/** What a creator transaction did to the agent (the same names as `ChainTouch.kind` in reconcile.ts). */
export type TouchKind = "registered" | "version" | "pricing";

export const STEP_TO_TOUCH: Record<CreatorStep, TouchKind> = { "register-agent": "registered", "update-version": "version", "update-pricing": "pricing" };

/** A decoded Registry event of the confirmed receipt (args as viem decodes them). */
export type RegistryEvent = { name: string; args: Record<string, unknown> };

export type TxVerdict = { ok: true; kinds: TouchKind[] } | { ok: false; reason: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/**
 * Does a confirmed (successful) creator transaction match the approved record for this agent? Checks, per event: the
 * agent id; `AgentRegistered` carries the creator wallet, the approved version, hash, price and royalty, a pay-per-use
 * price of 0 (or the approved one) and the approved metadata URI when the record fixes it; `AgentVersionUpdated` the
 * approved version and hash; `PricingUpdated` the approved price (and pay-per-use price when the record fixes it);
 * `RoyaltyBpsSet` the approved royalty; `AgentMetadataUpdated` the approved URI when the record fixes it. The sender must
 * be the submission's creator (the Registry also requires it for updates). `kind` (when the client says which step it
 * signed) restricts the expected event; without it, any matching publication event counts. A mismatching publication
 * event fails the whole check (a transaction that wrote something the review did not see is never linked to the
 * submission).
 */
export function checkCreatorTx(
  input: { events: readonly RegistryEvent[]; from: string; success: boolean },
  expected: { agentId: string; creatorWallet: string; approved: ApprovedRecord; kind?: TouchKind },
): TxVerdict {
  if (!input.success) return { ok: false, reason: "the transaction reverted" };
  if (!sameAddress(input.from, expected.creatorWallet)) return { ok: false, reason: "the transaction was not sent by the creator's wallet" };
  const id = agentIdToBytes32(expected.agentId);
  const a = expected.approved;
  const kinds: TouchKind[] = [];
  for (const e of input.events) {
    if (str(e.args.agentId).toLowerCase() !== id) continue;
    if (e.name === "AgentRegistered") {
      if (!sameAddress(str(e.args.creator), expected.creatorWallet)) return { ok: false, reason: "registered by another wallet" };
      if (e.args.version !== a.version || !sameHash(str(e.args.versionHash), a.versionHash)) return { ok: false, reason: "registered version differs from the approved one" };
      if (e.args.price !== approvedPriceUnits(a)) return { ok: false, reason: "registered price differs from the approved one" };
      if (big(e.args.royaltyBps) !== BigInt(a.royaltyBps)) return { ok: false, reason: "registered royalty differs from the approved one" };
      if (big(e.args.pricePerUse) !== (approvedPricePerUse(a) ?? 0n)) return { ok: false, reason: "registered pay-per-use price differs from the approved one" };
      if (a.metadataUri !== undefined && e.args.metadataUri !== a.metadataUri) return { ok: false, reason: "registered metadata URI differs from the approved one" };
      kinds.push("registered");
    } else if (e.name === "AgentVersionUpdated") {
      if (e.args.version !== a.version || !sameHash(str(e.args.versionHash), a.versionHash)) return { ok: false, reason: "the new version differs from the approved one" };
      kinds.push("version");
    } else if (e.name === "PricingUpdated") {
      if (e.args.price !== approvedPriceUnits(a)) return { ok: false, reason: "the new price differs from the approved one" };
      const ppu = approvedPricePerUse(a);
      if (ppu !== null && big(e.args.pricePerUse) !== ppu) return { ok: false, reason: "the new pay-per-use price differs from the approved one" };
      kinds.push("pricing");
    } else if (e.name === "RoyaltyBpsSet") {
      if (big(e.args.royaltyBps) !== BigInt(a.royaltyBps)) return { ok: false, reason: "the new royalty differs from the approved one" };
      kinds.push("pricing");
    } else if (e.name === "AgentMetadataUpdated") {
      if (a.metadataUri !== undefined && e.args.metadataUri !== a.metadataUri) return { ok: false, reason: "the new metadata URI differs from the approved one" };
    }
  }
  if (kinds.length === 0) return { ok: false, reason: "no publication event of this Solver in the transaction" };
  if (expected.kind && !kinds.includes(expected.kind)) return { ok: false, reason: `the transaction does not contain the ${expected.kind} step` };
  return { ok: true, kinds };
}
