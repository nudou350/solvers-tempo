// Pays one Solana Pay transfer request (the URL behind the checkout QR) from the devnet test payer, the way a wallet
// would. Handy to test the web checkout without a phone; devnet only.
//
//   cd scripts && npx tsx src/solana-pay-url.ts "solana:<recipient>?amount=…&spl-token=…&reference=…"
import { assertDevnet, loadPayer, payTransferRequest, solanaExplorerTx } from "./lib/solana.js";

const url = process.argv[2];
if (!url?.startsWith("solana:")) {
  console.error('usage: npx tsx src/solana-pay-url.ts "solana:…"');
  process.exit(1);
}
await assertDevnet();
const res = await payTransferRequest(await loadPayer(), url);
console.log(`paid ${res.amountUnits} units: ${solanaExplorerTx(res.signature)}`);
