// Pure image rules (no env/database), tested in test/images.test.ts.

/** Lowest free position in 0..max-1, or null when the gallery is full. */
export function firstFreePosition(used: number[], max: number): number | null {
  const taken = new Set(used);
  for (let p = 0; p < max; p++) if (!taken.has(p)) return p;
  return null;
}
