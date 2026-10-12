import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAccount } from "@solvers/chain";
import {
  CHAIN_IDS,
  KeySourceError,
  NetworkError,
  PauseRuleError,
  adminDelayChangeAt,
  adminKeySource,
  assertNetwork,
  decidePauseSigner,
  networkName,
  slashWait,
} from "../src/cli/admin-guard.js";

// Guards of the admin CLIs: network (chain id), key source (mainnet: --key-file only) and pause rules. Pure, no network.

describe("admin CLIs: network", () => {
  it("local and Moderato pass without a warning", () => {
    assert.deepEqual(assertNetwork(CHAIN_IDS.local, CHAIN_IDS.local, null), { network: "local", warning: null });
    assert.deepEqual(assertNetwork(CHAIN_IDS.moderato, CHAIN_IDS.moderato, null), { network: "moderato", warning: null });
  });
  it("the RPC must be on CHAIN_ID", () => {
    assert.throws(() => assertNetwork(CHAIN_IDS.mainnet, CHAIN_IDS.moderato, null), (e) => e instanceof NetworkError && /CHAIN_ID/.test(e.message));
  });
  it("mainnet and unknown chains abort by default and say how to allow them", () => {
    assert.equal(networkName(CHAIN_IDS.mainnet), "mainnet");
    assert.throws(() => assertNetwork(CHAIN_IDS.mainnet, CHAIN_IDS.mainnet, null), (e) => e instanceof NetworkError && /--allow-network mainnet/.test(e.message));
    assert.throws(() => assertNetwork(1, 1, null), NetworkError);
  });
  it("the override only works with the detected network's name", () => {
    const r = assertNetwork(CHAIN_IDS.mainnet, CHAIN_IDS.mainnet, "mainnet");
    assert.equal(r.network, "mainnet");
    assert.match(r.warning ?? "", /WARNING/);
    assert.throws(() => assertNetwork(CHAIN_IDS.mainnet, CHAIN_IDS.mainnet, "moderato"), NetworkError);
    assert.equal(assertNetwork(1, 1, "unknown").network, "unknown");
  });
});

describe("admin CLIs: key source (mainnet refusal)", () => {
  it("mainnet refuses any key from the environment, even with --key-file", () => {
    assert.throws(() => adminKeySource({ network: "mainnet", keyFile: null, envKeySet: true }), KeySourceError);
    assert.throws(() => adminKeySource({ network: "mainnet", keyFile: "admin.key", envKeySet: true }), KeySourceError);
  });
  it("mainnet only signs with an explicit --key-file; without it only a dry-run can proceed", () => {
    assert.deepEqual(adminKeySource({ network: "mainnet", keyFile: "admin.key", envKeySet: false }), { source: "key-file", path: "admin.key" });
    assert.deepEqual(adminKeySource({ network: "mainnet", keyFile: null, envKeySet: false }), { source: "none" });
  });
  it("off mainnet: --key-file wins, ADMIN_PRIVATE_KEY is the default", () => {
    assert.deepEqual(adminKeySource({ network: "moderato", keyFile: "k", envKeySet: true }), { source: "key-file", path: "k" });
    assert.deepEqual(adminKeySource({ network: "local", keyFile: null, envKeySet: true }), { source: "env" });
    assert.deepEqual(adminKeySource({ network: "local", keyFile: null, envKeySet: false }), { source: "none" });
  });
  it("a malformed key file never leaks its content", () => {
    const f = join(mkdtempSync(join(tmpdir(), "key-")), "admin.key");
    writeFileSync(f, "SECRET-private-key-1234 garbage");
    assert.throws(() => loadAccount(f, "--key-file"), (e) => e instanceof Error && !/SECRET|1234|garbage/.test(e.message));
  });
});

describe("decidePauseSigner (mirrors SolversRegistry.setPause)", () => {
  const admin = "0x00000000000000000000000000000000000000aa";
  const guardian = "0x00000000000000000000000000000000000000bb";
  const base = { admin, keyAddress: admin as string | null, keyIsGuardian: false };

  it("the admin sets, releases and changes any combination (case-insensitive)", () => {
    assert.deepEqual(decidePauseSigner({ ...base, current: 0, next: 7 }), { role: "admin", unpausing: false });
    assert.deepEqual(decidePauseSigner({ ...base, current: 3, next: 0 }), { role: "admin", unpausing: true });
    assert.deepEqual(decidePauseSigner({ ...base, keyAddress: admin.toUpperCase().replace("0X", "0x"), current: 1, next: 2 }), { role: "admin", unpausing: true });
  });
  it("a guardian only adds bits and never adds TRANSFERS", () => {
    const g = { ...base, keyAddress: guardian, keyIsGuardian: true };
    assert.deepEqual(decidePauseSigner({ ...g, current: 0, next: 1 }), { role: "guardian", unpausing: false });
    assert.deepEqual(decidePauseSigner({ ...g, current: 1, next: 3 }), { role: "guardian", unpausing: false });
    assert.throws(() => decidePauseSigner({ ...g, current: 3, next: 1 }), PauseRuleError);
    assert.throws(() => decidePauseSigner({ ...g, current: 0, next: 4 }), /TRANSFERS/);
    assert.deepEqual(decidePauseSigner({ ...g, current: 4, next: 5 }), { role: "guardian", unpausing: false }, "TRANSFERS already on: adding ENTRIES is fine");
  });
  it("a key that is neither admin nor guardian is refused; invalid flags and no-ops too", () => {
    assert.throws(() => decidePauseSigner({ ...base, keyAddress: guardian, current: 0, next: 1 }), PauseRuleError);
    assert.throws(() => decidePauseSigner({ ...base, current: 0, next: 8 }), PauseRuleError);
    assert.throws(() => decidePauseSigner({ ...base, current: 3, next: 3 }), PauseRuleError);
  });
  it("no key here: plans as the admin (dry-run)", () => {
    assert.deepEqual(decidePauseSigner({ ...base, keyAddress: null, current: 0, next: 3 }), { role: "admin", unpausing: false });
  });
});

