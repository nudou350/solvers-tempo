import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { chainMatchesApproved, withApprovalFlag } from "../src/indexer/approved-version.js";
import { cursorKey, cursorMatches, decodeCursor, encodeCursor, nextRange, rewindBlock, REWIND_BLOCKS } from "../src/indexer/cursor.js";
import { autoReleaseAtOf, escrowStatusFromMilestones, mirroredMilestoneStatus, staleDisputeDue } from "../src/indexer/escrow-status.js";
import { describePauseFlags, GOVERNANCE_EVENTS, governanceAlertText, isFreshForAlert, ALERT_MAX_AGE_MS, roleName } from "../src/indexer/governance.js";
import { chainTxFor, impliedFeeBps } from "../src/indexer/kinds.js";
import { agentMirrorValues, type AgentChainState } from "../src/indexer/mirror.js";
import { compareEvents, groupByTx, sortEvents } from "../src/indexer/order.js";
import { backoffSecs, getLogsSplitting, IndexerRetryableError, isInfraError, isLogRangeError, MAX_ATTEMPTS } from "../src/indexer/retry-policy.js";
import { parseReindexArgs } from "../src/cli/reindex.js";

// Pure rules of the indexer: processing order, cursor/rewind decisions, escrow status derivation, chain_txs kinds,
// agent mirror values, governance alerts and the retry policy.

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("processing order", () => {
  it("sorts by (blockNumber, logIndex) and groups by transaction keeping that order", () => {
    const evs = [
      { blockNumber: 5n, logIndex: 3, transactionHash: "0xB", id: "b3" },
      { blockNumber: 4n, logIndex: 9, transactionHash: "0xA", id: "a9" },
      { blockNumber: 5n, logIndex: 1, transactionHash: "0xb", id: "b1" },
      { blockNumber: 4n, logIndex: 2, transactionHash: "0xA", id: "a2" },
      { blockNumber: 6n, logIndex: 0, transactionHash: "0xC", id: "c0" },
    ];
    const sorted = sortEvents(evs);
    assert.deepEqual(sorted.map((e) => e.id), ["a2", "a9", "b1", "b3", "c0"]);
    assert.ok(compareEvents(evs[1]!, evs[0]!) < 0, "an earlier block wins over a higher logIndex");
    const groups = groupByTx(sorted);
    assert.deepEqual(groups.map(([h, g]) => [h, g.map((e) => e.id)]), [
      ["0xa", ["a2", "a9"]],
      ["0xb", ["b1", "b3"]],
      ["0xc", ["c0"]],
    ]);
  });
});

describe("cursor", () => {
  const opts = { latest: 1_000n, confirmations: 1, batch: 100, startBlock: 500n };

  it("key per chain and a jsonb-safe encoding (block as a decimal string)", () => {
    assert.equal(cursorKey(42431), "indexer:evm:42431");
    const c = { block: 123n, blockHash: H(7).toUpperCase().replace("0X", "0x") as Hex };
    const enc = encodeCursor(c);
    assert.deepEqual(enc, { block: "123", blockHash: H(7) });
    assert.deepEqual(decodeCursor(JSON.parse(JSON.stringify(enc))), { block: 123n, blockHash: H(7) });
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor({ block: "x", blockHash: H(1) }), null);
    assert.equal(decodeCursor({ block: "1", blockHash: "0x12" }), null);
  });

  it("starts at the start block, scans at most `batch` blocks, stops at latest − confirmations", () => {
    assert.deepEqual(nextRange(null, opts), { from: 500n, to: 599n });
    assert.deepEqual(nextRange({ block: 950n, blockHash: H(1) }, opts), { from: 951n, to: 999n });
    assert.equal(nextRange({ block: 999n, blockHash: H(1) }, opts), null, "up to date");
    assert.deepEqual(nextRange({ block: 999n, blockHash: H(1) }, { ...opts, confirmations: 0 }), { from: 1000n, to: 1000n });
    // a cursor older than a moved start block resumes at the start block
    assert.deepEqual(nextRange({ block: 10n, blockHash: H(1) }, opts), { from: 500n, to: 599n });
    assert.equal(nextRange(null, { ...opts, latest: 0n }), null);
  });

  it("hash mismatch: rewinds 32 blocks, never before the start block", () => {
    assert.equal(REWIND_BLOCKS, 32n);
    assert.equal(cursorMatches({ block: 1n, blockHash: H(5) }, H(5).toUpperCase().replace("0X", "0x")), true);
    assert.equal(cursorMatches({ block: 1n, blockHash: H(5) }, H(6)), false);
    assert.equal(cursorMatches({ block: 1n, blockHash: H(5) }, null), false, "block gone (chain reset)");
    assert.equal(rewindBlock(900n, 500n), 868n);
    assert.equal(rewindBlock(532n, 500n), 500n);
    assert.equal(rewindBlock(531n, 500n), null, "before the start: rescan from the start");
  });
});

