// Who can read and write a specialist's memory (PACKAGE_SPEC.md 11.2). Previously get_memory and
// save_memory accepted ANY agent_id from the catalog: memory could be written to a specialist the
// wallet never activated. Now it requires a license or an open session (paid or free trial) with that agent.

export type MemoryAccessFacts = {
  /** The wallet holds a lifetime license of the specialist. */
  licensed: boolean;
  /** There is a non-expired session of the wallet with the specialist (license, guarantee or free trial). */
  openSession: boolean;
};

export const canUseMemory = (f: MemoryAccessFacts): boolean => f.licensed || f.openSession;

export const MEMORY_NO_ACCESS_TEXT = "To use this specialist's memory, activate it first with activate_solver (free trial or license).";
