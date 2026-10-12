import { PAUSE_FLAGS } from "@solvers/shared";
import { invalidateConfigCache, registryConfig } from "./chain-reads.js";
import { assertNotPaused } from "./pause-rules.js";

// Emergency pause wired to the Registry (pure rules and cache in `pause-rules.ts`, testable without env or network).

/** The indexer saw `PauseChanged`: the next check re-reads the Registry. */
export function invalidatePauseCache(): void {
  invalidateConfigCache();
}

async function flags(): Promise<number | null> {
  return (await registryConfig())?.pauseFlags ?? null;
}

/** Call at the start of routes that build a purchase or a guarantee, before writing anything to the database. */
export async function assertEntriesOpen(label: string): Promise<void> {
  assertNotPaused(await flags(), PAUSE_FLAGS.ENTRIES, label);
}

/** Escrow payouts (release, dispute resolution). */
export async function assertPaymentsOpen(label: string): Promise<void> {
  assertNotPaused(await flags(), PAUSE_FLAGS.PAYMENTS, label);
}

/** Secondary license transfers (admin-only emergency bit). */
export async function assertTransfersOpen(label: string): Promise<void> {
  assertNotPaused(await flags(), PAUSE_FLAGS.TRANSFERS, label);
}
