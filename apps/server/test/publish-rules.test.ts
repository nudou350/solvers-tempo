import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SYNC_OK, SYNC_UNAPPROVED, chainMatchesApproved, syncFlagFor, withApprovalFlag, type ApprovedVersion, type ChainVersion } from "../src/indexer/approved-version.js";
import { CREATOR_SIGNING_STEPS, agentIdToBytes32 } from "@solvers/shared";
import { isAdminIn, parseAdminWallets } from "../src/publish/admin-rules.js";
import {
  checkCreatorTx,
  fromChainHash,
  isPublicationTouch,
  maxSupplyOf,
  nextPublicationStep,
  pricePerUseFor,
  parseApproved,
  registrationFor,
  royaltyProblem,
  statusAfterChain,
  stepMismatch,
  toChainHash,
  type ApprovedRecord,
  type ChainAgentState,
  type RegistryEvent,
} from "../src/publish/approval-rules.js";
import { CliUsageError, parseApproveArgs, parseSuspendArgs } from "../src/publish/cli-args.js";

// Pure rules of the on-chain publication (PACKAGE_SPEC.md 15): approved version vs chain, next step, submission state,
// confirmation by tx hash and the CLI arguments. No env, database or network.

const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const H3 = "c3".repeat(32);
const CREATOR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const AGENT = "0123456789abcdef0123456789abcdef";
const approvedRows: ApprovedVersion[] = [
  { version: "1.0.0", versionHash: H1, priceUsdc: 10_000_000n },
  { version: "1.1.0", versionHash: H2, priceUsdc: 12_000_000n },
];
const onchain = (over: Partial<ChainVersion> = {}): ChainVersion => ({ version: "1.1.0", versionHash: H2, price: 12_000_000n, ...over });

describe("chain vs approved version (indexer rule, PACKAGE_SPEC.md 15.4)", () => {
  it("version, hash and price matching an approved one: ok (case and 0x prefix ignored)", () => {
    assert.equal(syncFlagFor(onchain(), approvedRows), SYNC_OK);
    assert.equal(chainMatchesApproved(onchain({ versionHash: `0x${H2.toUpperCase()}` }), approvedRows), true);
  });
  it("reverting to an approved version is fine; a new hash or price diverges", () => {
    assert.equal(syncFlagFor(onchain({ version: "1.0.0", versionHash: H1, price: 10_000_000n }), approvedRows), SYNC_OK);
    assert.equal(syncFlagFor(onchain({ versionHash: H3 }), approvedRows), SYNC_UNAPPROVED);
    assert.equal(syncFlagFor(onchain({ price: 1_000_000n }), approvedRows), SYNC_UNAPPROVED);
    assert.equal(syncFlagFor(onchain({ version: "1.0.0", versionHash: H2 }), approvedRows), SYNC_UNAPPROVED);
    assert.equal(syncFlagFor(onchain(), []), SYNC_UNAPPROVED);
  });
  it("withApprovalFlag removes version, hash and price when diverging", () => {
    const base = { version: "1.1.0", versionHash: H2, price: 12_000_000n, status: "active" };
    assert.deepEqual(withApprovalFlag(base, approvedRows), { ...base, syncFlag: SYNC_OK });
    const diverged = withApprovalFlag({ ...base, versionHash: H3 }, approvedRows);
    assert.equal(diverged.syncFlag, SYNC_UNAPPROVED);
    assert.equal("versionHash" in diverged, false);
    assert.equal((diverged as unknown as { status: string }).status, "active");
  });
});

const approved = (over: Partial<ApprovedRecord> = {}): ApprovedRecord => ({ versionHash: H2, priceUsdc: "12000000", royaltyBps: 500, name: "My Solver", version: "1.1.0", ...over });
const state = (over: Partial<Extract<ChainAgentState, { exists: true }>> = {}): ChainAgentState => ({
  exists: true,
  creator: CREATOR,
  version: "1.1.0",
  versionHash: H2,
  price: 12_000_000n,
  status: "active",
  ...over,
});

