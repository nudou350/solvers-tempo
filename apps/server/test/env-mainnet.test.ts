import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// On mainnet the server must not load the admin/guardian/deployer keys (decisions.md D11, D20); the worker starts without
// any chain key. Pure: no network or database.

const BASE: NodeJS.ProcessEnv = {
  JWT_SECRET: "j".repeat(32),
  SERVER_KEK: "k".repeat(44),
};
/** Mainnet requires an explicit payment token (owed decision #1); the tests use the pathUSD address as a placeholder. */
const MAINNET: NodeJS.ProcessEnv = { ...BASE, CHAIN_ID: "4217", PAYMENT_TOKEN: "0x20c0000000000000000000000000000000000000" };

// env.ts validates process.env on import (export const env = loadEnv()): fill only what is missing, then import.
for (const [k, v] of Object.entries(BASE)) process.env[k] ??= v;
const { forbiddenMainnetKeys, loadEnv } = await import("../src/env.js");

const ADMIN_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

describe("env: power keys forbidden on mainnet (CHAIN_ID=4217)", () => {
  it("mainnet with ADMIN_PRIVATE_KEY aborts and names the variable without leaking the value", () => {
    assert.throws(
      () => loadEnv({ ...MAINNET, ADMIN_PRIVATE_KEY: ADMIN_KEY }),
      (e: unknown) => e instanceof Error && /ADMIN_PRIVATE_KEY/.test(e.message) && /4217/.test(e.message) && !e.message.includes(ADMIN_KEY.slice(2, 20)),
    );
  });

  it("mainnet also refuses the guardian and deployer keys, listing all of them", () => {
    assert.throws(
      () => loadEnv({ ...MAINNET, GUARDIAN_PRIVATE_KEY: "g.key", DEPLOYER_PRIVATE_KEY: "d.key" }),
      (e: unknown) => e instanceof Error && /GUARDIAN_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY/.test(e.message),
    );
  });

  it("mainnet without those keys (or with an empty variable) loads", () => {
    assert.equal(loadEnv({ ...MAINNET }).CHAIN_ID, 4217);
    assert.equal(loadEnv({ ...MAINNET, ADMIN_PRIVATE_KEY: "  " }).ADMIN_PRIVATE_KEY, undefined);
  });

  it("Moderato and the local chain keep accepting ADMIN_PRIVATE_KEY (dev CLIs)", () => {
    assert.equal(loadEnv({ ...BASE, CHAIN_ID: "42431", ADMIN_PRIVATE_KEY: ADMIN_KEY }).ADMIN_PRIVATE_KEY, ADMIN_KEY);
    assert.equal(loadEnv({ ...BASE, ADMIN_PRIVATE_KEY: ADMIN_KEY }).CHAIN_ID, 31337);
  });

  it("forbiddenMainnetKeys ignores empty and unrelated variables", () => {
    assert.deepEqual(forbiddenMainnetKeys({ ADMIN_PRIVATE_KEY: "", PLATFORM_PRIVATE_KEY: "x" }), []);
    assert.deepEqual(forbiddenMainnetKeys({ ADMIN_PRIVATE_KEY: "a" }), ["ADMIN_PRIVATE_KEY"]);
  });

  it("the worker's environment needs no chain key at all", () => {
    const e = loadEnv({ ...MAINNET });
    assert.equal(e.PLATFORM_PRIVATE_KEY, undefined);
    assert.equal(e.RELAY_PRIVATE_KEY, undefined);
    assert.equal(e.VERIFIER_PRIVATE_KEY, undefined);
  });

  it("mainnet refuses to start without an explicit PAYMENT_TOKEN", () => {
    assert.throws(() => loadEnv({ ...BASE, CHAIN_ID: "4217" }), /PAYMENT_TOKEN must be set explicitly/);
  });

  it("keys are compared by address, not by spelling", () => {
    const upper = `0x${ADMIN_KEY.slice(2).toUpperCase()}`;
    assert.throws(() => loadEnv({ ...BASE, CHAIN_ID: "42431", PLATFORM_PRIVATE_KEY: ADMIN_KEY, RELAY_PRIVATE_KEY: upper }), /RELAY_PRIVATE_KEY must differ/);
  });
});
