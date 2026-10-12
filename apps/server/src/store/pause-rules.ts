import { PAUSE_FLAGS, isPaused, type PauseFlag } from "@solvers/shared";
import { HttpError } from "../lib/http.js";

/**
 * Emergency pause (`SolversRegistry.pauseFlags`: ENTRIES=1, PAYMENTS=2, TRANSFERS=4). The contracts are the real barrier
 * (the call reverts with `Paused` / `TransfersPaused`); the server only avoids building calls that would revert and
 * answers early with a clear message.
 *
 * Pure decision (`assertNotPaused`) + short cache (`createCachedReader`):
 * - bit set: 503 with the message of that bit;
 * - fail-open: unreadable flags (RPC down) do NOT block; the contract stays the barrier and the simulation
 *   (`simulation-gate.ts`) still turns a `Paused` revert into a friendly 409.
 */
export const PAUSED_MESSAGE = "Purchases are temporarily paused";

const PAUSE_TEXT: Record<PauseFlag, { message: string; code: string }> = {
  [PAUSE_FLAGS.ENTRIES]: { message: PAUSED_MESSAGE, code: "platform_paused" },
  [PAUSE_FLAGS.PAYMENTS]: { message: "Guarantee payouts are temporarily paused", code: "payments_paused" },
  [PAUSE_FLAGS.TRANSFERS]: { message: "License transfers are temporarily paused", code: "transfers_paused" },
};

/** "paused" when the bit is set, "open" when not, "unknown" when the flags could not be read. */
export function pauseDecision(pauseFlags: number | null, bit: PauseFlag): "paused" | "open" | "unknown" {
  if (pauseFlags === null || !Number.isInteger(pauseFlags)) return "unknown";
  return isPaused(pauseFlags, bit) ? "paused" : "open";
}

export function assertNotPaused(pauseFlags: number | null, bit: PauseFlag, label: string, log: (msg: string) => void = console.warn): void {
  const decision = pauseDecision(pauseFlags, bit);
  if (decision === "paused") {
    const t = PAUSE_TEXT[bit];
    throw new HttpError(503, t.message, t.code);
  }
  if (decision === "unknown") log(`[pause] ${label}: pause state unavailable (read failed), continuing without blocking`);
}

export type CachedReader<T> = {
  read(): Promise<T | null>;
  /** Drops the cache (e.g. the indexer saw `PauseChanged` / `ConfigUpdated`). */
  invalidate(): void;
};

/**
 * Short cache of an on-chain read: at most one read per `ttlMs` (concurrent requests share it), and a failed read is
 * remembered only for `failTtlMs` (returns null, which callers treat as fail-open).
 */
export function createCachedReader<T>(opts: {
  fetch: () => Promise<T>;
  label?: string;
  ttlMs?: number;
  failTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): CachedReader<T> {
  const { fetch, label = "read", ttlMs = 10_000, failTtlMs = 2_000, now = Date.now, log = console.warn } = opts;
  let cached: { at: number; ttl: number; value: T | null } | null = null;
  let inflight: Promise<T | null> | null = null;
  let generation = 0;
  return {
    read() {
      if (cached && now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      const gen = generation;
      const p: Promise<T | null> = Promise.resolve()
        .then(fetch)
        .then(
          (value): { value: T | null; ttl: number } => ({ value, ttl: ttlMs }),
          (e: unknown) => {
            log(`[chain] ${label} failed: ${(e as Error)?.message ?? String(e)}`);
            return { value: null, ttl: failTtlMs };
          },
        )
        .then(({ value, ttl }) => {
          if (gen === generation) cached = { at: now(), ttl, value };
          if (inflight === p) inflight = null;
          return value;
        });
      inflight = p;
      return p;
    },
    invalidate() {
      generation++;
      cached = null;
      inflight = null;
    },
  };
}
