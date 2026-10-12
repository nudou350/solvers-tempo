import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { emailLinkedToWallet, parseLinkedAccounts, pemFromEnv, verifyPrivyAccessToken, verifyPrivyIdentityToken, type PrivyConfig } from "../src/auth/privy.js";

// Privy token verification with jose (ES256, iss "privy.io", aud = app id), with a locally generated key; no network.

const WALLET = "0x1111111111111111111111111111111111111111";
let cfg: PrivyConfig;
let sign: (claims: Record<string, unknown>, o?: { iss?: string; aud?: string; exp?: string; alg?: "ES256" }) => Promise<string>;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  cfg = { appId: "app_test", verificationKey: await exportSPKI(publicKey) };
  sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(o.iss ?? "privy.io")
      .setAudience(o.aud ?? "app_test")
      .setSubject("did:privy:abc123")
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "1h")
      .sign(privateKey);
});

describe("Privy tokens", () => {
  it("access token: returns the DID and session id", async () => {
    const out = await verifyPrivyAccessToken(await sign({ sid: "s1" }), cfg);
    assert.deepEqual(out, { userId: "did:privy:abc123", sessionId: "s1" });
  });

  it("identity token: linked_accounts is a stringified array", async () => {
    const accounts = [
      { type: "email", address: "Maria@Example.com" },
      { type: "wallet", address: "0x1111111111111111111111111111111111111111", chain_type: "ethereum", wallet_client_type: "privy" },
    ];
    const id = await verifyPrivyIdentityToken(await sign({ linked_accounts: JSON.stringify(accounts) }), cfg);
    assert.equal(id.userId, "did:privy:abc123");
    assert.equal(emailLinkedToWallet(id.linkedAccounts, WALLET.toUpperCase().replace("0X", "0x")), "Maria@Example.com");
  });

  it("refuses another issuer, another audience, an expired token and another key", async () => {
    await assert.rejects(verifyPrivyAccessToken(await sign({}, { iss: "evil.io" }), cfg), /Invalid or expired/);
    await assert.rejects(verifyPrivyAccessToken(await sign({}, { aud: "other_app" }), cfg), /Invalid or expired/);
    await assert.rejects(verifyPrivyAccessToken(await sign({}, { exp: "-1m" }), cfg), /Invalid or expired/);
    const other = await generateKeyPair("ES256");
    await assert.rejects(verifyPrivyAccessToken(await sign({}), { ...cfg, verificationKey: await exportSPKI(other.publicKey) }), /Invalid or expired/);
  });

  it("emailLinkedToWallet: null when the wallet is not linked, is not Ethereum, or there is no e-mail", () => {
    const email = { type: "email", address: "a@b.com" };
    assert.equal(emailLinkedToWallet([email], WALLET), null);
    assert.equal(emailLinkedToWallet([email, { type: "wallet", address: "0x2222222222222222222222222222222222222222", chain_type: "ethereum" }], WALLET), null);
    assert.equal(emailLinkedToWallet([email, { type: "wallet", address: WALLET, chain_type: "other" }], WALLET), null);
    assert.equal(emailLinkedToWallet([{ type: "wallet", address: WALLET, chain_type: "ethereum" }], WALLET), null);
  });

  it("parseLinkedAccounts tolerates arrays and garbage; pemFromEnv accepts escaped newlines and a bare body", () => {
    assert.equal(parseLinkedAccounts([{ type: "email" }]).length, 1);
    assert.deepEqual(parseLinkedAccounts("{not json"), []);
    assert.deepEqual(parseLinkedAccounts(42), []);
    const pem = cfg.verificationKey.trim();
    assert.equal(pemFromEnv(pem.replace(/\n/g, "\\n")), pem);
    const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    assert.equal(pemFromEnv(body).replace(/\s+/g, ""), pem.replace(/\s+/g, ""));
  });
});
