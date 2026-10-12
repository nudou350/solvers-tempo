import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { checksumAddress, isAddress, normalizeAddress, type Address } from "@solvers/shared";
import { isHex, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";

import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { badRequest, unauthorized } from "../lib/http.js";
import { chainContext } from "../chain/index.js";
import { LOGIN_STATEMENT, MAX_MESSAGE_LENGTH, NONCE_TTL_MS, siweDomains, siweProblem, type NoncePurpose } from "./siwe-rules.js";

// Sign-In with Ethereum (EIP-4361, decisions.md D7). The server issues a single-use nonce bound to an address and a purpose;
// the wallet signs the SIWE message (EIP-191 personal_sign) and the server checks the fields (siwe-rules.ts), the
// signature and the nonce. Purposes keep the flows apart: a "login" nonce (web) is never valid for "oauth" (consent page)
// or "agent" (/oauth/agent/*), and vice versa.

export { LOGIN_STATEMENT, NONCE_TTL_MS, type NoncePurpose } from "./siwe-rules.js";

/** Hosts accepted as the SIWE domain (SIWE_DOMAINS, else the hosts of PUBLIC_WEB_URL and PUBLIC_API_URL). */
export function allowedDomains(): string[] {
  return siweDomains(env.SIWE_DOMAINS, env.PUBLIC_WEB_URL, env.PUBLIC_API_URL);
}

/** Lowercase address from user input; 400 when it is not a valid address. */
export function parseWalletAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value.trim())) throw badRequest("Invalid wallet address");
  return normalizeAddress(value);
}

/** Where the server-built message says the sign-in happens; both must be allowed hosts. */
export type SiweOrigin = { domain?: string | undefined; uri?: string | undefined };

function resolveOrigin(origin: SiweOrigin = {}): { domain: string; uri: string } {
  const domains = allowedDomains();
  const domain = origin.domain?.toLowerCase() ?? domains[0]!;
  if (!domains.includes(domain)) throw badRequest("Domain not allowed for sign-in");
  let uri = origin.uri ?? env.PUBLIC_WEB_URL;
  try {
    const u = new URL(uri);
    if (!domains.includes(u.host.toLowerCase())) throw new Error();
    uri = u.origin;
  } catch {
    throw badRequest("URI not allowed for sign-in");
  }
  return { domain, uri };
}

export type NonceResponse = {
  nonce: string;
  chainId: number;
  statement: string;
  /** Nonce expiry (ISO); the message's expiration time. */
  expiresAt: string;
  issuedAt: string;
  domain: string;
  uri: string;
  /** A ready SIWE message for this address (clients may also build their own from the fields above). */
  message: string;
};

/** Creates a single-use nonce for `wallet` and the SIWE message a wallet can sign as is. */
export async function createNonce(
  wallet: string,
  purpose: NoncePurpose = "login",
  statement: string = LOGIN_STATEMENT,
  origin: SiweOrigin = {},
): Promise<NonceResponse> {
  const address = parseWalletAddress(wallet);
  const { domain, uri } = resolveOrigin(origin);
  await db.delete(schema.authNonces).where(lt(schema.authNonces.expiresAt, new Date()));
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  await db.insert(schema.authNonces).values({ nonce, wallet: address, purpose, expiresAt });
  const message = createSiweMessage({
    address: checksumAddress(address), // EIP-4361 requires the EIP-55 form
    chainId: env.CHAIN_ID,
    domain,
    uri,
    nonce,
    statement,
    version: "1",
    issuedAt,
    expirationTime: expiresAt,
  });
  return { nonce, chainId: env.CHAIN_ID, statement, expiresAt: expiresAt.toISOString(), issuedAt: issuedAt.toISOString(), domain, uri, message };
}

/** True when `signature` is a 65-byte secp256k1 signature of `message` (EIP-191) by `address`. */
export async function isEoaSignature(address: string, message: string, signature: string): Promise<boolean> {
  if (!isHex(signature) || signature.length !== 132) return false;
  try {
    const signer = await recoverMessageAddress({ message, signature: signature as Hex });
    return signer.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verifies an EIP-191 signature of `message` by `address`: secp256k1 recovery for EOAs (Privy embedded wallets, injected
 * wallets, agent keys), else, when `allowContract`, ERC-1271/ERC-6492 through the chain. Sign-in does not pass
 * `allowContract` (X30); memories never accept contract signatures (D8 needs a deterministic signature).
 */
export async function verifyWalletSignature(address: string, message: string, signature: string, o: { allowContract?: boolean } = {}): Promise<boolean> {
  if (await isEoaSignature(address, message, signature)) return true;
  if (!o.allowContract || !isHex(signature)) return false;
  let pc: ReturnType<typeof chainContext>["publicClient"];
  try {
    pc = chainContext().publicClient;
  } catch {
    return false; // no chain context (offline tools/tests): contract signatures cannot be checked
  }
  try {
    return await pc.verifyMessage({ address: address as Address, message, signature: signature as Hex });
  } catch {
    return false;
  }
}

/**
 * Checks a signed SIWE message and consumes its nonce (single use). Returns the authenticated address (lowercase).
 * The nonce is consumed only after the signature verifies, so a bad signature never burns a legitimate nonce.
 */
export async function verifySiwe(
  input: { message: string; signature: string; address?: string | undefined },
  purpose: NoncePurpose = "login",
): Promise<Address> {
  const { message, signature } = input;
  if (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) throw unauthorized("Invalid sign-in message");
  const parsed = parseSiweMessage(message);
  const problem = siweProblem(parsed, { domains: allowedDomains(), chainId: env.CHAIN_ID, now: new Date(), expectedAddress: input.address });
  if (problem) throw unauthorized(problem);
  const address = normalizeAddress(parsed.address!);
  // Plain secp256k1 signatures only (X30): contract-signature verification is not used for sign-in until Tempo's
  // keychain/access-key signatures are proven unable to impersonate the root account through it.
  if (typeof signature !== "string" || !(await verifyWalletSignature(address, message, signature))) {
    throw unauthorized("Invalid signature");
  }
  const consumed = await db
    .delete(schema.authNonces)
    .where(
      and(
        eq(schema.authNonces.nonce, parsed.nonce!),
        eq(schema.authNonces.wallet, address),
        eq(schema.authNonces.purpose, purpose),
        gt(schema.authNonces.expiresAt, new Date()),
      ),
    )
    .returning();
  if (consumed.length === 0) throw unauthorized("Invalid or already used nonce");
  return address;
}

/** Nonce of a SIWE message (used to bind a consent request to the nonce it issued). */
export function siweNonceOf(message: string): string | undefined {
  return parseSiweMessage(message).nonce;
}
