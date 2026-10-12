// Numeric enums and bit flags mirrored from the contracts (plan §4.1-§4.5, §4.8). Values are the on-chain `uint8`s;
// the `*Name` helpers map them to the lowercase strings the API and the DB use.

/** `SolversRegistry` agent status. */
export const AGENT_STATUS = { Pending: 0, Active: 1, Suspended: 2, Retired: 3 } as const;
export type AgentStatusCode = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];
const AGENT_STATUS_NAMES = ["pending", "active", "suspended", "retired"] as const;
export type AgentStatusName = (typeof AGENT_STATUS_NAMES)[number];

/** `SolversEscrow` milestone status. */
export const MILESTONE_STATUS = { Pending: 0, Passed: 1, Approved: 2, Disputed: 3, Refunded: 4 } as const;
export type MilestoneStatusCode = (typeof MILESTONE_STATUS)[keyof typeof MILESTONE_STATUS];
const MILESTONE_STATUS_NAMES = ["pending", "passed", "approved", "disputed", "refunded"] as const;
export type MilestoneStatusName = (typeof MILESTONE_STATUS_NAMES)[number];

/** `SolversEscrow.statusOf` (derived on-chain, never stored). `Completed` and `Refunded` are terminal. */
export const ESCROW_STATUS = { Active: 0, Completed: 1, Disputed: 2, Refunded: 3 } as const;
export type EscrowStatusCode = (typeof ESCROW_STATUS)[keyof typeof ESCROW_STATUS];
/** API names (`schemas.ts` `EscrowStatus`): `Completed` is shown as "approved", as before the migration. */
const ESCROW_STATUS_NAMES = ["active", "approved", "disputed", "refunded"] as const;
export type EscrowStatusName = (typeof ESCROW_STATUS_NAMES)[number];

/** `SolversRegistry.pauseFlags` bits. ENTRIES: new purchases/registrations; PAYMENTS: escrow payouts; TRANSFERS: license transfers. */
export const PAUSE_FLAGS = { ENTRIES: 1, PAYMENTS: 2, TRANSFERS: 4 } as const;
export type PauseFlag = (typeof PAUSE_FLAGS)[keyof typeof PAUSE_FLAGS];
export const ALL_PAUSE_FLAGS = PAUSE_FLAGS.ENTRIES | PAUSE_FLAGS.PAYMENTS | PAUSE_FLAGS.TRANSFERS;

/** `kind` argument of `SolversRegistry.authorizeSale` and the high byte of `purchaseRef`. */
export const PURCHASE_KIND = { License: 1, Credits: 2, Escrow: 3 } as const;
export type PurchaseKindCode = (typeof PURCHASE_KIND)[keyof typeof PURCHASE_KIND];
const PURCHASE_KIND_NAMES = { 1: "license", 2: "credits", 3: "escrow" } as const;
export type PurchaseKindName = (typeof PURCHASE_KIND_NAMES)[PurchaseKindCode];

function nameAt<T extends string>(names: readonly T[], what: string, code: number): T {
  const name = Number.isInteger(code) ? names[code] : undefined;
  if (name === undefined) throw new RangeError(`unknown ${what} code: ${code}`);
  return name;
}

export const agentStatusName = (code: number): AgentStatusName => nameAt(AGENT_STATUS_NAMES, "agent status", code);
export const milestoneStatusName = (code: number): MilestoneStatusName => nameAt(MILESTONE_STATUS_NAMES, "milestone status", code);
export const escrowStatusName = (code: number): EscrowStatusName => nameAt(ESCROW_STATUS_NAMES, "escrow status", code);

export function purchaseKindName(code: number): PurchaseKindName {
  const name = (PURCHASE_KIND_NAMES as Record<number, PurchaseKindName | undefined>)[code];
  if (name === undefined) throw new RangeError(`unknown purchase kind code: ${code}`);
  return name;
}

export function purchaseKindCode(name: PurchaseKindName): PurchaseKindCode {
  return name === "license" ? PURCHASE_KIND.License : name === "credits" ? PURCHASE_KIND.Credits : PURCHASE_KIND.Escrow;
}

/** True when every bit of `flag` is set in `pauseFlags`. */
export function isPaused(pauseFlags: number, flag: PauseFlag): boolean {
  return (pauseFlags & flag) === flag;
}
