// Dev/demo CLIs (`cli:publish`, `cli:seed`) acting as a user wallet: the wallet key signs one Tempo batch and the RELAY
// key pays the fee in-process (the same sponsorship the relay gives browsers), then the tx is handed to the indexer.

import { sendCalls, serverWalletClient, waitForSuccess, type Call } from "@solvers/chain";
import type { Account, Hex, TransactionReceipt } from "viem";
import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { processTxHash } from "../indexer/index.js";

/** Hands a confirmed tx hash to the indexer. Never throws. */
export async function indexTx(hash: Hex): Promise<void> {
  try {
    await processTxHash(hash);
  } catch (e) {
    console.warn(`  (indexing ${hash} later: ${(e as Error).message})`);
  }
}

/** Sends `calls` as `account` (fee sponsored by RELAY), waits for success and indexes. */
export async function sendAsWallet(account: Account, calls: readonly Call[]): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const c = chainContext();
  const wallet = serverWalletClient(account, c.chain, env.RPC_URL);
  const hash = await sendCalls(wallet as never, calls, { feePayer: c.accounts.relay });
  const receipt = await waitForSuccess(c.publicClient as never, hash);
  await indexTx(hash);
  return { hash, receipt };
}
