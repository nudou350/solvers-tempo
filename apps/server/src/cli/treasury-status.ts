// Balances of the platform keys and the treasury, plus the charges still open in the payment ledger.
//
//   pnpm --filter @solvers/server cli:treasury-status
//
// Read-only: no transaction is sent. The float (PLATFORM) pays the `*For` purchases of Pix and agent payments; RELAY
// pays every network fee; the treasury receives the platform fee and royalties (runbook docs/treasury.md).
import { count, inArray, min } from "drizzle-orm";
import { fromUnits } from "@solvers/shared";

import { initChain } from "../chain/index.js";
import { db, pool, schema } from "../db/index.js";
import { env } from "../env.js";
import { lowBalances, readBalances } from "../payments/float.js";
import { OPEN_STATUSES } from "../payments/lifecycle.js";

async function main() {
  await initChain({ validate: false });
  const balances = await readBalances();
  const low = new Set(lowBalances(balances, env.FLOAT_LOW_BALANCE_UNITS).map((b) => b.name));
  const fmt = (u: bigint) => `${fromUnits(u, env.PAYMENT_TOKEN_DECIMALS)} ${env.PAYMENT_TOKEN_SYMBOL}`;
  console.log(`chain ${env.CHAIN_ID}, token ${env.PAYMENT_TOKEN} (${env.PAYMENT_TOKEN_DECIMALS} decimals)`);
  console.log(`alert threshold: ${fmt(env.FLOAT_LOW_BALANCE_UNITS)}\n`);
  for (const b of balances) {
    console.log(`${b.name.padEnd(9)} ${b.address}  ${fmt(b.units).padStart(24)}${low.has(b.name) ? "  LOW" : ""}`);
  }
  const open = await db
    .select({
      provider: schema.paymentLedger.provider,
      status: schema.paymentLedger.status,
      n: count(),
      oldest: min(schema.paymentLedger.createdAt),
    })
    .from(schema.paymentLedger)
    .where(inArray(schema.paymentLedger.status, [...OPEN_STATUSES]))
    .groupBy(schema.paymentLedger.provider, schema.paymentLedger.status);
  console.log("\nopen charges:");
  if (open.length === 0) console.log("  none");
  for (const o of open) {
    console.log(`  ${o.provider.padEnd(18)} ${o.status.padEnd(16)} ${String(o.n).padStart(5)}  oldest ${o.oldest?.toISOString() ?? "-"}`);
  }
}

main()
  .catch((e) => {
    console.error(`[treasury-status] ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
