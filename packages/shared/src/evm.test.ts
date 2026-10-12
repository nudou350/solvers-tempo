import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  Address,
  Bytes32,
  Call,
  PURCHASE_ID_PREFIX,
  TEMPO_CHAIN_IDS,
  TxHash,
  UnitsString,
  agentIdToBytes32,
  bytes32ToAgentId,
  checksumAddress,
  isAddress,
  isAgentId,
  isMainnet,
  isTxHash,
  networkOf,
  normalizeAddress,
  purchaseIdFor,
  sameAddress,
} from "./evm.js";

// EIP-55 test vector.
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const BAD_CHECKSUM = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

test("Address: lowercase storage form, checksummed display", () => {
  assert.equal(normalizeAddress(CHECKSUMMED), LOWER);
  assert.equal(normalizeAddress(LOWER), LOWER);
  assert.equal(normalizeAddress(` ${LOWER.toUpperCase().replace("0X", "0x")} `), LOWER);
  assert.equal(checksumAddress(LOWER), CHECKSUMMED);
  assert.equal(Address.parse(CHECKSUMMED), LOWER);
  assert.equal(isAddress(CHECKSUMMED), true);
  assert.equal(isAddress(LOWER), true);
  for (const bad of [BAD_CHECKSUM, "0x123", LOWER.slice(2), `${LOWER}00`, "0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "", null, 42]) {
    assert.equal(isAddress(bad), false, String(bad));
    assert.equal(Address.safeParse(bad).success, false, String(bad));
  }
  assert.throws(() => normalizeAddress(BAD_CHECKSUM));
  assert.equal(sameAddress(CHECKSUMMED, LOWER), true);
  assert.equal(sameAddress(LOWER, "0x0000000000000000000000000000000000000001"), false);
  assert.equal(sameAddress(null, LOWER), false);
});

test("Bytes32 / TxHash / UnitsString / Call", () => {
  const h = `0x${"AB".repeat(32)}`;
  assert.equal(TxHash.parse(h), h.toLowerCase());
  assert.equal(Bytes32.parse(h).length, 66);
  assert.equal(isTxHash(h), true);
  for (const bad of [`0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`, "ab".repeat(32), `0x${"zz".repeat(32)}`]) {
    assert.equal(TxHash.safeParse(bad).success, false, bad);
  }
  assert.equal(UnitsString.parse("5000000"), "5000000");
  for (const bad of ["-1", "01", "1.5", "", "1e6"]) assert.equal(UnitsString.safeParse(bad).success, false, bad);
  assert.deepEqual(Call.parse({ to: CHECKSUMMED, data: "0xa9059cbb" }), { to: LOWER, data: "0xa9059cbb" });
  assert.equal(Call.safeParse({ to: LOWER, data: "0xabc" }).success, false, "odd-length data");
  assert.equal(Call.safeParse({ to: LOWER, data: "0x", value: 1n }).success, false, "no value on Tempo");
});

test("agentId <-> bytes32 (D1: left-aligned bytes16)", () => {
  const id = "3f9a1c2e7b8d4e6fa1b2c3d4e5f60718";
  const b = agentIdToBytes32(id);
  assert.equal(b, `0x${id}${"0".repeat(32)}`);
  assert.equal(b.length, 66);
  assert.equal(bytes32ToAgentId(b), id);
  assert.equal(agentIdToBytes32(id.toUpperCase()), b);
  assert.equal(bytes32ToAgentId(b.toUpperCase().replace("0X", "0x")), id);
  assert.equal(isAgentId(id), true);
  assert.equal(isAgentId(id.toUpperCase()), false);
  for (const bad of ["", "3f9a", `${id}00`, `0x${id}`, "g".repeat(32)]) assert.throws(() => agentIdToBytes32(bad), Error, bad);
  assert.throws(() => bytes32ToAgentId(`0x${id}${"0".repeat(31)}1`), /low 16 bytes/);
  assert.throws(() => bytes32ToAgentId(`0x${id}`));
});

test("purchaseIdFor: keccak256(utf8('solvers:v1:' + chargeId)), deterministic", () => {
  assert.equal(PURCHASE_ID_PREFIX, "solvers:v1:");
  const a = purchaseIdFor("pix_0001");
  assert.equal(a, "0x2d7ac852544b345815fd61c7aea37053435623a4d19f4332da65c92c871b2775");
  assert.equal(a, keccak256(toBytes("solvers:v1:pix_0001")));
  assert.equal(purchaseIdFor("pix_0001"), a);
  assert.notEqual(purchaseIdFor("pix_0002"), a);
  // A charge id that looks like hex is still hashed as text (the prefix keeps it a string).
  assert.equal(purchaseIdFor("0x1234"), keccak256(toBytes("solvers:v1:0x1234")));
  assert.equal(isTxHash(a), true);
  assert.throws(() => purchaseIdFor(""));
});

test("networks", () => {
  assert.deepEqual(TEMPO_CHAIN_IDS, { mainnet: 4217, testnet: 42431, local: 31337 });
  assert.equal(networkOf(4217), "mainnet");
  assert.equal(networkOf(42431), "testnet");
  assert.equal(networkOf(31337), "local");
  assert.equal(networkOf(1), null);
  assert.equal(isMainnet(4217), true);
  assert.equal(isMainnet(42431), false);
});
