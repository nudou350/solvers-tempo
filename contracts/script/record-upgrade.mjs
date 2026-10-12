#!/usr/bin/env node
// Records an executed upgrade in deployments/<chainId>.json (decision X16): for each proxy whose ERC-1967 implementation
// on chain differs from `impls.<key>`, writes the new implementation, `implGitSha.<key>` (the commit the implementation
// was built from) and an entry in `upgrades[]`. The next script/Upgrade.s.sol run then validates against this commit.
//   node script/record-upgrade.mjs <chainId> --rpc-url <url> [--sha <40-hex commit>]
// Paths are resolved from this script's directory, so it can run from any working directory. Without --sha the commit is
// HEAD, and contracts/src must have no uncommitted changes (else the record would lie); a given --sha must be a commit of
// this repository.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const chainId = args[0];
const rpc = opt("--rpc-url");
if (!/^\d+$/.test(chainId ?? "") || !rpc) {
  console.error("usage: node script/record-upgrade.mjs <chainId> --rpc-url <url> [--sha <commit>]");
  process.exit(2);
}
const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (gitArgs) => execFileSync("git", gitArgs, { cwd: CONTRACTS, encoding: "utf8" }).trim();
const exe = process.platform === "win32" ? ".exe" : "";
const localCast = join(homedir(), ".foundry", "bin", `cast${exe}`);
const cast = process.env.CAST_BIN ?? (existsSync(localCast) ? localCast : "cast");

let sha = opt("--sha");
if (!sha) {
  const dirty = git(["status", "--porcelain", "--", "src"]);
  if (dirty) {
    console.error("contracts/src has uncommitted changes: commit them (the upgrade must come from a commit) or pass --sha");
    process.exit(1);
  }
  sha = git(["rev-parse", "HEAD"]);
}
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a 40-hex commit: ${sha}`);
try {
  execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: CONTRACTS, stdio: "ignore" });
} catch {
  console.error(`--sha ${sha} is not a commit of this repository (git cat-file -e ${sha}^{commit} failed): fetch it or check the hash`);
  process.exit(1);
}

const file = join(CONTRACTS, "..", "deployments", `${chainId}.json`);
const dep = JSON.parse(readFileSync(file, "utf8"));
if (String(dep.chainId) !== chainId) throw new Error(`${file} is for chain ${dep.chainId}`);
const onChain = Number(execFileSync(cast, ["chain-id", "--rpc-url", rpc], { encoding: "utf8" }).trim());
if (String(onChain) !== chainId) throw new Error(`the RPC is chain ${onChain}, not ${chainId}`);

const KEYS = ["registry", "license", "credits", "reviews", "escrow", "staking"];
const now = Math.floor(Date.now() / 1000);
let changed = 0;
for (const key of KEYS) {
  const impl = execFileSync(cast, ["implementation", dep[key], "--rpc-url", rpc], { encoding: "utf8" }).trim();
  if (impl.toLowerCase() === String(dep.impls[key]).toLowerCase()) continue;
  dep.upgrades = [...(dep.upgrades ?? []), { key, from: dep.impls[key], to: impl, gitSha: sha, recordedAt: now }];
  dep.impls[key] = impl;
  dep.implGitSha = { ...(dep.implGitSha ?? {}), [key]: sha };
  changed++;
  console.log(`${key}: ${impl} (source ${sha})`);
}
if (!changed) {
  console.log("no implementation changed on chain: nothing recorded");
} else {
  writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(`recorded ${changed} upgrade(s) in ${file}; regenerate the client if it is a public network`);
}
