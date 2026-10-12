import { fromUnits } from "@solvers/shared";

import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { alertAdmin } from "./alerts.js";
import { tokenBalance } from "./chain.js";

// Float alert (plan §5): the PLATFORM key pays every `*For` purchase (Pix, agent-pay) and the RELAY key pays every fee.
// Either below FLOAT_LOW_BALANCE_UNITS -> Telegram alert to the admin (runbook docs/treasury.md), at most every 6 h.

export type Balance = { name: "PLATFORM" | "RELAY" | "TREASURY"; address: string; units: bigint };

/** Accounts below the threshold (pure). */
export function lowBalances(balances: readonly Balance[], threshold: bigint): Balance[] {
  return balances.filter((b) => b.name !== "TREASURY" && b.units < threshold);
}

export async function readBalances(): Promise<Balance[]> {
  const c = chainContext();
  const out: Balance[] = [
    { name: "PLATFORM", address: c.accounts.platform.address, units: await tokenBalance(c.accounts.platform.address) },
    { name: "RELAY", address: c.accounts.relay.address, units: await tokenBalance(c.accounts.relay.address) },
  ];
  const treasury = env.TREASURY_ADDRESS ?? c.deployment.treasury;
  if (treasury) out.push({ name: "TREASURY", address: treasury, units: await tokenBalance(treasury) });
  return out;
}

/** Job body: returns how many alerts were raised. */
export async function checkFloat(): Promise<number> {
  const low = lowBalances(await readBalances(), env.FLOAT_LOW_BALANCE_UNITS);
  let sent = 0;
  for (const b of low) {
    const amount = fromUnits(b.units, env.PAYMENT_TOKEN_DECIMALS);
    const min = fromUnits(env.FLOAT_LOW_BALANCE_UNITS, env.PAYMENT_TOKEN_DECIMALS);
    const raised = await alertAdmin(
      `float-low:${b.name}`,
      `${b.name} (${b.address}) holds ${amount} ${env.PAYMENT_TOKEN_SYMBOL}, below ${min}. Top it up (docs/treasury.md).`,
      { everyMs: 6 * 3600_000 },
    );
    if (raised) sent++;
  }
  return sent;
}
