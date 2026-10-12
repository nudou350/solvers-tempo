import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, schema, type Db } from "../db/index.js";
import { env } from "../env.js";
import { HttpError } from "../lib/http.js";
import { randomId } from "../lib/crypto.js";
import { MEMORY_KEY_MESSAGE } from "@solvers/shared";
import { hexToBytes, isHex, parseSignature, recoverMessageAddress, serializeSignature, type Hex } from "viem";
import { EMPTY_MEMORY, MemoryRuleError, applyForget, applySave, readPayload, type MemoryNote, type MemoryPayload, type SaveOp } from "./rules.js";

// Encrypted memories (decisions.md D8). Honest MVP model: encrypted at rest, opened only during a session the wallet
// authorized, never stored in the clear.
//
// 1. The wallet signs the constant MEMORY_KEY_MESSAGE with EIP-191 personal_sign. secp256k1 signatures of EOAs (Privy
//    embedded wallets, injected wallets, agent keys) are deterministic (RFC 6979), so the same wallet always yields the
//    same key. Smart accounts (ERC-1271/ERC-6492) are REJECTED: their signatures are not guaranteed deterministic and the
//    memories would become unreadable.
// 2. The signature is canonicalised (low-s, v = 27/28) so the two encodings of the same signature give the same key.
// 3. memoryKey = HKDF-SHA256(signature r|s|v, salt = wallet lowercase, info = "solvers-memory"), 32 bytes.
// 4. The memoryKey is stored only wrapped with SERVER_KEK, bound to the token, until it expires.
// 5. Each memory is AES-256-GCM with a random iv.

export { MEMORY_KEY_MESSAGE };

const KEK = Buffer.from(env.SERVER_KEK, "base64");
if (KEK.length !== 32) throw new Error("SERVER_KEK must be 32 bytes in base64");

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** 65-byte canonical form (r | low-s | v 27/28) of a secp256k1 signature; null when it is not one (e.g. ERC-1271/6492). */
export function canonicalSignature(signature: string): Hex | null {
  if (!isHex(signature) || signature.length !== 132) return null;
  try {
    const sig = parseSignature(signature);
    let s = BigInt(sig.s);
    let yParity = sig.yParity;
    if (s > SECP256K1_N / 2n) {
      s = SECP256K1_N - s;
      yParity = yParity === 0 ? 1 : 0;
    }
    return serializeSignature({ r: sig.r, s: `0x${s.toString(16).padStart(64, "0")}`, yParity });
  } catch {
    return null;
  }
}

/**
 * Verifies the memory-key signature (EIP-191 of MEMORY_KEY_MESSAGE) of an EOA and returns its canonical bytes, the input of
 * deriveMemoryKey. Null for a wrong signer or anything that is not a plain 65-byte secp256k1 signature.
 */
export async function verifyMemorySignature(wallet: string, signature: string, message: string = MEMORY_KEY_MESSAGE): Promise<Uint8Array | null> {
  const canonical = canonicalSignature(signature);
  if (!canonical) return null;
  try {
    const signer = await recoverMessageAddress({ message, signature: canonical });
    return signer.toLowerCase() === wallet.toLowerCase() ? hexToBytes(canonical) : null;
  } catch {
    return null;
  }
}

export function deriveMemoryKey(signature: Uint8Array, wallet: string): Buffer {
  return Buffer.from(hkdfSync("sha256", signature, Buffer.from(wallet.toLowerCase()), Buffer.from("solvers-memory"), 32));
}

/** verifyMemorySignature + deriveMemoryKey: the memory key of `wallet`, or null when the signature is not valid for it. */
export async function memoryKeyFromSignature(wallet: string, signature: string): Promise<Buffer | null> {
  const sig = await verifyMemorySignature(wallet, signature);
  return sig ? deriveMemoryKey(sig, wallet) : null;
}

