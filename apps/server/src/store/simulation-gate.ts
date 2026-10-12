import { decodeSolversError } from "@solvers/chain";
import { SUPPLY_ERROR_CODES, SUPPLY_ERROR_HTTP_STATUS } from "@solvers/shared";
import { BaseError, ExecutionRevertedError } from "viem";
import { HttpError } from "../lib/http.js";

/** Outcome of simulating a call batch before handing it to the wallet. */
export type SimulationResult =
  | { ok: true; gas?: bigint }
  /** The contracts would revert (custom error name when it decodes, else "Unknown"). */
  | { ok: false; kind: "rejected"; name: string; message: string }
  /** Could not simulate (RPC down, timeout, fee-balance checks of the simulation itself). */
  | { ok: false; kind: "infra"; message: string };

/** Classifies an `estimateGas` failure: a decoded contract error or an explicit revert is "rejected", the rest "infra". */
export function classifySimulationError(err: unknown): SimulationResult {
  const decoded = decodeSolversError(err);
  if (decoded.name !== "Unknown") return { ok: false, kind: "rejected", name: decoded.name, message: decoded.message };
  const reverted = err instanceof BaseError && err.walk((e) => e instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
  if (reverted) return { ok: false, kind: "rejected", name: "Unknown", message: decoded.message };
  return { ok: false, kind: "infra", message: (err as Error)?.message?.split("\n")[0] ?? String(err) };
}

/**
 * Decides what to do with the simulation of a batch BEFORE the wallet signs it (pure).
 * - ok: continue.
 * - rejected: the transaction would really revert; 409 with the friendly message (never 422, which the web reads as
 *   "the network did not confirm, nothing was charged"). `SoldOut` keeps the precheck's `sold_out` code.
 * - infra: does NOT block (fail-open); the relay simulates again before sponsoring. Only logged.
 */
export function assertSimulationOk(result: SimulationResult, label: string, log: (msg: string) => void = console.warn): void {
  if (result.ok) return;
  if (result.kind === "rejected") {
    if (result.name === "SoldOut") {
      throw new HttpError(SUPPLY_ERROR_HTTP_STATUS[SUPPLY_ERROR_CODES.soldOut], result.message, SUPPLY_ERROR_CODES.soldOut);
    }
    throw new HttpError(409, result.message, "operation_rejected", { contractError: result.name });
  }
  log(`[simulate] ${label}: simulation unavailable, continuing without blocking: ${result.message}`);
}
