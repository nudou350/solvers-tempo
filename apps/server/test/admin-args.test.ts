import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { parseAdminArgs, parseCallData, parseConfigChange, parsePauseFlags, parseTokenAmount, reasonHashOf, UsageError } from "../src/cli/admin-args.js";

// `cli:admin` argument parsing: pure, no network or keys.

/** EIP-55 checksummed (mixed case must be a valid checksum). */
const ADDR = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const LOWER = ADDR.toLowerCase();

describe("cli:admin: arguments", () => {
  it("dry-run is the default; --yes and --key-file are read in any position; addresses are lowercased", () => {
    assert.deepEqual(parseAdminArgs(["propose", ADDR]), { command: { cmd: "propose", newAdmin: LOWER }, yes: false, keyFile: null, allowNetwork: null });
    assert.deepEqual(parseAdminArgs(["--yes", "accept", "--key-file", "new-admin.key"]), { command: { cmd: "accept" }, yes: true, keyFile: "new-admin.key", allowNetwork: null });
    assert.deepEqual(parseAdminArgs(["cancel", "--allow-network", "mainnet"]).allowNetwork, "mainnet");
  });

  it("refuses unknown commands, bad addresses, extra arguments and unknown options", () => {
    for (const argv of [[], ["destroy"], ["propose"], ["propose", "0x123"], ["propose", "0x1234567890abcdef1234567890ABCDEF12345678"], ["propose", ADDR, ADDR], ["accept", ADDR], ["cancel", "--force"], ["accept", "--key-file"], ["cancel", "--allow-network"]]) {
      assert.throws(() => parseAdminArgs(argv), UsageError, JSON.stringify(argv));
    }
  });

  it("token amounts: exact decimals, > 0, no floats", () => {
    assert.equal(parseTokenAmount("5"), 5_000_000n);
    assert.equal(parseTokenAmount("12.5"), 12_500_000n);
    assert.equal(parseTokenAmount("0,000001"), 1n);
    assert.equal(parseTokenAmount("0", 6, { allowZero: true }), 0n);
    for (const v of ["0", "0.0", "-1", "1.1234567", "abc", "", "1e6", "1."]) assert.throws(() => parseTokenAmount(v), UsageError, v);
  });

  it("set-config: any subset of keys; validated ranges; at least one key", () => {
    assert.deepEqual(parseAdminArgs(["set-config", "fee-bps=1000", "min-price=5", `treasury=${ADDR}`]).command, {
      cmd: "set-config",
      change: { feeBps: 1000, minPrice: 5_000_000n, treasury: LOWER },
    });
    assert.deepEqual(parseConfigChange(["min-stake=0", "platform-royalty-bps=500"]), { minStake: 0n, platformRoyaltyBps: 500 });
    for (const bad of [[], ["fee-bps=2001"], ["platform-royalty-bps=2501"], ["min-price=0"], ["nope=1"], ["fee-bps"], ["treasury=0x1"], ["fee-bps=1", "fee-bps=2"]]) {
      assert.throws(() => parseConfigChange(bad), UsageError, JSON.stringify(bad));
    }
  });

  it("set-pause: names, comma lists or 0..7; nothing outside the mask", () => {
    assert.equal(parsePauseFlags("none"), 0);
    assert.equal(parsePauseFlags("entries"), 1);
    assert.equal(parsePauseFlags("PAYMENTS"), 2);
    assert.equal(parsePauseFlags("transfers"), 4);
    assert.equal(parsePauseFlags("all"), 7);
    assert.equal(parsePauseFlags("entries,payments"), 3);
    assert.equal(parsePauseFlags("5"), 5);
    for (const v of ["8", "255", "-1", "1.5", "pause", "", "0x1", "entries,nope"]) assert.throws(() => parsePauseFlags(v), UsageError, v);
    assert.throws(() => parsePauseFlags(undefined), UsageError);
    assert.deepEqual(parseAdminArgs(["set-pause", "all", "--key-file", "guardian.key"]).command, { cmd: "set-pause", flags: 7 });
  });

  it("grant-role / revoke-role", () => {
    assert.deepEqual(parseAdminArgs(["grant-role", "guardian", ADDR]).command, { cmd: "grant-role", role: "guardian", account: LOWER });
    assert.deepEqual(parseAdminArgs(["revoke-role", "VERIFIER", ADDR]).command, { cmd: "revoke-role", role: "verifier", account: LOWER });
    assert.throws(() => parseAdminArgs(["grant-role", "admin", ADDR]), UsageError);
    assert.throws(() => parseAdminArgs(["grant-role", "guardian"]), UsageError);
  });

  it("slash commands: the reason hash is sha256 of the trimmed reason", () => {
    const a = parseAdminArgs(["propose-slash", "frontend-react", "2.5", "  Fake delivery in case 123  ", "--yes"]);
    assert.deepEqual(a.command, { cmd: "propose-slash", slug: "frontend-react", amount: 2_500_000n, reason: "Fake delivery in case 123" });
    assert.equal(reasonHashOf("Fake delivery in case 123"), `0x${createHash("sha256").update("Fake delivery in case 123").digest("hex")}`);
    assert.equal(reasonHashOf(" x "), reasonHashOf("x"));
    assert.throws(() => reasonHashOf("   "), UsageError);
    assert.throws(() => parseAdminArgs(["propose-slash", "x", "1"]), UsageError);
    assert.throws(() => parseAdminArgs(["propose-slash", "x", "0", "reason"]), UsageError);
    assert.deepEqual(parseAdminArgs(["execute-slash", "a"]).command, { cmd: "execute-slash", slug: "a" });
    assert.deepEqual(parseAdminArgs(["cancel-slash", "a"]).command, { cmd: "cancel-slash", slug: "a" });
    assert.deepEqual(parseAdminArgs(["extend-stake-exit", "a", "open dispute"]).command, { cmd: "extend-stake-exit", slug: "a", reason: "open dispute" });
    assert.throws(() => parseAdminArgs(["extend-stake-exit", "a"]), UsageError);
  });

  it("resolve-dispute, set-base-uri, sweep-stray", () => {
    assert.deepEqual(parseAdminArgs(["resolve-dispute", "12", "0", "refund"]).command, { cmd: "resolve-dispute", escrowId: 12n, index: 0, refund: true });
    assert.equal((parseAdminArgs(["resolve-dispute", "12", "4", "RELEASE"]).command as { refund: boolean }).refund, false);
    for (const bad of [["resolve-dispute", "0", "0", "refund"], ["resolve-dispute", "x", "0", "refund"], ["resolve-dispute", "1", "5", "refund"], ["resolve-dispute", "1", "0", "maybe"]]) {
      assert.throws(() => parseAdminArgs(bad), UsageError, JSON.stringify(bad));
    }
    assert.deepEqual(parseAdminArgs(["set-base-uri", "https://x.test/api/license/"]).command, { cmd: "set-base-uri", uri: "https://x.test/api/license/" });
    assert.throws(() => parseAdminArgs(["set-base-uri", "ftp://x"]), UsageError);
    assert.deepEqual(parseAdminArgs(["sweep-stray", "escrow", ADDR]).command, { cmd: "sweep-stray", contract: "escrow", to: LOWER });
    assert.throws(() => parseAdminArgs(["sweep-stray", "registry", ADDR]), UsageError);
  });

  it("admin-delay / admin-delay-rollback", () => {
    assert.deepEqual(parseAdminArgs(["admin-delay", "172800", "--yes"]), { command: { cmd: "admin-delay", seconds: 172_800 }, yes: true, keyFile: null, allowNetwork: null });
    assert.deepEqual(parseAdminArgs(["admin-delay", "0"]).command, { cmd: "admin-delay", seconds: 0 });
    assert.deepEqual(parseAdminArgs(["admin-delay", String(2 ** 48 - 1)]).command, { cmd: "admin-delay", seconds: 2 ** 48 - 1 });
    assert.deepEqual(parseAdminArgs(["admin-delay-rollback", "--key-file", "admin.key"]).command, { cmd: "admin-delay-rollback" });
    for (const bad of [["admin-delay"], ["admin-delay", "-1"], ["admin-delay", "1.5"], ["admin-delay", "48h"], ["admin-delay", String(2 ** 48)], ["admin-delay", "1", "2"], ["admin-delay-rollback", "1"]]) {
      assert.throws(() => parseAdminArgs(bad), UsageError, JSON.stringify(bad));
    }
  });

  it("upgrade <contract> <impl> [--call <hex>]: any of the six proxies; --call only with upgrade", () => {
    assert.deepEqual(parseAdminArgs(["upgrade", "LICENSE", ADDR]).command, { cmd: "upgrade", contract: "license", implementation: LOWER, data: "0x" });
    for (const c of ["registry", "license", "credits", "reviews", "escrow", "staking"]) {
      assert.equal((parseAdminArgs(["upgrade", c, ADDR]).command as { contract: string }).contract, c);
    }
    const a = parseAdminArgs(["--call", "0x8129FC1C", "upgrade", "registry", ADDR, "--yes", "--allow-network", "mainnet", "--key-file", "cold.key"]);
    assert.deepEqual(a, { command: { cmd: "upgrade", contract: "registry", implementation: LOWER, data: "0x8129fc1c" }, yes: true, keyFile: "cold.key", allowNetwork: "mainnet" });
    assert.equal(parseCallData("0x"), "0x");
    for (const bad of [
      ["upgrade", "token", ADDR],
      ["upgrade", "license"],
      ["upgrade", "license", "0x1234"],
      ["upgrade", "license", ADDR, ADDR],
      ["upgrade", "license", ADDR, "--call"],
      ["upgrade", "license", ADDR, "--call", "0x123"],
      ["upgrade", "license", ADDR, "--call", "abcd"],
      ["upgrade", "license", ADDR, "--call", "0x12", "--call", "0x34"],
      ["admin-delay", "1", "--call", "0x12"],
      ["accept", "--call", "0x"],
    ]) {
      assert.throws(() => parseAdminArgs(bad), UsageError, JSON.stringify(bad));
    }
  });
});