describe("nextPublicationStep: what is missing, read from the chain", () => {
  it("no agent: the creator registers", () => {
    assert.equal(nextPublicationStep(approved(), { exists: false }), "register-agent");
  });
  it("new Solver registered (Pending): waiting for the admin; Active: ready", () => {
    assert.equal(nextPublicationStep(approved(), state({ status: "pending" })), "await-admin-approval");
    assert.equal(nextPublicationStep(approved(), state({ status: "active" })), "ready");
  });
  it("update: a different version/hash asks for update-version; then a different price asks for update-pricing", () => {
    assert.equal(nextPublicationStep(approved(), state({ version: "1.0.0", versionHash: H1 })), "update-version");
    assert.equal(nextPublicationStep(approved(), state({ versionHash: H1 })), "update-version");
    assert.equal(nextPublicationStep(approved(), state({ price: 10_000_000n })), "update-pricing");
    assert.equal(nextPublicationStep(approved(), state({ versionHash: `0x${H2}` })), "ready", "0x-prefixed chain hash compares equal");
  });
  it("suspended or retired: blocked", () => {
    assert.equal(nextPublicationStep(approved(), state({ status: "suspended" })), "blocked");
    assert.equal(nextPublicationStep(approved(), state({ status: "retired" })), "blocked");
  });
  it("an agent of ANOTHER creator blocks the caller; addresses compare case-insensitively", () => {
    assert.equal(nextPublicationStep(approved(), state({ creator: OTHER }), CREATOR), "blocked");
    assert.equal(nextPublicationStep(approved(), state(), CREATOR.toUpperCase().replace("0X", "0x")), "ready");
  });
  it("creator steps and a wrong requested step", () => {
    assert.deepEqual([...CREATOR_SIGNING_STEPS].sort(), ["register-agent", "update-pricing", "update-version"]);
    assert.equal(stepMismatch("update-version", "update-version"), null);
    assert.equal(stepMismatch("register-agent", "update-version"), "update-version");
  });
});

describe("statusAfterChain: the submission never goes back", () => {
  it("ready finalizes; waiting for the admin advances; otherwise it stays", () => {
    assert.equal(statusAfterChain("awaiting_creator_signature", "ready"), "finalize");
    assert.equal(statusAfterChain("awaiting_onchain_approval", "ready"), "finalize");
    assert.equal(statusAfterChain("awaiting_creator_signature", "await-admin-approval"), "awaiting_onchain_approval");
    assert.equal(statusAfterChain("awaiting_onchain_approval", "register-agent"), "awaiting_onchain_approval");
    assert.equal(statusAfterChain("published", "ready"), "published");
    assert.equal(statusAfterChain("pending_review", "ready"), "pending_review");
  });
});

describe("parseApproved: the approved record is trusted only with the right shape", () => {
  it("accepts the approval record and refuses malformed ones", () => {
    assert.deepEqual(parseApproved(approved()), approved());
    assert.equal(parseApproved(null), null);
    assert.equal(parseApproved({ ...approved(), versionHash: "abc" }), null);
    assert.equal(parseApproved({ ...approved(), versionHash: `0x${H1}` }), null);
    assert.equal(parseApproved({ ...approved(), priceUsdc: "12.5" }), null);
    assert.equal(parseApproved({ ...approved(), royaltyBps: 10_001 }), null);
    assert.equal(parseApproved({ ...approved(), name: "" }), null);
  });
});

