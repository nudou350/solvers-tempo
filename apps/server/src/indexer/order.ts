// Processing order of the indexer (pure): events are applied in (blockNumber, logIndex) order, grouped by transaction
// (within a 0x76 receipt the logIndex increases strictly across every batched call, phase-3 spike d).

type Ordered = { blockNumber: bigint; logIndex: number; transactionHash: string };

export function compareEvents(a: Ordered, b: Ordered): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

export function sortEvents<T extends Ordered>(events: readonly T[]): T[] {
  return [...events].sort(compareEvents);
}

/** Groups events by transaction (lowercase hash), keeping the order of first appearance and the order inside each group. */
export function groupByTx<T extends Ordered>(events: readonly T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const ev of events) {
    const k = ev.transactionHash.toLowerCase();
    const list = out.get(k);
    if (list) list.push(ev);
    else out.set(k, [ev]);
  }
  return [...out.entries()];
}
