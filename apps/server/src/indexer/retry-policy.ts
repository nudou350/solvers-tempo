// Retry policy of the indexer (pure functions: no database, no RPC).

/** The transaction is not visible yet (or another transient condition): retry without spending attempts. */
export class IndexerRetryableError extends Error {
  override name = "IndexerRetryableError";
}

/** Failures that count (not infrastructure) before a transaction is given up as "dead". */
export const MAX_ATTEMPTS = 12;
/** An infrastructure failure lasting longer than this also becomes "dead" (the transaction may never show up). */
export const MAX_INFRA_AGE_DAYS = 7;
/** Fixed wait after an infrastructure failure. */
export const INFRA_RETRY_SECS = 60;
const BASE_SECS = 30;
const CAP_SECS = 6 * 3600;

/** Exponential backoff: 30 s, 1 min, 2 min, ... up to 6 h. `attempts` is how many failures already counted. */
export function backoffSecs(attempts: number): number {
  return Math.min(CAP_SECS, BASE_SECS * 2 ** Math.max(0, attempts - 1));
}

const INFRA_PATTERN =
  /fetch failed|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|timed out|timeout|took too long|network|http request failed|\b(429|502|503|504)\b|too many requests|gateway|unhealthy|not visible|rate limit/i;

/** viem error classes that mean "the RPC did not answer", never "the transaction is wrong". */
const INFRA_NAMES = new Set([
  "HttpRequestError",
  "TimeoutError",
  "WebSocketRequestError",
  "SocketClosedError",
  "LimitExceededRpcError",
  "ResourceUnavailableRpcError",
  "InternalRpcError",
  "TransactionReceiptNotFoundError",
  "BlockNotFoundError",
]);

/**
 * Infrastructure failure (RPC down, rate limit, transaction not visible yet): it says nothing about the transaction
 * itself, so it spends no attempts. Walks the `cause` chain (viem wraps transport errors).
 */
export function isInfraError(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 6; depth++) {
    if (cur instanceof IndexerRetryableError) return true;
    const err = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; code?: unknown; cause?: unknown };
    if (typeof err.name === "string" && INFRA_NAMES.has(err.name)) return true;
    for (const p of [err.shortMessage, err.code]) if (p != null) parts.push(String(p));
    // Only the first line of a message: viem appends the request body, which may contain any text.
    if (typeof err.message === "string") parts.push(err.message.split("\n")[0] ?? "");
    cur = err.cause;
  }
  return INFRA_PATTERN.test(parts.join(" "));
}

const LOG_RANGE_PATTERN =
  /block range|range (is )?too (large|wide|big)|too many (results|logs|blocks)|more than \d+ (results|logs)|exceeds? (the )?(max|maximum|limit)|max(imum)? (block )?range|result (set )?(is )?too large|response size|query returned more than|limit exceeded|-32005|-32602.*range/i;

/**
 * `eth_getLogs` refused the size of the request (range or result-count limit of the RPC): retrying the same range can
 * never succeed, the caller must split it. Walks the `cause` chain like `isInfraError`.
 */
export function isLogRangeError(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 6; depth++) {
    const err = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; code?: unknown; cause?: unknown };
    if (err.name === "LimitExceededRpcError") return true;
    for (const p of [err.shortMessage, err.details, err.code]) if (p != null) parts.push(String(p));
    if (typeof err.message === "string") parts.push(err.message.split("\n")[0] ?? "");
    cur = err.cause;
  }
  return LOG_RANGE_PATTERN.test(parts.join(" "));
}

/**
 * Fetches the logs of [from, to]; when the RPC refuses the size of the request, halves the range and fetches both
 * halves (recursively, down to one block). Any other error, or a single block that is still too large, is thrown.
 */
export async function getLogsSplitting<T>(fetch: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  try {
    return await fetch(from, to);
  } catch (e) {
    if (to <= from || !isLogRangeError(e)) throw e;
    const mid = from + (to - from) / 2n;
    const left = await getLogsSplitting(fetch, from, mid);
    const right = await getLogsSplitting(fetch, mid + 1n, to);
    return [...left, ...right];
  }
}
