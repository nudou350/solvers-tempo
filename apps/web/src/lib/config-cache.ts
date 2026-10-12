// Module cache of the public config (`GET /api/config`), without React: shared by lib/config.ts (hooks), lib/tx.ts and
// lib/explorer.ts. One request per page load; a failed load is retried on the next call.
import type { PublicConfig } from "@solvers/api-client";
import { api } from "./api";
import { clockOffsetSecs, serverClock } from "./wallet/send";

let cached: PublicConfig | null = null;
/** Server clock minus this device's clock, in seconds, measured when the config arrived (once per page load). */
let offsetSecs: number | null = null;
let inflight: Promise<PublicConfig> | null = null;

/** `/api/config`, cached in the module. */
export function loadPublicConfig(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached);
  inflight ??= api.getConfig().then(
    (c) => {
      offsetSecs = clockOffsetSecs(c.serverTime, Date.now());
      cached = c;
      inflight = null;
      return c;
    },
    (e: unknown) => {
      inflight = null;
      throw e;
    },
  );
  return inflight;
}

/** The config if it was already loaded, else null (never fetches). */
export function loadPublicConfigSync(): PublicConfig | null {
  return cached;
}

/**
 * Clock in unix seconds that follows the server's (this device's clock corrected by the offset measured with
 * `/api/config`). Used for `validBefore`, which the relay checks against its own clock. Loads the config when needed.
 */
export async function loadServerClock(): Promise<() => number> {
  if (offsetSecs === null) await loadPublicConfig();
  return serverClock(offsetSecs ?? 0);
}
