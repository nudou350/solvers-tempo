import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseSignature, serializeSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MEMORY_KEY_MESSAGE } from "@solvers/shared";
import { canonicalSignature, deriveMemoryKey, memoryKeyFromSignature, unwrapKey, verifyMemorySignature, wrapKey } from "../src/memory/crypto.js";

// Memory key (decisions.md D8): HKDF over an EIP-191 signature of MEMORY_KEY_MESSAGE, deterministic for EOAs; no database.

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("memory key from an EOA signature", () => {
  it("the same key signs the same bytes (RFC 6979), so the derived key is stable", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const s1 = await a.signMessage({ message: MEMORY_KEY_MESSAGE });
    const s2 = await a.signMessage({ message: MEMORY_KEY_MESSAGE });
    assert.equal(s1, s2);
    const k1 = await memoryKeyFromSignature(a.address, s1);
    const k2 = await memoryKeyFromSignature(a.address.toLowerCase(), s2);
    assert.ok(k1 && k2);
    assert.equal(k1.length, 32);
    assert.ok(k1.equals(k2), "address case does not change the key");
  });

  it("v as 0/1 and the high-s twin of the same signature give the same key", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const sig = await a.signMessage({ message: MEMORY_KEY_MESSAGE });
    const p = parseSignature(sig);
    const v01 = (sig.slice(0, 130) + (p.yParity === 0 ? "00" : "01")) as Hex;
    const highS = serializeSignature({ r: p.r, s: `0x${(N - BigInt(p.s)).toString(16).padStart(64, "0")}`, yParity: p.yParity === 0 ? 1 : 0 });
    assert.equal(canonicalSignature(v01), canonicalSignature(sig));
    assert.equal(canonicalSignature(highS), canonicalSignature(sig));
    const k = await memoryKeyFromSignature(a.address, sig);
    assert.ok(k!.equals((await memoryKeyFromSignature(a.address, highS))!));
    assert.ok(k!.equals((await memoryKeyFromSignature(a.address, v01))!));
  });

  it("different wallets get different keys; another signer, another message or a non-ECDSA blob are refused", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const sa = await a.signMessage({ message: MEMORY_KEY_MESSAGE });
    const sb = await b.signMessage({ message: MEMORY_KEY_MESSAGE });
    assert.ok(!(await memoryKeyFromSignature(a.address, sa))!.equals((await memoryKeyFromSignature(b.address, sb))!));
    assert.equal(await verifyMemorySignature(b.address, sa), null);
    assert.equal(await verifyMemorySignature(a.address, await a.signMessage({ message: "something else" })), null);
    // ERC-1271 / ERC-6492 signatures (longer than 65 bytes) never unlock memories.
    assert.equal(await verifyMemorySignature(a.address, `0x${"11".repeat(200)}`), null);
    assert.equal(await verifyMemorySignature(a.address, "base64=="), null);
  });

  it("deriveMemoryKey uses the lowercase wallet as salt; wrap/unwrap round-trips with the KEK", () => {
    const sig = new Uint8Array(65).fill(3);
    const k = deriveMemoryKey(sig, "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD");
    assert.ok(k.equals(deriveMemoryKey(sig, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")));
    assert.ok(unwrapKey(wrapKey(k)).equals(k));
  });
});

describe("POST /api/me/memory-key", () => {
  it("a refused signature answers 400 memory_signature_refused, never 401 (the session stays valid)", async () => {
    const { createApp } = await import("../src/app.js");
    const { meRouter } = await import("../src/store/me.js");
    const { signSession, SESSION_COOKIE } = await import("../src/auth/jwt.js");
    const me = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const server = createApp([(app) => app.use("/api", meRouter)]).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/me/memory-key`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${await signSession(me.address.toLowerCase())}` },
        body: JSON.stringify({ signature: await other.signMessage({ message: MEMORY_KEY_MESSAGE }) }),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code?: string }).code, "memory_signature_refused");
    } finally {
      server.close();
    }
  });
});
