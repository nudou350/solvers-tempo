// A throwaway Solana keypair file (solana-keygen format) for the Solana Pay tests. Never funded, never on any network.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";

export function writeTestKeypair(): { path: string; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const path = join(mkdtempSync(join(tmpdir(), "solvers-solpay-")), "keypair.json");
  writeFileSync(path, JSON.stringify([...secret, ...pub]));
  return { path, address: getBase58Decoder().decode(pub) };
}
