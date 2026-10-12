import { sha256Hex } from "../lib/crypto.js";

// Pure review rules (no env/database), tested in test/review.test.ts.
// The text lives off-chain and only counts when its sha256 is the `contentHash` confirmed on-chain.

const bare = (h: string) => h.trim().toLowerCase().replace(/^0x/, "");

/** On-chain `contentHash` of a review text: `0x` + sha256(utf8 text). */
export function reviewContentHash(text: string): `0x${string}` {
  return `0x${sha256Hex(text)}`;
}

/** Is the text what the on-chain hash says it is? (hashes compare with or without the 0x prefix) */
export function textMatchesHash(text: string, contentHash: string): boolean {
  return sha256Hex(text) === bare(contentHash);
}

/**
 * Picks the text to publish for the hash confirmed on-chain: the first candidate (draft with the same hash, text already
 * published, empty) whose sha256 matches. None matches: "" (never a text the hash does not prove, e.g. a review submitted
 * straight on-chain).
 */
export function resolvePublishedText(chainHash: string, candidates: Array<string | null | undefined>): string {
  for (const c of [...candidates, ""]) {
    if (typeof c === "string" && textMatchesHash(c, chainHash)) return c;
  }
  return "";
}

/** Which of the wallet's licenses backs the review (a license backs at most one author's review on-chain, X12). */
export type ReviewLicenseChoice = { kind: "use"; asset: string } | { kind: "none" } | { kind: "all_used" };

/**
 * `owned`: the wallet's licenses of the Solver, with `used` = the license already backs ANOTHER author's review (a
 * license bound to the wallet's own review can keep backing it). Uses the first unused one. All used: when the wallet
 * itself already reviewed (`hasOwnReview`), keeps the first and lets the contract refuse with the right message;
 * otherwise the limit comes from a transferred license whose review the previous owner already spent (`all_used`).
 * No license: `none`.
 */
export function chooseReviewLicense(owned: ReadonlyArray<{ id: string; used: boolean }>, hasOwnReview: boolean): ReviewLicenseChoice {
  if (owned.length === 0) return { kind: "none" };
  const free = owned.find((l) => !l.used);
  if (free) return { kind: "use", asset: free.id };
  return hasOwnReview ? { kind: "use", asset: owned[0]!.id } : { kind: "all_used" };
}
