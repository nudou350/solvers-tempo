// Tops up the server's hot wallets (PLATFORM float, RELAY fee payer, VERIFIER, admin) and named test wallets with the
// payment token. Moderato: the public faucet RPC `tempo_fundAddress` (plan T7: https://tempo.xyz/developers/docs/quickstart/faucet),
// called until the balance reaches the target; local anvil: a transfer from dev account 0. Never on mainnet.
//
//   cd scripts && npx tsx src/topup.ts                     # server wallets from apps/server/.env, target 100 each
//   npx tsx src/topup.ts --min 500 platform relay           # only these server wallets, target 500
//   npx tsx src/topup.ts --min 50 0xabc... buyer1           # an address and/or a named key under scripts/.keys
//   SERVER_ENV_FILE=../apps/server/.env.qa npx tsx src/topup.ts   # the local QA environment
import { isAddress, type Address } from "viem";
import { fmt, fund, namedAccount, network, serverAccount, tokenBalance, units } from "./env.js";

const SERVER_KEYS: Record<string, string> = {
  platform: "PLATFORM_PRIVATE_KEY",
  relay: "RELAY_PRIVATE_KEY",
  verifier: "VERIFIER_PRIVATE_KEY",
  admin: "ADMIN_PRIVATE_KEY",
};

const args = process.argv.slice(2);
const minIdx = args.indexOf("--min");
const min = units(minIdx >= 0 ? args[minIdx + 1]! : "100");
const names = args.filter((a, i) => a !== "--min" && args[i - 1] !== "--min");

const n = await network();
console.log(`chain ${n.chainId} (${n.rpcUrl}), token ${n.deployment.token}, target ${fmt(min)} per wallet`);

const targets: { label: string; address: Address }[] = [];
for (const name of names.length ? names : Object.keys(SERVER_KEYS)) {
  if (isAddress(name)) targets.push({ label: name, address: name });
  else if (SERVER_KEYS[name]) {
    try {
      targets.push({ label: name, address: serverAccount(SERVER_KEYS[name]!).address });
    } catch (e) {
      console.log(`- ${name}: skipped (${(e as Error).message})`);
    }
  } else targets.push({ label: name, address: namedAccount(name).address });
}

let failed = 0;
for (const t of targets) {
  const before = await tokenBalance(t.address);
  try {
    const hashes = await fund(t.address, min);
    const after = await tokenBalance(t.address);
    console.log(`PASS  ${t.label} ${t.address}: ${fmt(before)} -> ${fmt(after)}${hashes.length ? ` (${hashes.length} tx: ${hashes.map((h) => n.explorer(h)).join(" ")})` : " (already funded)"}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.label} ${t.address}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
