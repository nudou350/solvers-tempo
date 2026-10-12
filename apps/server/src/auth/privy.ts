import { importSPKI, jwtVerify, type CryptoKey, type JWTPayload, type KeyObject } from "jose";
import { eq, sql } from "drizzle-orm";

import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError, unauthorized } from "../lib/http.js";
import { personKey } from "./person.js";

// Privy tokens verified with `jose` (decisions.md D7, plan T11), without Privy's server SDK (its packages pull the previous
// chain's SDK as peers). Sources, read 2026-10-11:
// - https://docs.privy.io/authentication/user-authentication/access-tokens : ES256; verification key copied from the
//   dashboard (Configuration > App settings) as an SPKI PEM (`jose.importSPKI(key, "ES256")`); `iss` = "privy.io",
//   `aud` = the Privy app id; claims `sub` (user DID), `sid`, `iat`, `exp` (~1 h).
// - https://docs.privy.io/user-management/users/identity-tokens : same signature, issuer and audience; claim
//   `linked_accounts` is a STRINGIFIED JSON array (JSON.parse it); sent as the `privy-id-token` cookie or header; it must
//   be enabled in the dashboard ("Return user data in an identity token").
// - https://docs.privy.io/api-reference/users/get : linked account entries: email `{ type: "email", address }`, Ethereum
//   wallet `{ type: "wallet", address, chain_type: "ethereum", wallet_client_type, connector_type }`. The identity token
//   carries a "lightweight version" of these entries; its exact field set is not documented, so only `type`, `address`
//   and `chain_type` are read here.
// Disabled (route answers 404) unless PRIVY_APP_ID and PRIVY_VERIFICATION_KEY are set.

export const PRIVY_ISSUER = "privy.io";

export function privyConfigured(): boolean {
  return !!env.PRIVY_APP_ID && !!env.PRIVY_VERIFICATION_KEY;
}

/** Accepts the PEM as copied from the dashboard, with real or escaped (`\n`) newlines, or the bare base64 body. */
export function pemFromEnv(raw: string): string {
  const s = raw.replace(/\\n/g, "\n").trim();
  if (s.includes("BEGIN PUBLIC KEY")) return s;
  const body = s.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

let cachedKey: { raw: string; key: CryptoKey | KeyObject } | null = null;

async function verificationKey(raw: string): Promise<CryptoKey | KeyObject> {
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = await importSPKI(pemFromEnv(raw), "ES256");
  cachedKey = { raw, key };
  return key;
}

export type PrivyConfig = { appId: string; verificationKey: string };

function configFromEnv(): PrivyConfig {
  if (!env.PRIVY_APP_ID || !env.PRIVY_VERIFICATION_KEY) throw new HttpError(404, "Privy linking is not enabled", "not_found");
  return { appId: env.PRIVY_APP_ID, verificationKey: env.PRIVY_VERIFICATION_KEY };
}

async function verifyPrivyJwt(token: string, cfg: PrivyConfig): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, await verificationKey(cfg.verificationKey), {
      issuer: PRIVY_ISSUER,
      audience: cfg.appId,
      algorithms: ["ES256"],
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no sub");
    return payload;
  } catch {
    throw unauthorized("Invalid or expired Privy token");
  }
}

/** Access token (`Authorization: Bearer` / `privy-token` cookie on the Privy side): the user's DID and session id. */
export async function verifyPrivyAccessToken(token: string, cfg: PrivyConfig = configFromEnv()): Promise<{ userId: string; sessionId: string | null }> {
  const p = await verifyPrivyJwt(token, cfg);
  return { userId: p.sub!, sessionId: typeof p.sid === "string" ? p.sid : null };
}

export type PrivyLinkedAccount = { type?: unknown; address?: unknown; chain_type?: unknown };
export type PrivyIdentity = { userId: string; linkedAccounts: PrivyLinkedAccount[] };

/** Identity token (`privy-id-token`): the user's DID and linked accounts (email, wallets). */
export async function verifyPrivyIdentityToken(token: string, cfg: PrivyConfig = configFromEnv()): Promise<PrivyIdentity> {
  const p = await verifyPrivyJwt(token, cfg);
  return { userId: p.sub!, linkedAccounts: parseLinkedAccounts(p.linked_accounts) };
}

/** `linked_accounts` is a stringified JSON array per the docs; an array is accepted too. Garbage → []. */
export function parseLinkedAccounts(raw: unknown): PrivyLinkedAccount[] {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((a): a is PrivyLinkedAccount => typeof a === "object" && a !== null) : [];
}

/**
 * The e-mail of a Privy user whose linked accounts include `wallet` (an Ethereum wallet, compared case-insensitively).
 * Null when the wallet is not linked to that user or the user has no e-mail.
 */
export function emailLinkedToWallet(accounts: readonly PrivyLinkedAccount[], wallet: string): string | null {
  const w = wallet.toLowerCase();
  const hasWallet = accounts.some(
    (a) => a.type === "wallet" && (a.chain_type === undefined || a.chain_type === "ethereum") && typeof a.address === "string" && a.address.toLowerCase() === w,
  );
  if (!hasWallet) return null;
  const email = accounts.find((a) => a.type === "email" && typeof a.address === "string");
  return email ? (email.address as string) : null;
}

/**
 * Links the session wallet to the person behind a Privy identity token (free trial counted per person: person.ts).
 * Stores only the person key (a hash of the normalized e-mail) and the Privy DID, never the e-mail itself.
 */
export async function linkPrivyIdentity(wallet: string, identityToken: string): Promise<{ linked: boolean }> {
  const id = await verifyPrivyIdentityToken(identityToken);
  const email = emailLinkedToWallet(id.linkedAccounts, wallet);
  if (!email) throw new HttpError(403, "This wallet is not linked to that Privy account", "privy_wallet_mismatch");
  const key = personKey(email);
  if (!key) throw new HttpError(400, "The Privy account has no valid e-mail", "privy_no_email");
  const w = wallet.toLowerCase();
  await db
    .insert(schema.walletPersons)
    .values({ wallet: w, personKey: key, privyUserId: id.userId })
    .onConflictDoUpdate({ target: schema.walletPersons.wallet, set: { personKey: key, privyUserId: id.userId, linkedAt: sql`now()` } });
  return { linked: true };
}

/** Person key linked to a wallet (null = never linked through Privy). */
export async function personKeyForWallet(wallet: string): Promise<string | null> {
  const rows = await db.select().from(schema.walletPersons).where(eq(schema.walletPersons.wallet, wallet.toLowerCase()));
  return rows[0]?.personKey ?? null;
}