describe("slashWait (72 h + 14 days)", () => {
  const T = 1_700_000_000;
  it("before the delay: what is left", () => {
    assert.deepEqual(slashWait(T, T), { remainingSecs: 259_200, executableAt: T + 259_200, expiresAt: T + 259_200 + 14 * 86_400, expired: false, text: "3 d left" });
    assert.equal(slashWait(T, T + 2 * 86_400 + 3600 * 5 + 60 * 20).text, "18 h 40 min left");
    assert.equal(slashWait(T, T + 259_200 - 30).text, "1 min left");
  });
  it("at the instant and after: over; after the grace: expired", () => {
    assert.equal(slashWait(T, T + 259_200).remainingSecs, 0);
    assert.equal(slashWait(BigInt(T), T + 999_999).text, "the 72 h wait is over");
    const end = T + 259_200 + 14 * 86_400;
    assert.equal(slashWait(T, end).expired, false);
    assert.match(slashWait(T, end + 1).text, /EXPIRED/);
  });
});

describe("grant-role: never to this environment's RELAY key (D3, env-local check)", () => {
  const relay = "0x00000000000000000000000000000000000000cc";
  const platform = "0x00000000000000000000000000000000000000dd";
  it("refuses every role to the configured RELAY, case-insensitively; other addresses pass", async () => {
    const { assertRoleGrantAllowed, RoleGrantError, RELAY_CHECK_NOTE } = await import("../src/cli/admin-guard.js");
    for (const role of ["platform", "usage", "verifier", "guardian"]) {
      assert.throws(() => assertRoleGrantAllowed({ role, account: relay.toUpperCase().replace("0X", "0x"), relay, platform, chainId: CHAIN_IDS.moderato }), RoleGrantError);
    }
    assert.doesNotThrow(() => assertRoleGrantAllowed({ role: "verifier", account: platform, relay, platform, chainId: CHAIN_IDS.moderato }));
    assert.match(RELAY_CHECK_NOTE, /only THIS environment's RELAY key/);
  });
  it("local chain with RELAY = PLATFORM: PLATFORM's own roles pass, the others do not", async () => {
    const { assertRoleGrantAllowed, RoleGrantError } = await import("../src/cli/admin-guard.js");
    const k = { account: platform, relay: platform, platform, chainId: CHAIN_IDS.local };
    assert.doesNotThrow(() => assertRoleGrantAllowed({ ...k, role: "platform" }));
    assert.doesNotThrow(() => assertRoleGrantAllowed({ ...k, role: "usage" }));
    assert.throws(() => assertRoleGrantAllowed({ ...k, role: "guardian" }), RoleGrantError);
    assert.throws(() => assertRoleGrantAllowed({ ...k, role: "platform", chainId: CHAIN_IDS.moderato }), RoleGrantError);
  });
});

describe("admin delay schedule (mirrors OpenZeppelin _delayChangeWait)", () => {
  const W = 5 * 86_400;
  it("an increase waits min(new delay, 5 days); a decrease waits the difference", () => {
    assert.equal(adminDelayChangeAt({ current: 0, next: 172_800, increaseWait: W, nowSecs: 1000 }), 1000 + 172_800);
    assert.equal(adminDelayChangeAt({ current: 0, next: 30 * 86_400, increaseWait: W, nowSecs: 1000 }), 1000 + W);
    assert.equal(adminDelayChangeAt({ current: 172_800, next: 3600, increaseWait: W, nowSecs: 1000 }), 1000 + 172_800 - 3600);
    assert.equal(adminDelayChangeAt({ current: 3600, next: 3600, increaseWait: W, nowSecs: 1000 }), 1000);
  });
});

describe("runtime code check of a new implementation (cli:admin upgrade)", () => {
  // 8 code bytes, a 32-byte immutable at offset 2..3 (shortened here to 2 bytes), then a CBOR metadata tail a1 00 + length 0x0002.
  const art = { object: "0x6080aaaa5b00fe00a1000002", immutableReferences: { "7": [{ start: 2, length: 2 }] } };
  it("ignores the immutable slots and the metadata hash", async () => {
    const { runtimeCodeMismatch } = await import("../src/cli/admin-guard.js");
    assert.equal(runtimeCodeMismatch("0x6080aaaa5b00fe00a1000002", art), null);
    assert.equal(runtimeCodeMismatch("0x60801234" + "5b00fe00" + "a1ff0002", art), null, "other immutable value and metadata");
  });
  it("refuses different code or length, and an artifact without runtime code", async () => {
    const { runtimeCodeMismatch } = await import("../src/cli/admin-guard.js");
    assert.match(runtimeCodeMismatch("0x6080aaaa5b01fe00a1000002", art) ?? "", /differs from the local build/);
    assert.match(runtimeCodeMismatch("0x6080aaaa5b00fe00a100000200", art) ?? "", /13 bytes, the local build's is 12 bytes/);
    assert.match(runtimeCodeMismatch("0x6080", { object: "0x" }) ?? "", /no runtime code/);
  });
});
