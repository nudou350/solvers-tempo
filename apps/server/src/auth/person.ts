import { createHash } from "node:crypto";

// "Person" identity for the free trial: several wallets of the same e-mail count as one.
// Pure functions (no env/database), tested in test/person.test.ts. The link wallet → person comes from a verified Privy
// identity token (auth/privy.ts, POST /api/auth/privy/link → table wallet_persons).

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * Canonical e-mail, or null when it does not look like an e-mail. Drops the "+tag" of the local part on any domain and,
 * on Gmail, also the dots (a.b@gmail.com and ab+x@googlemail.com are the same mailbox).
 */
export function normalizeEmail(raw: string): string | null {
  const s = raw.normalize("NFKC").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  const domain = s.slice(at + 1).replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  const host = GMAIL.has(domain) ? "gmail.com" : domain;
  let local = s.slice(0, at);
  if (/[\s@]/.test(local)) return null;
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (host === "gmail.com") local = local.replaceAll(".", "");
  if (!local) return null;
  return `${local}@${host}`;
}

/** Stable key of the person (the e-mail itself is never stored). Null: invalid e-mail. */
export function personKey(email: string): string | null {
  const normalized = normalizeEmail(email);
  return normalized ? createHash("sha256").update(`solvers-person:v1:${normalized}`).digest("hex") : null;
}
