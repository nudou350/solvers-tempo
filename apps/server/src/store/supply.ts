import { SUPPLY_ERROR_CODES, SUPPLY_ERROR_HTTP_STATUS } from "@solvers/shared";
import { HttpError } from "../lib/http.js";
import { isRowSoldOut, soldOutText, supplyOfRow, type SupplyRow } from "./supply-rules.js";

/**
 * Precheck for a new license purchase: 409 `sold_out` when the Solver's cap was reached. Reads only the database mirror
 * (`total_sales` and `max_licenses`), no RPC. It is a convenience and a clear answer: the contract is the real barrier
 * (`purchaseLicense` reverts with `SoldOut` and no token moves), also when the mirror lags. The text never promises that
 * "only N will exist": the creator can raise the cap.
 */
export function assertSupplyOpen(row: SupplyRow): void {
  if (!isRowSoldOut(row)) return;
  const supply = supplyOfRow(row);
  throw new HttpError(SUPPLY_ERROR_HTTP_STATUS[SUPPLY_ERROR_CODES.soldOut], soldOutText(row.name), SUPPLY_ERROR_CODES.soldOut, {
    maxLicenses: supply.max,
    sold: supply.sold,
  });
}
