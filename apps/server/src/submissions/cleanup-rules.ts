// Pure rules for the submissions cleanup (job in jobs.ts, I/O in cleanup.ts). No database or disk: tested in
// test/submission-cleanup.test.ts. The deadlines come from PACKAGE_SPEC.md 16 (cleanup) and from the review findings.

const DAY_MS = 86_400_000;

/** Rejected (validation or reviewer): the ZIP and the extracted folder are removed after this period. */
export const REJECTED_FILES_TTL_DAYS = 30;
/** Requested changes or a signature the creator never made: after this period the submission expires and the slug is released. */
export const STALE_OPEN_TTL_DAYS = 30;
/** Leftovers of an interrupted upload (`.part`) and folders with no database row: one day. */
export const ORPHAN_TTL_DAYS = 1;

const REJECTED_STATUSES = ["rejected_validation", "rejected"] as const;
/** States that depend on the creator and could sit idle forever, holding the slug. */
export const EXPIRABLE_STATUSES = ["changes_requested", "awaiting_creator_signature"] as const;

const olderThan = (at: Date | number, now: Date | number, days: number): boolean => new Date(now).getTime() - new Date(at).getTime() > days * DAY_MS;

/** Can this submission's ZIP and extracted folder be deleted yet? */
export function filesExpired(status: string, updatedAt: Date, now: Date = new Date()): boolean {
  return (REJECTED_STATUSES as readonly string[]).includes(status) && olderThan(updatedAt, now, REJECTED_FILES_TTL_DAYS);
}

/** Should this idle submission expire (it becomes `rejected` with an "expired" note, releasing the slug)? */
export function staleOpen(status: string, updatedAt: Date, now: Date = new Date()): boolean {
  return (EXPIRABLE_STATUSES as readonly string[]).includes(status) && olderThan(updatedAt, now, STALE_OPEN_TTL_DAYS);
}

/** Incomplete upload file (`package.zip.<id>.part` or `package.zip.part`) older than one day. */
export function partFileStale(name: string, mtimeMs: number, now: Date = new Date()): boolean {
  return name.endsWith(".part") && olderThan(mtimeMs, now, ORPHAN_TTL_DAYS);
}

/**
 * Submission folder with no database row and older than one day. The upload creates the folder BEFORE inserting the row,
 * so the one-day margin avoids deleting an upload in progress.
 */
export function orphanFolderStale(hasRow: boolean, mtimeMs: number, now: Date = new Date()): boolean {
  return !hasRow && olderThan(mtimeMs, now, ORPHAN_TTL_DAYS);
}

/** Note written to `reviewer_notes` and `package_reviews` when the system expires an idle submission. */
export const EXPIRED_NOTE = "Submission expired: it sat idle for more than 30 days, waiting for the creator. The slug has been released; submit the package again if you still want to publish.";
/** Wallet that signs the system's actions in `package_reviews`. */
export const SYSTEM_REVIEWER = "system";
