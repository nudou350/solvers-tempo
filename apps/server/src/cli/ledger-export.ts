// Exports the payment ledger as CSV to stdout.
//
//   pnpm --filter @solvers/server cli:ledger-export --from 2026-10-01 --to 2026-10-31 > ledger.csv
//
// Rows created between the two UTC days (both inclusive). Defaults: from the first day of the current month to today.
import { env } from "../env.js";
import { pool } from "../db/index.js";
import { ledgerCsv, ledgerRows, parseRange } from "../payments/export.js";

async function main() {
  const { from, to } = parseRange(process.argv.slice(2));
  const rows = await ledgerRows(from, to);
  process.stdout.write(ledgerCsv(rows, env.PAYMENT_TOKEN_DECIMALS));
  console.error(`[ledger-export] ${rows.length} rows from ${from.toISOString()} to ${to.toISOString()} (exclusive)`);
}

main()
  .catch((e) => {
    console.error(`[ledger-export] ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
