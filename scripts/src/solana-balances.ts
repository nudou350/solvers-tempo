// Read-only: SOL and USDC (SPL) balances of the Solana Pay test payer and of the platform recipient, to help funding
// them on devnet. Nothing is sent.
//
//   cd scripts && npm run solana:balances [-- <extra address> ...]
//   SOLANA_RPC_URL (devnet), SOLANA_PAYER_KEYPAIR (scripts/.keys/solana-devnet-payer.json),
//   SOLANA_PAY_KEYPAIR / SERVER_ENV_FILE (apps/server/.keys/solana-devnet-platform.json), SOLANA_PAY_MINT (devnet USDC)
import { existsSync } from "node:fs";
import { address, isAddress, type Address } from "@solana/kit";
import { SERVER_ENV_FILE, readEnvFile } from "./env.js";
import {
  DEVNET_USDC,
  FAUCETS,
  PAYER_KEYPAIR_FILE,
  SOLANA_RPC_URL,
  assertDevnet,
  fromUnits,
  loadKeypair,
  mintDecimals,
  platformKeypairFile,
  solBalance,
  solanaExplorerAddress,
  splBalance,
} from "./lib/solana.js";

const mint = address(process.env.SOLANA_PAY_MINT ?? readEnvFile(SERVER_ENV_FILE).SOLANA_PAY_MINT ?? DEVNET_USDC);

const rows: { label: string; addr: Address }[] = [];
for (const [label, file] of [
  ["payer", PAYER_KEYPAIR_FILE],
  ["platform (recipient)", platformKeypairFile(SERVER_ENV_FILE)],
] as const) {
  if (existsSync(file)) rows.push({ label, addr: (await loadKeypair(file)).address });
  else console.log(`(${label}: no keypair at ${file})`);
}
for (const a of process.argv.slice(2)) {
  if (!isAddress(a)) throw new Error(`not a Solana address: ${a}`);
  rows.push({ label: "extra", addr: address(a) });
}

await assertDevnet();
const decimals = await mintDecimals(mint);
console.log(`Solana devnet (${SOLANA_RPC_URL}), token ${mint} (${decimals} decimals)\n`);
for (const r of rows) {
  const [sol, usdc] = await Promise.all([solBalance(r.addr), splBalance(r.addr, mint)]);
  console.log(`${r.label.padEnd(22)} ${r.addr}`);
  console.log(`${"".padEnd(22)} SOL ${fromUnits(sol, 9).padStart(14)}   USDC ${fromUnits(usdc, decimals).padStart(12)}   ${solanaExplorerAddress(r.addr)}`);
}
console.log(`\nfaucets: SOL ${FAUCETS.sol} | USDC ${FAUCETS.usdc}`);
