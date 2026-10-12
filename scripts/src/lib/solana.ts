// Solana helpers of the Solana Pay scripts (@solana/kit): keys, RPC, Solana Pay URL parsing, and a transfer built the
// way a wallet (Phantom) answers a Solana Pay transfer request.
//
// Environment (all optional):
//   SOLANA_RPC_URL        Solana JSON-RPC (default https://api.devnet.solana.com). The scripts only run on devnet: the
//                         RPC's genesis hash is checked before anything is sent.
//   SOLANA_PAYER_KEYPAIR  JSON keypair (solana-keygen format) of the test payer (default scripts/.keys/solana-devnet-payer.json)
//
// Solana Pay transfer request spec (https://docs.solanapay.com/spec):
//   solana:<recipient>?amount=<decimal>&spl-token=<mint>&reference=<key>(&reference=...)&label=..&message=..&memo=..
//   - SPL transfer = TokenProgram.transferChecked from the payer's ATA to the recipient's ATA;
//   - every `reference` is added, in order, as a read-only non-signer key of the transfer instruction;
//   - `memo` -> an SPL Memo instruction placed immediately before the transfer instruction.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getUtf8Encoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { ROOT, SERVER_DIR, readEnvFile, sleep } from "../env.js";

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Circle's devnet USDC (the default SOLANA_PAY_MINT on devnet). */
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? DEVNET_RPC;
export const PAYER_KEYPAIR_FILE = process.env.SOLANA_PAYER_KEYPAIR ?? join(ROOT, "scripts", ".keys", "solana-devnet-payer.json");
export const FAUCETS = { sol: "https://faucet.solana.com", usdc: "https://faucet.circle.com (Solana Devnet)" };

export type SolanaRpc = Rpc<SolanaRpcApi>;

let cachedRpc: SolanaRpc | undefined;
/** RPC of SOLANA_RPC_URL (default devnet). */
export function solanaRpc(): SolanaRpc {
  return (cachedRpc ??= createSolanaRpc(SOLANA_RPC_URL));
}

/** Refuses anything but devnet (checked by genesis hash, so a mainnet RPC behind any URL is refused too). */
export async function assertDevnet(rpc = solanaRpc()): Promise<void> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS) throw new Error(`${SOLANA_RPC_URL} is not Solana devnet (genesis ${genesis}): the scripts never spend outside devnet`);
}

export const solanaExplorerTx = (sig: string, cluster = "devnet") => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const solanaExplorerAddress = (a: string, cluster = "devnet") => `https://explorer.solana.com/address/${a}?cluster=${cluster}`;

// ---------- keys ----------

/** Loads a solana-keygen JSON keypair (64-byte array). Errors never quote the file's content. */
export async function loadKeypair(file: string): Promise<KeyPairSigner> {
  if (!existsSync(file)) throw new Error(`Solana keypair not found: ${file}`);
  let bytes: Uint8Array;
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
    bytes = Uint8Array.from(arr as number[]);
  } catch {
    throw new Error(`${file} is not a solana-keygen JSON keypair (64-byte array)`);
  }
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    throw new Error(`${file}: invalid keypair bytes`);
  }
}

export const loadPayer = () => loadKeypair(PAYER_KEYPAIR_FILE);

/** Path of the server's SOLANA_PAY_KEYPAIR (server env file, relative to apps/server), else the default devnet file. */
export function platformKeypairFile(serverEnvFile = join(SERVER_DIR, ".env")): string {
  const raw = process.env.SOLANA_PAY_KEYPAIR ?? readEnvFile(serverEnvFile).SOLANA_PAY_KEYPAIR;
  if (raw) return isAbsolute(raw) ? raw : join(SERVER_DIR, raw);
  return join(SERVER_DIR, ".keys", "solana-devnet-platform.json");
}

// ---------- amounts ----------

/** Decimal string ("19", "5.7") -> base units; refuses more fractional digits than `decimals` (Solana Pay spec). */
export function toUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`invalid amount "${amount}"`);
  const [i, f = ""] = amount.split(".");
  if (f.length > decimals) throw new Error(`amount ${amount} has more than ${decimals} decimals`);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Base units -> decimal string without trailing zeros ("19", "5.7"). */
export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

// ---------- Solana Pay URL ----------

export type TransferRequest = {
  recipient: Address;
  /** Decimal string as written in the URL (null: the wallet would ask the user). */
  amount: string | null;
  splToken: Address | null;
  references: Address[];
  label: string | null;
  message: string | null;
  memo: string | null;
};

/** Parses a Solana Pay transfer request URL (throws on anything the spec does not allow). */
export function parseSolanaPayUrl(url: string): TransferRequest {
  if (!url.startsWith("solana:")) throw new Error(`not a solana: URL: ${url.slice(0, 80)}`);
  const rest = url.slice("solana:".length);
  const q = rest.indexOf("?");
  const recipient = decodeURIComponent(q === -1 ? rest : rest.slice(0, q));
  if (!isAddress(recipient)) throw new Error(`invalid recipient "${recipient}"`);
  const params = new URLSearchParams(q === -1 ? "" : rest.slice(q + 1));
  const one = (k: string) => {
    const all = params.getAll(k);
    if (all.length > 1) throw new Error(`"${k}" appears ${all.length} times`);
    return all[0] ?? null;
  };
  const amount = one("amount");
  if (amount !== null && !/^\d+(\.\d+)?$/.test(amount)) throw new Error(`invalid amount "${amount}"`);
  const splToken = one("spl-token");
  if (splToken !== null && !isAddress(splToken)) throw new Error(`invalid spl-token "${splToken}"`);
  const references = params.getAll("reference");
  for (const r of references) if (!isAddress(r)) throw new Error(`invalid reference "${r}"`);
  return {
    recipient: address(recipient),
    amount,
    splToken: splToken === null ? null : address(splToken),
    references: references.map((r) => address(r)),
    label: one("label"),
    message: one("message"),
    memo: one("memo"),
  };
}

