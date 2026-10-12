import { createApi, type SolversApi } from "@solvers/api-client";

// API base for the browser. Default: same origin with relative paths (/api/...): in dev, next.config rewrites them to
// the local API (API_DEV_URL, port 3018); in production nginx serves /api, /mcp, /oauth and /.well-known on the same
// domain. NEXT_PUBLIC_API_URL points the browser at another origin (the session cookie then needs CORS credentials).
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** Absolute URL of the platform relay (JSON-RPC, `POST /api/relay`), resolved against the page origin. */
export function relayUrl(): string {
  const path = `${API_BASE}/api/relay`;
  if (/^https?:\/\//.test(path)) return path;
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin).toString();
}

const unauthorized = new Set<() => void>();

/**
 * Notifies when a call gets a 401 in the middle of a session (cookie expired or deleted). /api/auth/ routes are left
 * out: the session itself uses them to find out whether it is signed in.
 */
export function onUnauthorized(fn: () => void): () => void {
  unauthorized.add(fn);
  return () => {
    unauthorized.delete(fn);
  };
}

const watchedFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status === 401) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/auth/")) unauthorized.forEach((fn) => fn());
  }
  return res;
};

export const api: SolversApi = createApi({ baseUrl: API_BASE, fetch: watchedFetch });

/**
 * For server components (public catalog): the server-side fetch needs an absolute URL.
 * API_INTERNAL_URL (production: http://127.0.0.1:3018); default: the local API.
 */
export function serverApi(): SolversApi {
  return createApi({ baseUrl: process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3018" });
}

export { ApiError } from "@solvers/api-client";
export type { SolversApi } from "@solvers/api-client";