describe("registration batch inputs (D1, D15)", () => {
  it("hash conversions and the AgentRegistration come only from the approved record", () => {
    assert.equal(toChainHash(H1), `0x${H1}`);
    assert.equal(toChainHash(`0x${H1.toUpperCase()}`), `0x${H1}`);
    assert.throws(() => toChainHash("abc"));
    assert.equal(fromChainHash(`0x${H1.toUpperCase()}`), H1);
    assert.deepEqual(registrationFor(AGENT, approved(), "https://x/m.json"), {
      agentId: agentIdToBytes32(AGENT),
      metadataUri: "https://x/m.json",
      version: "1.1.0",
      versionHash: `0x${H2}`,
      price: 12_000_000n,
      pricePerUse: 0n,
      royaltyBps: 500,
    });
  });
  it("royalty: creator share + platform share <= 2500 bps", () => {
    assert.equal(royaltyProblem(500, 500), null);
    assert.equal(royaltyProblem(2000, 500), null);
    assert.match(royaltyProblem(2001, 500) ?? "", /2500/);
    assert.ok(royaltyProblem(-1, 0));
  });
  it("license cap from the validated manifest", () => {
    assert.equal(maxSupplyOf({ supply: { maxLicenses: 10 } }), 10);
    assert.equal(maxSupplyOf({}), undefined);
    assert.equal(maxSupplyOf(null), undefined);
    assert.equal(maxSupplyOf({ supply: { maxLicenses: 0 } }), undefined);
    assert.equal(maxSupplyOf({ supply: { maxLicenses: 2.5 } }), undefined);
  });
});

describe("checkCreatorTx: confirmation by tx hash", () => {
  const id = agentIdToBytes32(AGENT);
  const registered = (over: Record<string, unknown> = {}): RegistryEvent => ({
    name: "AgentRegistered",
    args: { agentId: id, creator: CREATOR, metadataUri: "https://x/m.json", version: "1.1.0", versionHash: `0x${H2}`, price: 12_000_000n, pricePerUse: 0n, royaltyBps: 500, ...over },
  });
  const expected = { agentId: AGENT, creatorWallet: CREATOR, approved: approved() };
  const ok = (events: RegistryEvent[], from = CREATOR, success = true) => checkCreatorTx({ events, from, success }, expected);

  it("a registration matching the approved record passes", () => {
    assert.deepEqual(ok([registered()]), { ok: true, kinds: ["registered"] });
    assert.deepEqual(checkCreatorTx({ events: [registered()], from: CREATOR, success: true }, { ...expected, kind: "registered" }), { ok: true, kinds: ["registered"] });
  });
  it("reverted, another sender, another agent, other values: refused", () => {
    assert.equal(ok([registered()], CREATOR, false).ok, false);
    assert.equal(ok([registered()], OTHER).ok, false);
    assert.equal(ok([registered({ agentId: agentIdToBytes32("f".repeat(32)) })]).ok, false);
    assert.equal(ok([registered({ creator: OTHER })]).ok, false);
    assert.equal(ok([registered({ versionHash: `0x${H3}` })]).ok, false);
    assert.equal(ok([registered({ price: 1n })]).ok, false);
    assert.equal(ok([]).ok, false);
  });
  it("an update batch (version + price) yields both kinds; a requested kind must be present", () => {
    const events: RegistryEvent[] = [
      { name: "AgentVersionUpdated", args: { agentId: id, version: "1.1.0", versionHash: `0x${H2}` } },
      { name: "PricingUpdated", args: { agentId: id, price: 12_000_000n, pricePerUse: 0n } },
    ];
    assert.deepEqual(ok(events), { ok: true, kinds: ["version", "pricing"] });
    assert.equal(checkCreatorTx({ events: [events[1]!], from: CREATOR, success: true }, { ...expected, kind: "version" }).ok, false);
    assert.equal(ok([{ name: "PricingUpdated", args: { agentId: id, price: 5n } }]).ok, false);
  });
  it("royalty, pay-per-use and metadata URI: compared with the approved record", () => {
    assert.equal(ok([registered({ royaltyBps: 300 })]).ok, false, "registered royalty differs");
    assert.equal(ok([registered({ pricePerUse: 1_000_000n })]).ok, false, "registration pay-per-use must be 0 without an approved one");
    assert.equal(ok([registered({ royaltyBps: undefined })]).ok, false, "an event without the royalty never passes");
    // The record fixes pay-per-use and the URI: registration and pricing must carry them.
    const fixed = { ...expected, approved: approved({ pricePerUse: "1000000", metadataUri: "https://x/m.json" }) };
    const chk = (events: RegistryEvent[]) => checkCreatorTx({ events, from: CREATOR, success: true }, fixed);
    assert.equal(chk([registered({ pricePerUse: 1_000_000n })]).ok, true);
    assert.equal(chk([registered({ pricePerUse: 1_000_000n, metadataUri: "https://evil/m.json" })]).ok, false);
    assert.equal(chk([{ name: "PricingUpdated", args: { agentId: id, price: 12_000_000n, pricePerUse: 0n } }]).ok, false);
    assert.equal(chk([{ name: "PricingUpdated", args: { agentId: id, price: 12_000_000n, pricePerUse: 1_000_000n } }]).ok, true);
    assert.equal(chk([{ name: "AgentMetadataUpdated", args: { agentId: id, metadataUri: "https://evil/m.json" } }, { name: "PricingUpdated", args: { agentId: id, price: 12_000_000n, pricePerUse: 1_000_000n } }]).ok, false);
    // Without a fixed pay-per-use, a reviewed price change may carry the creator's own value.
    assert.equal(ok([{ name: "PricingUpdated", args: { agentId: id, price: 12_000_000n, pricePerUse: 2_000_000n } }]).ok, true);
    // RoyaltyBpsSet is a "pricing" (terms) step and must carry the approved royalty.
    assert.deepEqual(ok([{ name: "RoyaltyBpsSet", args: { agentId: id, royaltyBps: 500 } }]), { ok: true, kinds: ["pricing"] });
    assert.equal(ok([{ name: "RoyaltyBpsSet", args: { agentId: id, royaltyBps: 900 } }]).ok, false);
  });
});