describe("escrow status derivation (SolversEscrow._statusOf)", () => {
  it("all refunded → refunded; all final → approved (Completed); any disputed → disputed; else active", () => {
    assert.equal(escrowStatusFromMilestones(["approved", "approved"]), "approved");
    assert.equal(escrowStatusFromMilestones(["refunded", "refunded"]), "refunded");
    assert.equal(escrowStatusFromMilestones(["approved", "refunded"]), "approved");
    assert.equal(escrowStatusFromMilestones(["approved", "disputed"]), "disputed");
    assert.equal(escrowStatusFromMilestones(["passed", "pending"]), "active");
    assert.equal(escrowStatusFromMilestones(["refunded", "pending"]), "active");
    assert.equal(escrowStatusFromMilestones([]), "active");
  });

  it("autoReleaseAt = latest passedAt + window among Passed milestones (0 when none)", () => {
    assert.equal(autoReleaseAtOf([{ status: "pending", passedAt: 0 }], 60), 0);
    assert.equal(
      autoReleaseAtOf(
        [
          { status: "passed", passedAt: 1_000n },
          { status: "approved", passedAt: 5_000 },
          { status: "passed", passedAt: 2_000 },
        ],
        60,
      ),
      2_060,
    );
  });

  it("the off-chain 'submitted' survives a chain 'pending', nothing else", () => {
    assert.equal(mirroredMilestoneStatus("pending", "submitted"), "submitted");
    assert.equal(mirroredMilestoneStatus("passed", "submitted"), "passed");
    assert.equal(mirroredMilestoneStatus("pending", "pending"), "pending");
    assert.equal(mirroredMilestoneStatus("disputed", undefined), "disputed");
  });

  it("staleDisputeDue: never passed, delivery deadline over and 7 days of dispute", () => {
    const day = 86400;
    const disputedAt = 1_000_000;
    const m = { disputedAt, passedAt: 0, deliveryDeadline: disputedAt - day };
    assert.equal(staleDisputeDue(m, disputedAt + 7 * day - 1), false);
    assert.equal(staleDisputeDue(m, disputedAt + 7 * day), true);
    assert.equal(staleDisputeDue({ ...m, disputedAt: 0n }, 9_999_999_999), false);
    assert.equal(staleDisputeDue({ ...m, passedAt: disputedAt - 100 }, disputedAt + 30 * day), false);
    const late = { ...m, deliveryDeadline: disputedAt + 10 * day };
    assert.equal(staleDisputeDue(late, disputedAt + 10 * day), false);
    assert.equal(staleDisputeDue(late, disputedAt + 10 * day + 1), true);
  });
});

