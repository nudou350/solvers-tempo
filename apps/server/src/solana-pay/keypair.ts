import { readFileSync } from "node:fs";
import { getBase58Decoder } from "@solana/kit";

// The Solana Pay keypair file (solana-keygen format: a JSON array of 64 bytes, secret key then public key). Read by
// env.ts at boot (validation) and by the provider (recipient address, refund signer). Errors never quote the file:
// a malformed JSON message would carry part of the secret key.

export class SolanaKeyError extends Error {
  constructor(message = "SOLANA_PAY_KEYPAIR is not a readable Solana keypair file (JSON array of 64 bytes).") {
    super(message);
  }
}

/** The 64 bytes of a solana-keygen JSON file. */
export function readSolanaKeypair(path: string): Uint8Array {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SolanaKeyError();
  }
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new SolanaKeyError();
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new SolanaKeyError();
  return Uint8Array.from(arr as number[]);
}

/** Base58 address of a 64-byte keypair (its last 32 bytes). The signer built from it checks that the halves match. */
export function keypairAddress(bytes: Uint8Array): string {
  if (bytes.length !== 64) throw new SolanaKeyError();
  return getBase58Decoder().decode(bytes.slice(32));
}
