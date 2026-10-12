// Raw HTTP helper for the API under test: JSON in/out, Bearer token, and a wait-and-retry on the per-IP rate limit of
// the costly routes (/api/tx, /api/purchases, /api/pix, /api/faucet, /api/search: 20 requests/minute).
import { API_URL, sleep } from "../env.js";

/** A non-2xx answer: status, the API's error `code` and the whole body. */
export class ApiFailure extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body).slice(0, 600)}`);
  }
  get code(): string | undefined {
    return typeof this.body.code === "string" ? this.body.code : typeof this.body.error === "string" ? this.body.error : undefined;
  }
}

export type RequestOpts = { token?: string; headers?: Record<string, string>; body?: unknown; raw?: BodyInit; base?: string };

/** Seconds to wait from a draft-8 `RateLimit` header (`...;t=NN`), else 15. */
export function retryAfterSecs(headers: Headers): number {
  const ra = Number(headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra, 65);
  const m = /t=(\d+)/.exec(headers.get("ratelimit") ?? "");
  return m ? Math.min(Number(m[1]) + 1, 65) : 15;
}

export async function request<T = any>(method: string, path: string, o: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) };
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(o.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  let res!: Response;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(`${o.base ?? API_URL}${path}`, { method, headers, body });
    if (res.status !== 429) break;
    const wait = retryAfterSecs(res.headers);
    const text = await res.text().catch(() => "");
    // Only the generic rate limiter is retried; business 429s (faucet cooldown, pending limits) are real answers.
    if (!/rate_limited|too_many_requests|Too many requests/i.test(text)) {
      throw new ApiFailure(method, path, 429, safeJson(text));
    }
    console.log(`        (rate limited on ${path}; waiting ${wait}s)`);
    await sleep(wait * 1000);
  }
  const text = await res.text();
  const json = safeJson(text);
  if (!res.ok) throw new ApiFailure(method, path, res.status, json);
  return json as T;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { text: text.slice(0, 500) };
  }
}

export const get = <T = any>(path: string, token?: string) => request<T>("GET", path, { token });
export const post = <T = any>(path: string, token?: string, body?: unknown) => request<T>("POST", path, { token, body: body ?? {} });
export const del = <T = any>(path: string, token?: string) => request<T>("DELETE", path, { token });
export const patch = <T = any>(path: string, token?: string, body?: unknown) => request<T>("PATCH", path, { token, body });

/** Expects the call to fail with `status` (and `code` when given); returns the failure. */
export async function expectFailure(p: Promise<unknown>, status: number, code?: string): Promise<ApiFailure> {
  let out: unknown;
  try {
    out = await p;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (e.status !== status || (code && e.code !== code)) {
      throw new Error(`expected ${status}${code ? ` ${code}` : ""}, got ${e.status} ${e.code ?? ""}: ${JSON.stringify(e.body).slice(0, 300)}`);
    }
    return e;
  }
  throw new Error(`expected ${status}${code ? ` ${code}` : ""}, got success: ${JSON.stringify(out).slice(0, 300)}`);
}
