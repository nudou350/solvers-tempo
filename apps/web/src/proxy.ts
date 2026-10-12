import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { contentSecurityPolicy, makeNonce } from "./lib/csp";

const i18n = createMiddleware(routing);

/**
 * Locale routing (next-intl) plus a nonce-based Content-Security-Policy (lib/csp.ts). The nonce goes on the REQUEST
 * (`x-nonce` and the CSP header, which next-intl forwards upstream with its own header) so Next.js renders it on every
 * script, and the policy goes on the response. Pages are rendered per request (the root layout reads `x-nonce`).
 */
export default function proxy(request: NextRequest) {
  // Only page loads carry the policy; requests with a body are passed through untouched (cloning them would need the
  // body stream).
  if (request.method !== "GET" && request.method !== "HEAD") return i18n(request);
  const nonce = makeNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = i18n(new NextRequest(request, { headers }));
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Outside: server routes (API, MCP, OAuth, .well-known), Next's files and paths with an extension (favicon, images).
  matcher: ["/((?!api|mcp|oauth|preview|health|\\.well-known|_next|_vercel|.*\\..*).*)"],
};
