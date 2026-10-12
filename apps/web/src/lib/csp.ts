// Content-Security-Policy of the web pages, sent by src/proxy.ts with a fresh nonce per request (Next.js CSP guide:
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md). Next.js reads the nonce from the request's
// CSP header and puts it on its own scripts; the root layout puts it on the theme script.
//
// Why: the wallet signs without a confirmation dialog (Privy `showWalletUIs: false`, raw-hash signing), so any script
// running on this origin could sign. Only scripts carrying this request's nonce run, plus what they load
// ('strict-dynamic': Next's chunks, the Privy SDK and the Cloudflare Turnstile script Privy injects for its captcha).
// Styles, images, frames and connections are not restricted here (inline styles are used throughout; Privy's iframe
// and RPC origins are left to its defaults). No React, no Next import (unit-tested).

/** Turnstile (Privy's optional captcha), listed by Privy's CSP guide; kept for browsers without 'strict-dynamic'. */
const PRIVY_SCRIPT_HOSTS = ["https://challenges.cloudflare.com"];

/** A fresh nonce (128 random bits, base64). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for a page response. `dev`: React and Next need `eval` in development only (debug stacks, fast refresh).
 */
export function contentSecurityPolicy(nonce: string, o: { dev: boolean }): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error("invalid CSP nonce");
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...PRIVY_SCRIPT_HOSTS, ...(o.dev ? ["'unsafe-eval'"] : [])];
  return [
    `script-src ${script.join(" ")}`,
    // Inline event-handler attributes never run (React attaches handlers in JS).
    "script-src-attr 'none'",
    // Workers are not covered by the nonce: only same-origin or blob workers.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // No page of the app is meant to be framed (clickjacking of the consent, review and creator screens).
    "frame-ancestors 'none'",
  ].join("; ");
}