describe("chain_txs kinds (amounts from event fields)", () => {
  const A = "0xAAaa000000000000000000000000000000000001";
  const B = "0xbbBB000000000000000000000000000000000002";
  const C = "0xCCcc000000000000000000000000000000000003";

  it("primary sales: purchase and credits carry gross, fee, creator share and the implied fee bps", () => {
    const p = chainTxFor({ eventName: "LicensePurchased", args: { buyer: A, price: 10_000_000n, fee: 1_000_000n, creatorAmount: 9_000_000n } }, { creator: C });
    assert.deepEqual(p, { kind: "purchase", wallet: A.toLowerCase(), amount: 10_000_000n, fee: 1_000_000n, creatorAmount: 9_000_000n, creatorWallet: C.toLowerCase(), feeBps: 1000 });
    const c = chainTxFor({ eventName: "CreditsBought", args: { buyer: A, total: 5_000_009n, fee: 500_000n, creatorAmount: 4_500_009n } }, { creator: C });
    assert.equal(c?.kind, "credits");
    assert.equal(c?.amount, 5_000_009n);
    assert.equal(c?.feeBps, 1000);
  });

  it("escrow deposit, release (fee frozen at creation) and refund (nothing to anyone but the buyer)", () => {
    const e = chainTxFor({ eventName: "EscrowCreated", args: { buyer: A, total: 7_000_000n, feeBps: 1000 } }, { creator: C });
    assert.deepEqual([e?.kind, e?.amount, e?.fee, e?.feeBps], ["escrow", 7_000_000n, null, 1000]);
    const r = chainTxFor({ eventName: "MilestonePaid", args: { creator: C, amount: 3_000_000n, fee: 300_000n } }, { escrow: { buyer: A, creator: C, feeBps: 1000 } });
    assert.deepEqual(r, { kind: "release", wallet: A.toLowerCase(), amount: 3_000_000n, fee: 300_000n, creatorAmount: 2_700_000n, creatorWallet: C.toLowerCase(), feeBps: 1000 });
    const f = chainTxFor({ eventName: "MilestoneRefunded", args: { buyer: A, amount: 4_000_000n } }, { escrow: { buyer: A, creator: C, feeBps: 1000 } });
    assert.deepEqual([f?.kind, f?.amount, f?.fee, f?.creatorAmount, f?.creatorWallet], ["refund", 4_000_000n, 0n, 0n, C.toLowerCase()]);
  });

  it("royalty: paid by `from`, platform share = fee, creator share", () => {
    const r = chainTxFor({ eventName: "RoyaltyPaid", args: { from: A, to: B, creator: C, creatorAmount: 500_000n, platformAmount: 500_000n } });
    assert.deepEqual(r, { kind: "royalty", wallet: A.toLowerCase(), amount: 1_000_000n, fee: 500_000n, creatorAmount: 500_000n, creatorWallet: C.toLowerCase(), feeBps: null });
  });

  it("slash, claim and stake (withdrawals are negative)", () => {
    assert.deepEqual(chainTxFor({ eventName: "SlashExecuted", args: { amount: 2n } }, { creator: C })?.kind, "slash");
    assert.equal(chainTxFor({ eventName: "SlashExecuted", args: { amount: 2n } }, { creator: C })?.wallet, C.toLowerCase());
    const cl = chainTxFor({ eventName: "PayoutClaimed", args: { to: B, amount: 9n } });
    assert.deepEqual([cl?.kind, cl?.wallet, cl?.amount], ["claim", B.toLowerCase(), 9n]);
    assert.equal(chainTxFor({ eventName: "StakeToppedUp", args: { creator: C, amount: 5n } })?.amount, 5n);
    assert.equal(chainTxFor({ eventName: "StakePulled", args: { creator: C, amount: 5n } })?.kind, "stake");
    assert.equal(chainTxFor({ eventName: "StakeWithdrawn", args: { creator: C, amount: 5n } })?.amount, -5n);
  });

  it("events that move no money produce no row", () => {
    for (const n of ["Transfer", "SaleAuthorized", "ReviewSubmitted", "PayoutDeferred", "MilestoneUpdated", "AgentRegistered"]) {
      assert.equal(chainTxFor({ eventName: n, args: {} }), null, n);
    }
  });

  it("impliedFeeBps rounds and ignores a zero gross", () => {
    assert.equal(impliedFeeBps(0n, 0n), null);
    assert.equal(impliedFeeBps(3n, 1n), 3333);
  });
});

