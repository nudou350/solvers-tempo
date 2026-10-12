// The admin's on-chain approval of a NEW Solver (PACKAGE_SPEC.md 15.2/15.3): signs `approveAgent` with the Registry's
// default admin key (cold, off the VPS), with the fee sponsored by the RELAY key (D20), and triggers the finalization.
//
//   pnpm --filter @solvers/server cli:approve <slug|submissionId> [--dry-run] [--key-file <file>] [--allow-network mainnet]
//
// "Approve" on the site signs nothing on-chain; this command is step 4 of the sequence. It only approves when the on-chain
// agent matches the version approved on the site (it never signs over what the review did not see). Updates of an already
// approved Solver do not come here: updateVersion keeps the Active status and the publication finishes by itself.

import { decodeSolversError } from "@solvers/chain";
import { explorerUrl } from "../chain/index.js";
import { pool } from "../db/index.js";
import { ApproveError, approveOnChain } from "../publish/approve.js";
import { APPROVE_USAGE, CliUsageError, parseApproveArgs } from "../publish/cli-args.js";
import { KeySourceError, NetworkError } from "./admin-guard.js";
import { initCliChain, txLink } from "./cli-chain.js";

async function main() {
  const args = parseApproveArgs(process.argv.slice(2));
  // Network guard first (also for --dry-run): the .env RPC may point to another network.
  const { network, warning, signer } = await initCliChain({ keyFile: args.keyFile, allowNetwork: args.allowNetwork });
  if (warning) console.warn(warning);
  console.log(`network: ${network}${args.dryRun ? "  | DRY-RUN (nothing will be sent)" : ""}  | signer: ${signer?.address ?? "no key loaded"}`);

  const r = await approveOnChain(args.ref, { dryRun: args.dryRun });
  console.log(`Submission ${r.submissionId}: ${r.slug} v${r.version}`);
  if (r.dryRun) {
    console.log(r.step === "await-admin-approval" ? "Would do: approveAgent on-chain and finish the publication." : "Already Active on-chain: would only finish the publication.");
    return;
  }
  if (r.approveTx) console.log(`approveAgent confirmed: ${txLink(explorerUrl, r.approveTx)}`);
  else console.log("the Solver was already approved on-chain (no transaction sent)");
  const f = r.finalize;
  if (!f) return;
  switch (f.outcome) {
    case "published":
      console.log(`Published: ${r.slug} v${f.version} is live.`);
      break;
    case "already_published":
      console.log("The publication was already finished.");
      break;
    case "busy":
      console.log("Another process is finishing this publication right now (the API, from the chain event). Check /admin/reviews.");
      break;
    case "not_ready":
      console.log(`Cannot publish yet: ${f.reason}`);
      process.exitCode = 1;
      break;
    case "failed":
      console.error(`Finalization failed (the submission is publish_failed): ${f.error}\nRetry in /admin/reviews (Finish) or run this command again.`);
      process.exitCode = 1;
      break;
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof CliUsageError) {
    console.error(`${e.message}\n\n${APPROVE_USAGE}`);
    process.exitCode = 2;
  } else {
    const known = e instanceof ApproveError || e instanceof NetworkError || e instanceof KeySourceError;
    const decoded = known ? null : decodeSolversError(e);
    const msg = known ? (e as Error).message : decoded && decoded.name !== "Unknown" ? `${decoded.name}: ${decoded.message}` : ((e as Error)?.message ?? String(e));
    console.error(`Failed: ${msg}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
process.exit(process.exitCode ?? 0);
