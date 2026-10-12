import { z } from "zod";
import { getAddress, isAddress as viemIsAddress, keccak256, stringToBytes, type Address as ViemAddress, type Hex as ViemHex } from "viem";

// EVM primitives shared by server, web and api-client: addresses, hex strings, ids and purchase ids.
// Addresses are stored and compared lowercase and displayed checksummed (decisions.md D7).

export type Address = ViemAddress;
export type Hex = ViemHex;

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * True for a 20-byte hex address. All-lowercase and all-uppercase hex are accepted; mixed case must be a valid
 * EIP-55 checksum (a wrong checksum usually means a typo).
 */
export function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return false;
  const body = value.slice(2);
  return body === body.toLowerCase() || body === body.toUpperCase() || viemIsAddress(value, { strict: true });
}

/** Lowercase form of an address (the DB and comparison form). Throws on anything that is not a valid address. */
export function normalizeAddress(value: string): Address {
  const s = value.trim();
  if (!isAddress(s)) throw new Error(`invalid address: ${value}`);
  return s.toLowerCase() as Address;
}

/** EIP-55 checksummed form, for display only. */
export function checksumAddress(value: string): Address {
  return getAddress(normalizeAddress(value));
}

/** Same address, ignoring case. False when either side is not a valid address. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && isAddress(a.trim()) && isAddress(b.trim()) && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** zod: a valid address, normalised to lowercase. */
export const Address = z
  .string()
  .trim()
  .refine((s) => isAddress(s), { message: "invalid address" })
  .transform((s) => s.toLowerCase() as Address);

/** zod: `0x`-prefixed hex with an even number of digits (calldata, signatures). Case is preserved. */
export const Hex = z
  .string()
  .regex(HEX_RE, "invalid hex")
  .transform((s) => s as Hex);

/** zod: 32-byte hex (`0x` + 64 hex digits), normalised to lowercase. Used for ids, hashes and purchase ids. */
export const Bytes32 = z
  .string()
  .regex(BYTES32_RE, "invalid bytes32")
  .transform((s) => s.toLowerCase() as Hex);

/** zod: a transaction hash (66 characters: `0x` + 64 hex digits), normalised to lowercase. */
export const TxHash = Bytes32;

/** zod: a non-negative integer amount in token base units, serialised as a decimal string (bigint-safe JSON). */
export const UnitsString = z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid base-unit amount");

/**
 * One call of a transaction. Tempo 0x76 transactions carry a batch of calls; there is no native token, so `value` is
 * always 0 and never set.
 */
export const Call = z.object({ to: Address, data: Hex, value: z.never().optional() });
export type Call = z.infer<typeof Call>;

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32_RE.test(value);
}

// ----- Agent ids (decisions.md D1) -----

const AGENT_ID_RE = /^[0-9a-f]{32}$/;
const ZERO_TAIL = "0".repeat(32);

/** Package id from the manifest: 16 bytes as 32 lowercase hex characters (PACKAGE_SPEC §4.1). */
export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_RE.test(value);
}

/**
 * On-chain `agentId` for a package id: `bytes32(bytes16(manifest.id))`, i.e. the 16 bytes left-aligned and padded with
 * 16 zero bytes. Accepts upper-case hex and normalises it.
 */
export function agentIdToBytes32(id: string): Hex {
  const s = id.trim().toLowerCase();
  if (!AGENT_ID_RE.test(s)) throw new Error(`invalid agent id (expected 32 hex characters): ${id}`);
  return `0x${s}${ZERO_TAIL}`;
}

/** Inverse of `agentIdToBytes32`. Throws when the value is not bytes32 or its low 16 bytes are not zero. */
export function bytes32ToAgentId(value: string): string {
  const s = value.trim().toLowerCase();
  if (!BYTES32_RE.test(s)) throw new Error(`invalid bytes32: ${value}`);
  if (s.slice(34) !== ZERO_TAIL) throw new Error(`not an agent id (low 16 bytes must be zero): ${value}`);
  return s.slice(2, 34);
}

// ----- Purchase ids (plan §4.8, decisions.md D4/D10) -----

/** Domain prefix of every purchase id; bumping the version would change every derived id. */
export const PURCHASE_ID_PREFIX = "solvers:v1:";

/**
 * Purchase id for a charge: `keccak256(utf8("solvers:v1:" + chargeId))`. The contracts reject a reused purchase id, so
 * replaying a webhook or a fulfilment can never buy twice.
 */
export function purchaseIdFor(chargeId: string): Hex {
  if (typeof chargeId !== "string" || chargeId.length === 0) throw new Error("chargeId must be a non-empty string");
  return keccak256(stringToBytes(PURCHASE_ID_PREFIX + chargeId));
}

// ----- Networks (plan §1, T1) -----

export const TEMPO_CHAIN_IDS = { mainnet: 4217, testnet: 42431, local: 31337 } as const;
export type TempoNetwork = keyof typeof TEMPO_CHAIN_IDS;

/** Which network a chain id belongs to; null for any other chain. */
export function networkOf(chainId: number): TempoNetwork | null {
  for (const [name, id] of Object.entries(TEMPO_CHAIN_IDS)) if (id === chainId) return name as TempoNetwork;
  return null;
}

export function isMainnet(chainId: number): boolean {
  return chainId === TEMPO_CHAIN_IDS.mainnet;
}
