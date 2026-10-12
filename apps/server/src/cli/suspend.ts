// The admin kill switch (PACKAGE_SPEC.md 15.4): suspends (or resumes with --resume) a Solver on the platform AND on-chain.
//
//   pnpm --filter @solvers/server cli:suspend <slug> [--reason "<text>"] [--key-file <file>] [--allow-network mainnet]
//   pnpm --filter @solvers/server cli:suspend <slug> --resume
//
// 1) agents.platform_status (a column the indexer never writes): drops open sessions, the store and sales at once;
// 2) suspendAgent on-chain with the default admin key, fee sponsored by RELAY (without it a direct purchase through the
//    contract would still be possible);
// 3) audit row in package_reviews (suspend/resume) and the submission published <-> suspended.

import { decodeSolversError } from "@solvers/chain";
import { explorerUrl } from "../chain/index.js";
import { pool } from "../db/index.js";
import { isPlatformAgent } from "../runtime/platform-agents.js";
import { CliUsageError, parseSuspendArgs, SUSPEND_USAGE } from "../publish/cli-args.js";
import { suspendSolver, SuspendError } from "../publish/suspend.js";
import { KeySourceError, NetworkError } from "./admin-guard.js";
import { initCliChain, txLink } from "./cli-chain.js";

async function main() {
  const args = parseSuspendArgs(process.argv.slice(2));
  // Platform Solvers are database-only: no chain, no key.
  if (!isPlatformAgent(args.ref)) {
    const { network, warning, signer } = await initCliChain({ keyFile: args.keyFile, allowNetwork: args.allowNetwork });
    if (warning) console.warn(warning);
    console.log(`network: ${network}  | signer: ${signer?.address ?? "no key loaded"}`);
  }

  const r = await suspendSolver(args.ref, { resume: args.resume, reason: args.reason ?? undefined });
  console.log(`${r.action === "suspend" ? "Suspended" : "Resumed"}: ${r.slug} (${r.agentId})`);
  console.log(`  platform: ${r.platformChanged ? "platform_status changed" : "already like this"}`);
  console.log(`  chain: ${r.chainTx ? txLink(explorerUrl, r.chainTx) : "nothing to do (already in that state, or a database-only Solver)"}`);
  if (r.submissionId) console.log(`  submission: ${r.submissionId}`);
}

try {
  await main();
} catch (e) {
  if (e instanceof CliUsageError) {
    console.error(`${e.message}\n\n${SUSPEND_USAGE}`);
    process.exitCode = 2;
  } else {
    const known = e instanceof SuspendError || e instanceof NetworkError || e instanceof KeySourceError;
    const decoded = known ? null : decodeSolversError(e);
    const msg = known ? (e as Error).message : decoded && decoded.name !== "Unknown" ? `${decoded.name}: ${decoded.message}` : ((e as Error)?.message ?? String(e));
    console.error(`Failed: ${msg}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
process.exit(process.exitCode ?? 0);
