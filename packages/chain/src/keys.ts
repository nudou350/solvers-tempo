import { readFileSync } from "node:fs";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Loads a secp256k1 private key from an env value: either the hex key itself or a path to a file that contains it
 * (`apps/server/.keys/*`, never committed). Throws with the variable name, never with the key.
 */
export function loadPrivateKey(value: string | undefined, name: string): `0x${string}` {
  if (!value) throw new Error(`${name} is not set`);
  const raw = value.trim();
  if (PK_RE.test(raw)) return raw as `0x${string}`;
  let file: string;
  try {
    file = readFileSync(raw, "utf8").trim();
  } catch {
    throw new Error(`${name} is neither a 0x-prefixed 32-byte key nor a readable key file`);
  }
  if (!PK_RE.test(file)) throw new Error(`${name} file does not contain a 0x-prefixed 32-byte key`);
  return file as `0x${string}`;
}

/** viem local account for an env key (see `loadPrivateKey`). */
export function loadAccount(value: string | undefined, name: string): PrivateKeyAccount {
  return privateKeyToAccount(loadPrivateKey(value, name));
}
