import { isAddress } from "@solvers/shared";
import type { parseSiweMessage } from "viem/siwe";

// Pure rules of Sign-In with Ethereum (EIP-4361, decisions.md D7). No env or database: tested in test/siwe.test.ts.
// The stateful part (nonce store, signature verification, JWT) lives in siwe.ts.

/** Lifetime of a nonce (and therefore of the message built from it). */
export const NONCE_TTL_MS = 5 * 60 * 1000;
/** Clock skew tolerated on `Issued At` / `Not Before`. */
export const CLOCK_SKEW_MS = 60_000;
/** Longest SIWE message accepted (bytes of text). */
export const MAX_MESSAGE_LENGTH = 2000;

export type NoncePurpose = "login" | "oauth" | "agent";

export const LOGIN_STATEMENT = "Sign in to Solvers. This does not authorize any payments and costs nothing.";

export type ParsedSiwe = ReturnType<typeof parseSiweMessage>;

/** Hosts accepted as the SIWE `domain` (and as the host of its `uri`): SIWE_DOMAINS, else the web and API hosts. */
export function siweDomains(siweDomainsEnv: string | undefined, publicWebUrl: string, publicApiUrl: string): string[] {
  const hosts = new Set<string>();
  if (siweDomainsEnv) {
    for (const d of siweDomainsEnv.split(",")) if (d.trim()) hosts.add(d.trim().toLowerCase());
  } else {
    hosts.add(new URL(publicWebUrl).host.toLowerCase());
    hosts.add(new URL(publicApiUrl).host.toLowerCase());
  }
  return [...hosts];
}

/**
 * Why the parsed message cannot open a session (null = acceptable). Checks every field the server relies on: address,
 * domain and uri host in the allowed set, version 1, chain id, a nonce, issued-at inside the nonce lifetime, and the
 * optional expiration / not-before against `now`. The signature and the nonce store are checked by the caller.
 */
export function siweProblem(
  m: ParsedSiwe,
  o: { domains: readonly string[]; chainId: number; now: Date; expectedAddress?: string | undefined },
): string | null {
  const now = o.now.getTime();
  if (!m.address || !isAddress(m.address)) return "Message has no valid address";
  if (o.expectedAddress && m.address.toLowerCase() !== o.expectedAddress.toLowerCase()) return "Message address does not match";
  if (!m.domain || !o.domains.includes(m.domain.toLowerCase())) return "Message domain does not match";
  if (!m.uri) return "Message has no URI";
  let uriHost: string;
  try {
    uriHost = new URL(m.uri).host.toLowerCase();
  } catch {
    return "Message URI is invalid";
  }
  if (!o.domains.includes(uriHost)) return "Message URI does not match";
  if (m.version !== "1") return "Unsupported message version";
  if (m.chainId !== o.chainId) return "Message network does not match";
  if (!m.nonce) return "Message has no nonce";
  if (!m.issuedAt || Number.isNaN(m.issuedAt.getTime())) return "Message has no issue date";
  const issued = m.issuedAt.getTime();
  if (issued - now > CLOCK_SKEW_MS || now - issued > NONCE_TTL_MS + CLOCK_SKEW_MS) return "Message is outside its validity window";
  if (m.expirationTime) {
    if (Number.isNaN(m.expirationTime.getTime()) || m.expirationTime.getTime() <= now) return "Message expired";
  }
  if (m.notBefore) {
    if (Number.isNaN(m.notBefore.getTime()) || m.notBefore.getTime() - now > CLOCK_SKEW_MS) return "Message is not valid yet";
  }
  return null;
}
