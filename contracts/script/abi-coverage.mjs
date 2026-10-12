#!/usr/bin/env node
// ABI meta-check (plan §4.10 "every_function_and_error_has_a_test"): every function, event-free error and custom error
// in the ABI of the six Solvers contracts must be referenced by name in at least one test file under test/.
// Prints one missing name per line (empty output = all covered). Run from contracts/ after `forge build`.
// Used by test/AbiCoverage.t.sol through vm.ffi.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const out = process.env.FOUNDRY_OUT || "out";
const CONTRACTS = ["SolversRegistry", "SolversLicense", "SolversCredits", "SolversReviews", "SolversEscrow", "SolversStaking"];

// OZ machinery exposed by every UUPS / ERC-721 / AccessControl contract that is exercised through other names or is a
// pure standard getter; listed explicitly so nothing else can hide here.
const STANDARD = new Set(["proxiableUUID", "UPGRADE_INTERFACE_VERSION", "DEFAULT_ADMIN_ROLE", "name", "symbol"]);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".sol") ? [p] : [];
  });
}
const tests = walk("test").map((f) => readFileSync(f, "utf8")).join("\n");

const missing = [];
for (const c of CONTRACTS) {
  const path = join(out, `${c}.sol`, `${c}.json`);
  if (!existsSync(path)) {
    missing.push(`${c}: artifact not found at ${path}`);
    continue;
  }
  const abi = JSON.parse(readFileSync(path, "utf8")).abi;
  for (const item of abi) {
    if (item.type !== "function" && item.type !== "error") continue;
    if (STANDARD.has(item.name)) continue;
    const re = new RegExp(`\\b${item.name}\\b`);
    if (!re.test(tests)) missing.push(`${c}.${item.name} (${item.type})`);
  }
}
process.stdout.write([...new Set(missing)].join("\n"));
