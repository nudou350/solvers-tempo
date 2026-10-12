import { MAX_LICENSES_CAP, SUPPLY_UNLIMITED, soldOutText, toAgentSupply, type AgentSupply } from "@solvers/shared";

// Pure license-cap rules (no env, database or RPC), tested in test/supply-rules.test.ts.
// The contract is the authority (`purchaseLicense` reverts with `SoldOut`); these rules give the clear answer BEFORE the
// calls are built and decide what `cli:publish` does with the manifest's cap. The counter is `Agent.totalSales`
// (licenses ever minted for the Solver): transferring or burning a license never frees a slot.

export type SupplyRow = { name: string; totalSales: bigint | number; maxLicenses: number | null };

/** The database cap is already normalized (`null` = unlimited). */
export function supplyOfRow(row: Pick<SupplyRow, "totalSales" | "maxLicenses">): AgentSupply {
  return toAgentSupply(row.maxLicenses, Number(row.totalSales));
}

/** True when the Solver has a cap and every license has been issued. */
export function isRowSoldOut(row: Pick<SupplyRow, "totalSales" | "maxLicenses">): boolean {
  return supplyOfRow(row).left === 0;
}

/** Text for the screen and the AI; `null` when unlimited. */
export function supplyLabel(s: AgentSupply): string | null {
  if (s.max == null || s.left == null) return null;
  return s.left === 0 ? "sold out" : `${s.left} of ${s.max} licenses left`;
}

export { soldOutText };

/** The manifest's cap is an integer from 1 to `MAX_LICENSES_CAP`. */
export function validManifestMax(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_LICENSES_CAP;
}

export type SupplyPlan =
  | { ok: true; action: "none" }
  | { ok: true; action: "create" | "raise"; max: number }
  | { ok: false; reason: "lower" | "below_sold" | "unlimited_not_implicit" | "invalid"; message: string };

/**
 * What to do with the on-chain cap given what the manifest asks for (`SolversRegistry.setSupplyCap`: the first cap needs
 * `max >= max(1, totalSales)`, later caps can only go up).
 * - `current`: `Agent.maxSupply` read on-chain; `null` or `SUPPLY_UNLIMITED` (0) = no cap set yet (unlimited).
 * - `requested`: the manifest's `supply.maxLicenses`, or `null` when the manifest has no `supply`.
 * - `sold`: licenses already minted (`totalSales`).
 * A manifest without `supply` keeps an existing finite cap (it never becomes unlimited implicitly; the contract cannot
 * remove a cap anyway).
 */
export function nextMaxLicenses(current: number | null, requested: number | null, sold: number): SupplyPlan {
  const capped = current !== null && current !== SUPPLY_UNLIMITED;
  if (requested == null) {
    if (!capped) return { ok: true, action: "none" };
    return {
      ok: false,
      reason: "unlimited_not_implicit",
      message: `the manifest has no supply but the on-chain cap is ${current}: kept (raise maxLicenses in the manifest to change it)`,
    };
  }
  if (!validManifestMax(requested)) {
    return { ok: false, reason: "invalid", message: `supply.maxLicenses must be an integer from 1 to ${MAX_LICENSES_CAP}` };
  }
  if (!capped) {
    if (requested < sold) {
      return { ok: false, reason: "below_sold", message: `the manifest asks for a cap of ${requested}, below the ${sold} licenses already sold: cap not created` };
    }
    return { ok: true, action: "create", max: requested };
  }
  if (requested === current) return { ok: true, action: "none" };
  if (requested > current) return { ok: true, action: "raise", max: requested };
  return { ok: false, reason: "lower", message: `the cap can only go up: on-chain ${current}, manifest ${requested}; kept ${current}` };
}
