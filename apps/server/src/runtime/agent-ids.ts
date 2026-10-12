// Package identifier formats (PACKAGE_SPEC.md 4.1). No env/database: used by the manifest,
// the loader, the catalog search and the tests.

/** Agent `id`: 16 bytes in lowercase hex (becomes the on-chain agent_id). */
export const AGENT_ID_RE = /^[0-9a-f]{32}$/;

/** `slug`: lowercase letters, digits and hyphens between blocks (no leading/trailing or double hyphen). */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Numeric `MAJOR.MINOR.PATCH` version (no pre-release). The on-chain contract accepts up to 16 bytes. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const MAX_VERSION_BYTES = 16;

export const isAgentId = (s: string) => AGENT_ID_RE.test(s);

/** Why the slug is not acceptable, or null. A slug shaped like an `id` would resolve to someone else's agent. */
export function slugProblem(slug: string): string | null {
  if (slug.length < 3 || slug.length > 40) return "slug must be 3 to 40 characters long";
  if (!SLUG_RE.test(slug)) return "slug only accepts lowercase letters, digits and hyphens between blocks";
  if (AGENT_ID_RE.test(slug)) return "slug can't have the format of an id (32 hexadecimal characters)";
  return null;
}

export function versionProblem(version: string): string | null {
  if (!VERSION_RE.test(version)) return "version must be numeric MAJOR.MINOR.PATCH (e.g. 1.0.0)";
  if (Buffer.byteLength(version) > MAX_VERSION_BYTES) return `version is over ${MAX_VERSION_BYTES} bytes (on-chain limit)`;
  return null;
}
