import { z } from "zod";

// License cap per Solver. The cap lives on-chain (`Agent.maxSupply` in SolversRegistry, enforced by the purchase with
// `SoldOut`); the server only mirrors it in `agents.max_licenses` for the storefront and to refuse a purchase before
// building the calls. The counter is `Agent.totalSales` (licenses ever minted for the Solver): burning or transferring a
// license never frees a slot. The creator can only raise the cap.

/** Highest cap a manifest may ask for. */
export const MAX_LICENSES_CAP = 1_000_000;

/** Value of `Agent.maxSupply` that means unlimited. */
export const SUPPLY_UNLIMITED = 0;

/** `max` and `left` are `null` when the Solver is unlimited. `sold` counts the licenses minted so far. */
export const AgentSupply = z.object({
  max: z.number().int().nullable(),
  sold: z.number().int(),
  left: z.number().int().nullable(),
});
export type AgentSupply = z.infer<typeof AgentSupply>;

export const UNLIMITED_SUPPLY: AgentSupply = { max: null, sold: 0, left: null };

/** Purchase error codes for the cap; web and MCP react to the `code`. */
export const SUPPLY_ERROR_CODES = {
  soldOut: "sold_out",
} as const;
export type SupplyErrorCode = (typeof SUPPLY_ERROR_CODES)[keyof typeof SUPPLY_ERROR_CODES];

export const SUPPLY_ERROR_HTTP_STATUS: Record<SupplyErrorCode, number> = {
  sold_out: 409,
};

/** Mirrored cap: `null` when unlimited (missing or `SUPPLY_UNLIMITED`). */
export function normalizeMaxLicenses(onchainMax: number | null | undefined): number | null {
  if (onchainMax == null || onchainMax === SUPPLY_UNLIMITED) return null;
  return onchainMax;
}

/** `left = max - sold` (never negative); `null` when unlimited. */
export function toAgentSupply(max: number | null, sold: number): AgentSupply {
  if (max == null) return { max: null, sold, left: null };
  return { max, sold, left: Math.max(0, max - sold) };
}

export function isSoldOut(supply: AgentSupply): boolean {
  return supply.left === 0;
}

/** "Sold out" text for web and MCP. */
export function soldOutText(name: string): string {
  return `${name} is sold out: the current license limit has been reached (the creator can raise it).`;
}
