#!/usr/bin/env node
// Merges the transaction hashes of a broadcast deploy into deployments/<chainId>.json (plan §6 phase 2 step 3).
// `forge script` writes deployments/<chainId>.json during the simulation, before any transaction exists, so the hashes
// are read afterwards from broadcast/Deploy.s.sol/<chainId>/run-latest.json.
//   node script/record-deployment.mjs <chainId>
import { readFileSync, writeFileSync } from "node:fs";

const chainId = process.argv[2];
if (!/^\d+$/.test(chainId ?? "")) throw new Error("usage: node script/record-deployment.mjs <chainId>");
const runFile = `broadcast/Deploy.s.sol/${chainId}/run-latest.json`;
const depFile = `../deployments/${chainId}.json`;
const run = JSON.parse(readFileSync(runFile, "utf8"));
const dep = JSON.parse(readFileSync(depFile, "utf8"));
const receipts = new Map((run.receipts ?? []).map((r) => [r.transactionHash, r]));
dep.txHashes = run.transactions.map((t) => ({
  hash: t.hash,
  kind: t.transactionType,
  contract: t.contractName ?? null,
  function: t.function ?? null,
  address: t.contractAddress ?? null,
  status: receipts.get(t.hash)?.status ?? null,
}));
const blocks = (run.receipts ?? []).map((r) => Number(BigInt(r.blockNumber)));
if (blocks.length) dep.deployBlock = Math.min(...blocks);
writeFileSync(depFile, JSON.stringify(dep, null, 2) + "\n");
console.log(`recorded ${dep.txHashes.length} transactions; deployBlock ${dep.deployBlock}`);
