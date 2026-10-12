import { HttpError } from "../lib/http.js";

// Platform Solvers (PACKAGE_SPEC.md 4.1 and 19): free, database only (no on-chain record), no license and no
// free trial. The AUTHORITY is this server-side list, never the manifest's `platform` field: the manifest only counts
// if the slug+id pair is here. Pure (no env or database), tested in test/platform-agents.test.ts.

export type PlatformAgent = { readonly slug: string; readonly id: string };

export const PLATFORM_AGENTS: readonly PlatformAgent[] = [
  // Solver Creator: helps creators put together their package (agents/criador-de-solvers).
  { slug: "criador-de-solvers", id: "c71ad0a50f750e75c71ad0a50f750e75" },
];

/** Ids of the platform Solvers (for database filters). */
export const PLATFORM_AGENT_IDS: readonly string[] = PLATFORM_AGENTS.map((a) => a.id);

/** Does the id (32 hex) or the slug belong to a platform Solver? */
export function isPlatformAgent(idOrSlug: string): boolean {
  return PLATFORM_AGENTS.some((a) => a.id === idOrSlug || a.slug === idOrSlug);
}

/** Agent row (database) or manifest: having the id is enough. */
export function isPlatformAgentRow(row: { id: string }): boolean {
  return PLATFORM_AGENTS.some((a) => a.id === row.id);
}

/** Is the slug+id pair exactly one of the list? (The id of one and the slug of another do not count.) */
export function isPlatformPair(m: { id: string; slug: string }): boolean {
  return PLATFORM_AGENTS.some((a) => a.id === m.id && a.slug === m.slug);
}

/**
 * Decides whether a package on disk belongs to the platform and whether loading should fail. Returns `platform` (the
 * list is the authority) or `error` (text for the server log).
 * - The `platform: true` field without the pair in the list: error (nobody declares itself platform on its own).
 * - The list's id or slug used by another pair, or by a creator's published package: error.
 */
export function platformVerdict(m: { id: string; slug: string; platform?: boolean }, source: "agents" | "published"): { platform: boolean; error?: string } {
  const pair = isPlatformPair(m);
  const touchesList = PLATFORM_AGENTS.some((a) => a.id === m.id || a.slug === m.slug);
  if (touchesList && !pair) return { platform: false, error: `id or slug reserved for a platform Solver (${m.slug} / ${m.id}), but the pair does not match PLATFORM_AGENTS` };
  if (pair && source !== "agents") return { platform: false, error: `${m.slug} is a platform Solver and can only come from the platform packages folder (AGENTS_DIR)` };
  if (m.platform === true && !pair) return { platform: false, error: `the manifest declares platform: true, but ${m.slug} is not in PLATFORM_AGENTS (the server disagrees)` };
  return { platform: pair };
}

export const PLATFORM_NOT_FOR_SALE_CODE = "platform_agent_not_for_sale";
export const PLATFORM_NOT_FOR_SALE_TEXT = "This is a free platform Solver: it is not sold and has no license. Just activate it with activate_solver.";

/** Blocks purchases, guarantees and every other payment path for a platform Solver (409 `platform_agent_not_for_sale`). */
export function assertNotPlatformAgent(row: { id: string }): void {
  if (isPlatformAgentRow(row)) throw new HttpError(409, PLATFORM_NOT_FOR_SALE_TEXT, PLATFORM_NOT_FOR_SALE_CODE);
}