describe("isPublicationTouch: which hash becomes register_tx", () => {
  const tx = `0x${"9".repeat(64)}`;
  it("only a registration/version update matching the approved record (or verified by the confirm route)", () => {
    const a = approved();
    assert.equal(isPublicationTouch({ txHash: tx, kind: "version", version: "1.1.0", versionHash: `0x${H2}` }, a), true);
    assert.equal(isPublicationTouch({ txHash: tx, kind: "registered", verified: true }, a), true);
    assert.equal(isPublicationTouch({ txHash: tx, kind: "version", version: "1.1.0", versionHash: `0x${H1}` }, a), false, "another hash");
    assert.equal(isPublicationTouch({ txHash: tx, kind: "version", version: "9.9.9", versionHash: `0x${H2}` }, a), false, "another version");
    assert.equal(isPublicationTouch({ txHash: tx, kind: "pricing", verified: true }, a), false, "a price change never is");
    assert.equal(isPublicationTouch({ txHash: tx, kind: "registered" }, a), false, "an event without version data is not trusted");
    assert.equal(isPublicationTouch({ kind: "registered", verified: true }, a), false);
    assert.equal(isPublicationTouch({ txHash: tx, kind: "registered", verified: true }, null), false);
  });
});

describe("terms besides version and price (royalty, pay-per-use, metadata URI)", () => {
  it("royalty differs: update-pricing while nothing was sold, ignored after the first sale", () => {
    assert.equal(nextPublicationStep(approved(), state({ royaltyBps: 300, totalSales: 0 })), "update-pricing");
    assert.equal(nextPublicationStep(approved(), state({ royaltyBps: 300, totalSales: 2 })), "ready");
    assert.equal(nextPublicationStep(approved(), state({ royaltyBps: 500, totalSales: 0 })), "ready");
  });
  it("pay-per-use and metadata URI only count when the record fixes them", () => {
    assert.equal(nextPublicationStep(approved(), state({ pricePerUse: 3n, metadataUri: "x" })), "ready");
    assert.equal(nextPublicationStep(approved({ pricePerUse: "3" }), state({ pricePerUse: 0n })), "update-pricing");
    assert.equal(nextPublicationStep(approved({ metadataUri: "https://a" }), state({ metadataUri: "https://b" })), "update-pricing");
    assert.equal(nextPublicationStep(approved({ metadataUri: "https://a" }), state({ metadataUri: "https://a" })), "ready");
  });
  it("pricePerUseFor: the approved one, else the creator's on-chain value capped at the new price (never a silent 0)", () => {
    assert.equal(pricePerUseFor(approved(), state({ pricePerUse: 2_000_000n })), 2_000_000n);
    assert.equal(pricePerUseFor(approved({ priceUsdc: "1000000" }), state({ pricePerUse: 2_000_000n })), 1_000_000n);
    assert.equal(pricePerUseFor(approved({ pricePerUse: "7" }), state({ pricePerUse: 2_000_000n })), 7n);
    assert.equal(pricePerUseFor(approved(), { exists: false }), 0n);
  });
  it("parseApproved keeps the optional fields and refuses malformed ones; registration uses them", () => {
    const a = approved({ pricePerUse: "5", metadataUri: "https://a/m.json" });
    assert.deepEqual(parseApproved(a), a);
    assert.equal(parseApproved({ ...approved(), pricePerUse: "1.5" }), null);
    assert.equal(parseApproved({ ...approved(), metadataUri: "" }), null);
    const r = registrationFor(AGENT, a, "https://default/m.json");
    assert.equal(r.pricePerUse, 5n);
    assert.equal(r.metadataUri, "https://a/m.json");
  });
});