/** AES-256-GCM. `aad` binds the ciphertext to its owner (wallet|solver): rows cannot be swapped. */
function seal(key: Buffer, plaintext: Buffer, aad?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad?: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Wraps the memoryKey with the server KEK: iv(12) | tag(16) | ct(32). */
export function wrapKey(memoryKey: Buffer): Buffer {
  const { iv, tag, ciphertext } = seal(KEK, memoryKey);
  return Buffer.concat([iv, tag, ciphertext]);
}

export function unwrapKey(wrapped: Buffer): Buffer {
  return open(KEK, wrapped.subarray(0, 12), wrapped.subarray(12, 28), wrapped.subarray(28));
}

/** Plain connection or an open transaction (db.transaction): the caller decides the atomic scope. */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function storeMemoryKey(tokenId: string, wallet: string, wrapped: Buffer, expiresAt: Date, exec: DbExecutor = db) {
  await exec.delete(schema.memoryKeys).where(lt(schema.memoryKeys.expiresAt, new Date()));
  await exec
    .insert(schema.memoryKeys)
    .values({ tokenId, wallet, wrappedKey: wrapped, expiresAt })
    .onConflictDoUpdate({ target: schema.memoryKeys.tokenId, set: { wrappedKey: wrapped, expiresAt, wallet } });
}

export async function memoryKeyFor(tokenId: string | undefined, wallet: string): Promise<Buffer | null> {
  if (!tokenId) return null;
  const [row] = await db
    .select()
    .from(schema.memoryKeys)
    .where(and(eq(schema.memoryKeys.tokenId, tokenId), eq(schema.memoryKeys.wallet, wallet), gt(schema.memoryKeys.expiresAt, new Date())));
  return row ? unwrapKey(row.wrappedKey) : null;
}

const aadOf = (wallet: string, agentId: string) => `${wallet}|${agentId}`;

function sealPayload(key: Buffer, wallet: string, agentId: string, payload: MemoryPayload) {
  return seal(key, Buffer.from(JSON.stringify(payload)), aadOf(wallet, agentId));
}

/**
 * Read, merge and write a specialist's memory without losing data under parallel calls (PACKAGE_SPEC.md 11.2).
 * `SELECT … FOR UPDATE` does not lock a row that does not exist yet, so the first write creates the row with
 * `INSERT … ON CONFLICT DO NOTHING` and only then locks it; the merge runs with the row locked. If `mutate` throws (limit
 * exceeded), the transaction rolls everything back, including the created row. `create: false` (forget): never creates
 * the row; without a memory it returns null.
 */
export async function updateMemory<T>(
  wallet: string,
  agentId: string,
  key: Buffer,
  mutate: (cur: MemoryPayload) => { next: MemoryPayload; result: T },
  opts: { create?: boolean } = {},
): Promise<T | null> {
  const create = opts.create ?? true;
  return db.transaction(async (tx) => {
    if (create) {
      const empty = sealPayload(key, wallet, agentId, EMPTY_MEMORY);
      await tx
        .insert(schema.memories)
        .values({ id: `mem_${randomId(10)}`, wallet, agentId, ciphertext: empty.ciphertext, iv: empty.iv, tag: empty.tag, updatedAt: new Date() })
        .onConflictDoNothing({ target: [schema.memories.wallet, schema.memories.agentId] });
    }
    const [row] = await tx
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.wallet, wallet), eq(schema.memories.agentId, agentId)))
      .for("update");
    if (!row) return null;
    let cur: MemoryPayload;
    try {
      cur = readPayload(JSON.parse(open(key, row.iv, row.tag, row.ciphertext, aadOf(wallet, agentId)).toString("utf8")));
    } catch {
      // Does not open with this key: rewriting would erase the existing memory.
      throw new HttpError(409, "I couldn't open the memory already stored for this connection. Ask the user to reconnect Solvers and confirm the memory signature.", "memory_key_mismatch");
    }
    let applied: { next: MemoryPayload; result: T };
    try {
      applied = mutate(cur);
    } catch (e) {
      if (e instanceof MemoryRuleError) throw new HttpError(400, e.message, "memory_limit");
      throw e;
    }
    const s = sealPayload(key, wallet, agentId, applied.next);
    await tx
      .update(schema.memories)
      .set({ ciphertext: s.ciphertext, iv: s.iv, tag: s.tag, updatedAt: new Date() })
      .where(eq(schema.memories.id, row.id));
    return applied.result;
  });
}

/** save_memory: `summary` (replaces the summary), `note` (appends) or `profile` (replaces the profile). */
export async function saveMemory(wallet: string, agentId: string, key: Buffer, op: SaveOp) {
  return updateMemory(wallet, agentId, key, (cur) => {
    const r = applySave(cur, op, new Date(), () => randomId(2));
    return { next: r.next, result: { note: r.created ?? null, duplicate: r.duplicate === true } };
  });
}

/** forget_memory: removes a note. null: the specialist has no memory; false: the note does not exist. */
export async function forgetNote(wallet: string, agentId: string, key: Buffer, noteId: string) {
  return updateMemory(wallet, agentId, key, (cur) => {
    const r = applyForget(cur, noteId);
    return { next: r.next, result: r.found };
  }, { create: false });
}

export type OpenMemory = { id: string; agentId: string; summary: string; profile: MemoryPayload["profile"]; notes: MemoryNote[]; updatedAt: Date };

export async function readMemories(wallet: string, key: Buffer, agentId?: string): Promise<OpenMemory[]> {
  const rows = await db
    .select()
    .from(schema.memories)
    .where(agentId ? and(eq(schema.memories.wallet, wallet), eq(schema.memories.agentId, agentId)) : eq(schema.memories.wallet, wallet));
  const out: OpenMemory[] = [];
  for (const r of rows) {
    try {
      const payload = readPayload(JSON.parse(open(key, r.iv, r.tag, r.ciphertext, aadOf(r.wallet, r.agentId)).toString("utf8")));
      out.push({ id: r.id, agentId: r.agentId, summary: payload.summary, profile: payload.profile, notes: payload.notes, updatedAt: r.updatedAt });
    } catch {
      // Different key (another wallet/signature): cannot be opened. Never returns raw bytes.
    }
  }
  return out;
}

export async function deleteMemory(wallet: string, id: string) {
  const r = await db
    .delete(schema.memories)
    .where(and(eq(schema.memories.wallet, wallet), eq(schema.memories.id, id)))
    .returning();
  return r.length > 0;
}

/** "Delete everything": removes the memories and the session keys, voiding any access. */
export async function deleteAllMemories(wallet: string) {
  await db.delete(schema.memories).where(eq(schema.memories.wallet, wallet));
  await db.delete(schema.memoryKeys).where(eq(schema.memoryKeys.wallet, wallet));
}
