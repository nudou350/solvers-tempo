import type { Call } from "@solvers/chain";
import type { TxResponse } from "@solvers/shared";
import type { Address, Hex } from "viem";
import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { assertSimulationOk, classifySimulationError, type SimulationResult } from "./simulation-gate.js";

/** The `/api/tx/*` response: calls the wallet sends as ONE 0x76 batch with `feePayer: true` (the relay pays the fee). */
export function txResponse(calls: readonly Call[], purchaseId?: Hex): TxResponse {
  return {
    calls: calls.map((c) => ({ to: c.to.toLowerCase() as Address, data: c.data })),
    feePayer: true,
    chainId: env.CHAIN_ID,
    ...(purchaseId ? { purchaseId: purchaseId.toLowerCase() as Hex } : {}),
  };
}

/** Simulates the batch as `wallet` (`eth_estimateGas` over the calls; state of call 1 is visible to call 2). */
export async function simulateCalls(wallet: Address, calls: readonly Call[]): Promise<SimulationResult> {
  try {
    const gas = await chainContext().publicClient.estimateGas({
      account: wallet,
      calls: calls.map((c) => ({ to: c.to, data: c.data })),
    } as never);
    return { ok: true, gas };
  } catch (e) {
    return classifySimulationError(e);
  }
}

/**
 * Builds the response for the wallet after simulating it: the signer never receives a batch the contracts would already
 * refuse. Prechecks with data (balance, new price, ownership) run BEFORE and give richer answers; the simulation catches
 * the rest (on-chain state ahead of the mirror, deadlines) and races between the precheck and the signature.
 *
 * Call it BEFORE writing anything for the operation: a refused simulation must not leave a draft behind.
 */
export async function buildChecked(wallet: Address, calls: readonly Call[], label: string, purchaseId?: Hex): Promise<TxResponse> {
  assertSimulationOk(await simulateCalls(wallet, calls), label);
  return txResponse(calls, purchaseId);
}