describe("site admins (ADMIN_WALLETS)", () => {
  it("comma list, spaces and empty entries; compared lowercase", () => {
    assert.deepEqual([...parseAdminWallets(" 0xAa , 0xbb,, 0xCC ,")], ["0xaa", "0xbb", "0xcc"]);
    assert.equal(isAdminIn("0xBB", "0xaa,0xbb"), true);
    assert.equal(isAdminIn("0xdd", "0xaa,0xbb"), false);
    assert.equal(isAdminIn("0xaa", ""), false);
  });
});

describe("cli:approve and cli:suspend arguments", () => {
  it("approve: slug or id, --dry-run, --key-file, --allow-network", () => {
    assert.deepEqual(parseApproveArgs(["my-solver"]), { ref: "my-solver", dryRun: false, keyFile: null, allowNetwork: null });
    assert.deepEqual(parseApproveArgs(["--dry-run", "sub123", "--allow-network", "mainnet", "--key-file", "admin.key"]), {
      ref: "sub123",
      dryRun: true,
      keyFile: "admin.key",
      allowNetwork: "mainnet",
    });
    assert.throws(() => parseApproveArgs([]), CliUsageError);
    assert.throws(() => parseApproveArgs(["a", "b"]), CliUsageError);
    assert.throws(() => parseApproveArgs(["a", "--yes"]), CliUsageError);
    assert.throws(() => parseApproveArgs(["a", "--allow-network"]), CliUsageError);
    assert.throws(() => parseApproveArgs(["a", "--key-file", "--dry-run"]), CliUsageError);
  });
  it("suspend: slug, --resume, --reason", () => {
    assert.deepEqual(parseSuspendArgs(["my-solver"]), { ref: "my-solver", resume: false, reason: null, keyFile: null, allowNetwork: null });
    assert.deepEqual(parseSuspendArgs(["my-solver", "--resume"]).resume, true);
    assert.equal(parseSuspendArgs(["x", "--reason", "copied content"]).reason, "copied content");
    assert.throws(() => parseSuspendArgs([]), CliUsageError);
    assert.throws(() => parseSuspendArgs(["x", "--reason"]), CliUsageError);
  });
});