describe("agent mirror values", () => {
  const state = (over: Partial<AgentChainState> = {}): AgentChainState => ({
    agentId: "c71ad0a50f750e75c71ad0a50f750e75",
    view: {
      creator: "0xcc",
      status: 1,
      royaltyBps: 500,
      totalSales: 3,
      maxSupply: 0,
      price: 10_000_000n,
      pricePerUse: 1_000_000n,
      disputesLost: 0,
      index: 4,
      stake: 0n,
      versionHash: H(0xabc).toUpperCase().replace("0X", "0x") as Hex,
      version: "1.0.0",
    },
    eval: { measured: false, scoreBps: 0, evalHash: H(0) },
    rating: { sum: 9n, count: 2 },
    verifiedUses: 7n,
    ...over,
  });

  it("maps status, cap (0 = unlimited), chain index and never contains platformStatus", () => {
    const v = agentMirrorValues(state());
    assert.equal(v.status, "active");
    assert.equal(v.maxLicenses, null);
    assert.equal(v.chainIndex, 4);
    assert.equal(v.totalSales, 3n);
    assert.equal(v.versionHash, H(0xabc).slice(2), "DB form: 64 hex without 0x");
    assert.ok(!("platformStatus" in v));
    assert.equal(agentMirrorValues(state({ view: { ...state().view, maxSupply: 50, status: 3 } })).maxLicenses, 50);
    assert.equal(agentMirrorValues(state({ view: { ...state().view, status: 3 } })).status, "retired");
  });

  it("D6: eval columns only when the current version is measured, with that version", () => {
    assert.ok(!("evalScoreBps" in agentMirrorValues(state())));
    const v = agentMirrorValues(state({ eval: { measured: true, scoreBps: 8800, evalHash: H(9) } }));
    assert.equal(v.evalScoreBps, 8800);
    assert.equal(v.evalVersionHash, H(0xabc).slice(2));
  });

  it("approved version check ignores hash case and the 0x prefix", () => {
    const approved = [{ version: "1.0.0", versionHash: H(0xabc).slice(2), priceUsdc: 10_000_000n }];
    assert.equal(chainMatchesApproved({ version: "1.0.0", versionHash: H(0xabc), price: 10_000_000n }, approved), true);
    const guarded = withApprovalFlag(agentMirrorValues(state({ view: { ...state().view, price: 1n } })), approved);
    assert.equal(guarded.syncFlag, "unapproved_chain_version");
    assert.ok(!("price" in guarded));
  });
});

describe("governance", () => {
  it("covers the D9 list and names roles and pause bits", () => {
    for (const n of ["PauseChanged", "ConfigUpdated", "SatellitesSet", "RoleGranted", "RoleRevoked", "DefaultAdminTransferScheduled", "DefaultAdminTransferCanceled"]) {
      assert.ok(GOVERNANCE_EVENTS.has(n), n);
    }
    assert.equal(roleName(`0x${"0".repeat(64)}`), "DEFAULT_ADMIN");
    assert.equal(roleName("0x4e9e3d4a0d2b7a8d5d0d1d8f4a2c3b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c"), "0x4e9e3d4a0d2b7a8d5d0d1d8f4a2c3b4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c");
    assert.equal(describePauseFlags(0), "none");
    assert.equal(describePauseFlags(5), "ENTRIES+TRANSFERS");
    const text = governanceAlertText({ name: "PauseChanged", contract: "registry", args: { by: "0xab", oldFlags: 0, newFlags: 3 }, txHash: "0x1", blockNumber: 1n });
    assert.match(text, /none -> ENTRIES\+PAYMENTS/);
    assert.match(governanceAlertText({ name: "Upgraded", contract: "license", args: { implementation: "0xim" }, txHash: "0x2", blockNumber: 1n }), /license upgraded to implementation 0xim/);
    // Parameterless events (rollbackDefaultAdminDelay) decode without args.
    const noArgs = { name: "DefaultAdminDelayChangeCanceled", contract: "registry", args: undefined as never, txHash: "0x3", blockNumber: 1n };
    assert.equal(governanceAlertText(noArgs), "Solvers governance (registry): DefaultAdminDelayChangeCanceled (tx 0x3)");
  });

  it("a backfill or reindex never replays old alerts to people", () => {
    const now = Date.UTC(2026, 9, 11, 12);
    assert.equal(isFreshForAlert(new Date(now - 60_000), now), true);
    assert.equal(isFreshForAlert(new Date(now - ALERT_MAX_AGE_MS - 1), now), false);
    assert.equal(isFreshForAlert(null, now), true, "unknown block time counts as recent");
  });
});