// ---------- balances ----------

export async function solBalance(owner: Address, rpc = solanaRpc()): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return BigInt(value);
}

export const ata = async (owner: Address, mint: Address): Promise<Address> =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

/** SPL balance (base units) of `owner`'s associated token account for `mint`; 0 when the account does not exist. */
export async function splBalance(owner: Address, mint: Address, rpc = solanaRpc()): Promise<bigint> {
  const acc = await fetchMaybeToken(rpc, await ata(owner, mint), { commitment: "confirmed" });
  return acc.exists ? acc.data.amount : 0n;
}

export async function mintDecimals(mint: Address, rpc = solanaRpc()): Promise<number> {
  const m = await fetchMaybeMint(rpc, mint, { commitment: "confirmed" });
  if (!m.exists) throw new Error(`mint ${mint} not found on ${SOLANA_RPC_URL}`);
  return m.data.decimals;
}

// ---------- sending ----------

/** Polls the signature until confirmed (throws when it failed or its blockhash expired without landing). */
export async function confirmSignature(sig: Signature, lastValidBlockHeight: bigint, rpc = solanaRpc(), timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) throw new Error(`transaction ${sig} expired (blockhash no longer valid) without landing`);
    await sleep(1500);
  }
  throw new Error(`transaction ${sig} not confirmed after ${timeoutMs / 1000} s`);
}

export type PayResult = { signature: Signature; amountUnits: bigint; createdRecipientAta: boolean; recipientAta: Address; payerAta: Address };
export type SimulationResult = { err: unknown; logs: readonly string[]; amountUnits: bigint; createdRecipientAta: boolean };

/**
 * Pays a Solana Pay SPL transfer request as a wallet would: [create the recipient ATA idempotently, only when missing,
 * paid by the payer] + [memo, when present] + transferChecked(payer ATA -> recipient ATA, payer signs) with every
 * reference appended as a read-only non-signer key. `overrideUnits` pays another amount (negative tests).
 */
export async function payTransferRequest(payer: KeyPairSigner, url: string, o: { overrideUnits?: bigint; rpc?: SolanaRpc } = {}): Promise<PayResult> {
  const built = await buildTransfer(payer, url, o);
  const { signed, blockhash, rpc } = built;
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await confirmSignature(signature, blockhash.lastValidBlockHeight, rpc);
  return { signature, amountUnits: built.amountUnits, createdRecipientAta: built.createdRecipientAta, recipientAta: built.recipientAta, payerAta: built.payerAta };
}

/** Same transaction as `payTransferRequest`, only simulated (nothing is spent): checks the layout against the cluster. */
export async function simulateTransferRequest(payer: KeyPairSigner, url: string, o: { overrideUnits?: bigint; rpc?: SolanaRpc } = {}): Promise<SimulationResult> {
  const built = await buildTransfer(payer, url, o);
  const { value } = await built.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(built.signed), { encoding: "base64", commitment: "confirmed", sigVerify: true })
    .send();
  return { err: value.err, logs: value.logs ?? [], amountUnits: built.amountUnits, createdRecipientAta: built.createdRecipientAta };
}

async function buildTransfer(payer: KeyPairSigner, url: string, o: { overrideUnits?: bigint; rpc?: SolanaRpc }) {
  const rpc = o.rpc ?? solanaRpc();
  const req = parseSolanaPayUrl(url);
  if (!req.splToken) throw new Error("only SPL transfer requests are supported (no spl-token in the URL)");
  if (req.amount === null && o.overrideUnits === undefined) throw new Error("the URL has no amount");
  const mint = req.splToken;
  const decimals = await mintDecimals(mint, rpc);
  const amountUnits = o.overrideUnits ?? toUnits(req.amount!, decimals);
  if (amountUnits <= 0n) throw new Error("amount must be > 0");

  const payerAta = await ata(payer.address, mint);
  const recipientAta = await ata(req.recipient, mint);
  const source = await fetchMaybeToken(rpc, payerAta, { commitment: "confirmed" });
  if (!source.exists) throw new Error(`payer ${payer.address} has no ${mint} token account`);
  if (source.data.amount < amountUnits) throw new Error(`payer holds ${fromUnits(source.data.amount, decimals)}, needs ${fromUnits(amountUnits, decimals)}`);
  const dest = await fetchMaybeToken(rpc, recipientAta, { commitment: "confirmed" });

  const ixs: Instruction[] = [];
  if (!dest.exists) {
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: recipientAta, owner: req.recipient, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  }
  if (req.memo !== null) {
    ixs.push({ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array(getUtf8Encoder().encode(req.memo)) });
  }
  const transfer = getTransferCheckedInstruction({ source: payerAta, mint, destination: recipientAta, authority: payer, amount: amountUnits, decimals });
  ixs.push({ ...transfer, accounts: [...transfer.accounts, ...req.references.map((r) => ({ address: r, role: AccountRole.READONLY }))] });

  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return { signed, blockhash, rpc, amountUnits, createdRecipientAta: !dest.exists, recipientAta, payerAta };
}

/** Account keys of a confirmed transaction (to check the reference is among them, as the server does). */
export async function transactionAccountKeys(sig: Signature, rpc = solanaRpc()): Promise<string[]> {
  const tx = await rpc.getTransaction(sig, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
  if (!tx) throw new Error(`transaction ${sig} not found`);
  return tx.transaction.message.accountKeys.map((k) => String(k.pubkey));
}
