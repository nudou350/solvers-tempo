import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { siweDomains, siweProblem, NONCE_TTL_MS } from "../src/auth/siwe-rules.js";
import { isEoaSignature, verifyWalletSignature } from "../src/auth/siwe.js";

// Pure SIWE rules (EIP-4361, decisions.md D7) and EOA signature checks; no database or chain.

const NOW = new Date("2026-10-11T12:00:00Z");
const DOMAINS = ["solvers.test", "api.solvers.test"];
const acct = privateKeyToAccount(generatePrivateKey());

function msg(over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  return createSiweMessage({
    address: acct.address,
    chainId: 42431,
    domain: "solvers.test",
    uri: "https://solvers.test",
    nonce: "abcdef0123456789",
    version: "1",
    statement: "Sign in to Solvers.",
    issuedAt: new Date(NOW.getTime() - 10_000),
    expirationTime: new Date(NOW.getTime() + NONCE_TTL_MS),
    ...over,
  });
}
const check = (m: string, o: { expectedAddress?: string; now?: Date } = {}) =>
  siweProblem(parseSiweMessage(m), { domains: DOMAINS, chainId: 42431, now: o.now ?? NOW, expectedAddress: o.expectedAddress });

describe("siweDomains", () => {
  it("defaults to the web and API hosts; SIWE_DOMAINS replaces them", () => {
    assert.deepEqual(siweDomains(undefined, "https://Solvers.test", "https://solvers.test:8443/api"), ["solvers.test", "solvers.test:8443"]);
    assert.deepEqual(siweDomains(" a.test , b.test ", "https://x.test", "https://y.test"), ["a.test", "b.test"]);
  });
});

describe("siweProblem", () => {
  it("a well-formed message passes (with and without the expected address, any case)", () => {
    assert.equal(check(msg()), null);
    assert.equal(check(msg(), { expectedAddress: acct.address.toLowerCase() }), null);
  });

  it("refuses another domain, a uri on another host and an unparseable uri", () => {
    assert.match(check(msg({ domain: "evil.test" }))!, /domain/);
    assert.match(check(msg({ uri: "https://evil.test/login" }))!, /URI/);
  });

  it("refuses another chain id", () => {
    assert.match(check(msg({ chainId: 4217 }))!, /network/);
  });

  it("refuses an address mismatch", () => {
    const other = privateKeyToAccount(generatePrivateKey());
    assert.match(check(msg(), { expectedAddress: other.address })!, /address/);
  });

  it("refuses an expired message, a not-yet-valid one and an issue date outside the nonce lifetime", () => {
    assert.match(check(msg({ expirationTime: new Date(NOW.getTime() - 1) }))!, /expired/);
    assert.match(check(msg({ notBefore: new Date(NOW.getTime() + 10 * 60_000) }))!, /not valid yet/);
    assert.match(check(msg({ issuedAt: new Date(NOW.getTime() - NONCE_TTL_MS - 2 * 60_000) }))!, /validity window/);
    assert.match(check(msg({ issuedAt: new Date(NOW.getTime() + 5 * 60_000) }))!, /validity window/);
  });

  it("refuses non-SIWE text and a broken date", () => {
    assert.match(check("hello")!, /address/);
    const broken = msg().replace(/Issued At: .+/, "Issued At: yesterday");
    assert.match(check(broken)!, /issue date/);
  });
});

describe("EOA signatures (EIP-191)", () => {
  it("accepts the signer, refuses another key, garbage and non-65-byte signatures", async () => {
    const m = msg();
    const sig = await acct.signMessage({ message: m });
    assert.equal(await isEoaSignature(acct.address, m, sig), true);
    assert.equal(await isEoaSignature(acct.address.toLowerCase(), m, sig), true);
    const other = privateKeyToAccount(generatePrivateKey());
    assert.equal(await isEoaSignature(other.address, m, sig), false);
    assert.equal(await isEoaSignature(acct.address, m + " ", sig), false);
    assert.equal(await isEoaSignature(acct.address, m, "0x1234"), false);
    assert.equal(await isEoaSignature(acct.address, m, "not hex"), false);
  });

  it("verifyWalletSignature without a chain context refuses contract signatures instead of throwing", async () => {
    assert.equal(await verifyWalletSignature(acct.address, "x", `0x${"ab".repeat(100)}`, { allowContract: true }), false);
  });
});