describe("retry policy", () => {
  it("exponential backoff from 30 s up to 6 h", () => {
    assert.equal(backoffSecs(1), 30);
    assert.equal(backoffSecs(2), 60);
    assert.equal(backoffSecs(3), 120);
    assert.equal(backoffSecs(99), 6 * 3600);
    assert.ok(MAX_ATTEMPTS >= 10);
  });

  it("infrastructure failures spend no attempts; transaction errors do", () => {
    assert.equal(isInfraError(new IndexerRetryableError("x")), true);
    assert.equal(isInfraError(new Error("fetch failed")), true);
    assert.equal(isInfraError(new Error("HTTP 429 Too Many Requests")), true);
    assert.equal(isInfraError(Object.assign(new Error("x"), { cause: new Error("ECONNRESET") })), true);
    // viem transport errors, by class name, also nested
    assert.equal(isInfraError(Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" })), true);
    assert.equal(isInfraError(Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("y"), { name: "TimeoutError" }) })), true);
    assert.equal(isInfraError(new Error("cannot read properties of undefined")), false);
    assert.equal(isInfraError(new Error('The contract function "getAgent" reverted.\nnetwork timeout in the request body')), false);
  });
});

describe("cli:reindex arguments", () => {
  it("parses --dead, --tx hashes and a block range", () => {
    const h = H(1);
    assert.deepEqual(parseReindexArgs(["--dead"]), { dead: true, txs: [], fromBlock: null, toBlock: null });
    assert.deepEqual(parseReindexArgs(["--tx", h, H(2).toUpperCase().replace("0X", "0x"), "--dead"]), { dead: true, txs: [h, H(2)], fromBlock: null, toBlock: null });
    assert.deepEqual(parseReindexArgs(["--from-block", "100", "--to-block", "250"]), { dead: false, txs: [], fromBlock: 100n, toBlock: 250n });
    assert.throws(() => parseReindexArgs(["--tx"]), /at least one/);
    assert.throws(() => parseReindexArgs(["--tx", "0x12"]), /not a transaction hash/);
    assert.throws(() => parseReindexArgs(["--from-block", "-3"]), /block number/);
  });
});

describe("getLogs range limits", () => {
  it("recognises range / result-limit refusals, not other errors", () => {
    assert.ok(isLogRangeError(new Error("query returned more than 10000 results")));
    assert.ok(isLogRangeError(new Error("block range is too large")));
    assert.ok(isLogRangeError({ name: "RpcRequestError", message: "x", cause: { name: "LimitExceededRpcError", message: "limit" } }));
    assert.ok(isLogRangeError(new Error("eth_getLogs is limited to a 100000 block range; max range exceeded")));
    assert.ok(!isLogRangeError(new Error("fetch failed")));
    assert.ok(!isLogRangeError(new Error("execution reverted")));
  });

  it("halves a refused range until each part fits, keeping block order, instead of failing the same range forever", async () => {
    const calls: [bigint, bigint][] = [];
    const fetch = async (from: bigint, to: bigint) => {
      calls.push([from, to]);
      if (to - from + 1n > 25n) throw new Error("query returned more than 10000 results");
      const out: bigint[] = [];
      for (let b = from; b <= to; b++) out.push(b);
      return out;
    };
    const logs = await getLogsSplitting(fetch, 0n, 99n);
    assert.equal(logs.length, 100);
    assert.deepEqual(logs, [...logs].sort((a, b) => (a < b ? -1 : 1)));
    assert.deepEqual(calls[0], [0n, 99n]);
    assert.ok(calls.every(([f, t]) => t >= f));
  });

  it("other errors and a single block that is still too large are thrown", async () => {
    await assert.rejects(getLogsSplitting(async () => Promise.reject(new Error("fetch failed")), 0n, 10n), /fetch failed/);
    await assert.rejects(getLogsSplitting(async () => Promise.reject(new Error("response size exceeded")), 5n, 5n), /response size/);
  });
});
