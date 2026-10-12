// Governance events (D9): config, pause, satellites, roles, admin transfer and upgrades. Nothing is mirrored (the
// contracts are the source of truth); the indexer notifies subscribers (cache invalidation, e.g. the store's pause and
// config caches) and alerts the admins on Telegram.

import { keccak256, toBytes } from "viem";

export const GOVERNANCE_EVENTS: ReadonlySet<string> = new Set([
  "PauseChanged",
  "ConfigUpdated",
  "SatellitesSet",
  "RoleGranted",
  "RoleRevoked",
  "RoleAdminChanged",
  "DefaultAdminTransferScheduled",
  "DefaultAdminTransferCanceled",
  "DefaultAdminDelayChangeScheduled",
  "DefaultAdminDelayChangeCanceled",
  "Upgraded",
  "BaseURISet",
  "StraySwept",
]);

export type GovernanceChange = {
  name: string;
  /** Which of the six contracts emitted it (registry, license, ...). */
  contract: string;
  args: Readonly<Record<string, unknown>>;
  txHash: string;
  blockNumber: bigint;
};

type Listener = (c: GovernanceChange) => void | Promise<void>;
const listeners = new Set<Listener>();

/** Subscribe to governance changes (called once per newly indexed event, after it is committed). Returns an unsubscribe. */
export function onGovernanceChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notifies every subscriber; a failing subscriber never affects the indexer or the others. */
export function emitGovernanceChange(c: GovernanceChange): void {
  for (const fn of listeners) {
    try {
      Promise.resolve(fn(c)).catch((e) => console.error("[indexer] governance listener:", (e as Error).message));
    } catch (e) {
      console.error("[indexer] governance listener:", (e as Error).message);
    }
  }
}

const ROLE_NAMES: Record<string, string> = Object.fromEntries([
  [`0x${"0".repeat(64)}`, "DEFAULT_ADMIN"],
  ...["PLATFORM_ROLE", "VERIFIER_ROLE", "USAGE_ROLE", "GUARDIAN_ROLE"].map((r) => [keccak256(toBytes(r)), r]),
]);

export function roleName(role: unknown): string {
  const r = String(role).toLowerCase();
  return ROLE_NAMES[r] ?? r;
}

const PAUSE_BITS: [number, string][] = [
  [1, "ENTRIES"],
  [2, "PAYMENTS"],
  [4, "TRANSFERS"],
];

export function describePauseFlags(flags: unknown): string {
  const n = Number(flags);
  const on = PAUSE_BITS.filter(([bit]) => (n & bit) === bit).map(([, name]) => name);
  return on.length ? on.join("+") : "none";
}

const fmt = (v: unknown): string => (typeof v === "bigint" ? v.toString() : String(v));

/** One-line admin alert for a governance change (pure). */
export function governanceAlertText(c: GovernanceChange): string {
  const a = c.args ?? {};
  let what: string;
  switch (c.name) {
    case "PauseChanged":
      what = `pause changed by ${fmt(a.by)}: ${describePauseFlags(a.oldFlags)} -> ${describePauseFlags(a.newFlags)}`;
      break;
    case "ConfigUpdated":
      what = `config updated: treasury ${fmt(a.treasury)}, fee ${fmt(a.feeBps)} bps, platform royalty ${fmt(a.platformRoyaltyBps)} bps, min stake ${fmt(a.minStake)}, min price ${fmt(a.minPrice)}`;
      break;
    case "RoleGranted":
    case "RoleRevoked":
      what = `${c.name === "RoleGranted" ? "role granted" : "role revoked"}: ${roleName(a.role)} ${c.name === "RoleGranted" ? "to" : "from"} ${fmt(a.account)} by ${fmt(a.sender)}`;
      break;
    case "DefaultAdminTransferScheduled":
      what = `admin transfer scheduled to ${fmt(a.newAdmin)} (accept after ${fmt(a.acceptSchedule)})`;
      break;
    case "Upgraded":
      what = `${c.contract} upgraded to implementation ${fmt(a.implementation)}`;
      break;
    default:
      what = `${c.name} ${Object.entries(a)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(" ")}`.trim();
  }
  return `Solvers governance (${c.contract}): ${what} (tx ${c.txHash})`;
}

/** Events older than this only reach the log, not Telegram (a backfill or reindex must not replay old alerts). */
export const ALERT_MAX_AGE_MS = 60 * 60 * 1000;

/** True when the event is recent enough to notify people (unknown time counts as recent). */
export function isFreshForAlert(at: Date | null | undefined, now = Date.now()): boolean {
  return !at || now - at.getTime() <= ALERT_MAX_AGE_MS;
}
