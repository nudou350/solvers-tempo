import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { randomBytes } from "node:crypto";

import { env } from "../env.js";
import { keypairAddress, readSolanaKeypair } from "./keypair.js";
import { MEMO_PROGRAM_ADDRESS, type PaymentTx, type SolanaClusterName, type TxTokenBalance } from "./rules.js";

// Solana side of Solana Pay, behind one interface (`SolanaGateway`) so the provider can be tested with a fake: payment
// lookup by reference, the mint check, and the refund transaction (signed here, journaled by the provider, then sent).
// Uses @solana/kit only; the classic SPL Token program (Circle USDC is a classic mint).

/** A signed transaction; `slot` is the slot its blockhash was read at (it cannot land before it). */
export type SignedSolanaTx = { signature: string; wire: string; blockhash: string; lastValidBlockHeight: bigint; slot: bigint };

/** A signature as seen by getSignatureStatuses (history included): landed ok, landed with an error, or not seen. */
export type SignatureState = "confirmed" | "failed" | "unknown";

export interface SolanaGateway {
  readonly cluster: SolanaClusterName;
  /** SPL mint accepted. */
  readonly mint: string;
  /** Wallet that receives the payments (address of SOLANA_PAY_KEYPAIR). */
  recipient(): string;
  /** Associated token account of `owner` for `mint`. */
  ata(owner: string, mint: string): Promise<string>;
  /** Decimals of the mint; throws when it is not a classic SPL Token mint. */
  mintDecimals(): Promise<number>;
  /** Signatures that touched `reference` (commitment confirmed), oldest first. */
  signaturesFor(reference: string): Promise<{ signature: string; failed: boolean }[]>;
  /** The confirmed transaction, or null when the RPC does not have it (yet). */
  transaction(signature: string): Promise<PaymentTx | null>;
  signatureState(signature: string): Promise<SignatureState>;
  /** Current block height (commitment confirmed). */
  blockHeight(): Promise<bigint>;
  /**
   * Signs (does not send) `transferChecked(amount)` from the recipient's token account to `to`'s, creating it
   * idempotently, with a memo. Fee payer and authority: SOLANA_PAY_KEYPAIR.
   */
  signRefund(o: { to: string; amount: bigint; decimals: number; memo: string }): Promise<SignedSolanaTx>;
  /** Broadcasts a signed transaction; `resend` skips the preflight (the transaction may already be in flight). */
  broadcast(wire: string, o?: { resend?: boolean }): Promise<void>;
  /**
   * A successful transaction of the recipient's token account whose memo is `memo`, scanning back to `sinceSlot`
   * (the slot the refund was signed at); null when there is none. Throws when the history could not be read that far.
   */
  findByMemo(memo: string, sinceSlot: bigint): Promise<string | null>;
}

/** Pages of getSignaturesForAddress (1000 each) `findByMemo` may read before giving up as inconclusive. */
const MEMO_SCAN_PAGES = 10;

/** New per-charge reference: 32 random bytes as a base58 address (it never needs to be on the curve). */
export function newReference(): string {
  return getBase58Decoder().decode(randomBytes(32));
}

let keypair: { path: string; bytes: Uint8Array } | null = null;

function keypairBytes(): Uint8Array {
  const path = env.SOLANA_PAY_KEYPAIR;
  if (!path) throw new Error("SOLANA_PAY_KEYPAIR is not set.");
  if (keypair?.path !== path) keypair = { path, bytes: readSolanaKeypair(path) };
  return keypair.bytes;
}

/** Recipient wallet of this server (null when Solana Pay has no keypair). */
export function recipientAddress(): string | null {
  return env.SOLANA_PAY_KEYPAIR ? keypairAddress(keypairBytes()) : null;
}

const toBalances = (list: readonly unknown[] | null | undefined): TxTokenBalance[] =>
  (list ?? []).map((raw) => {
    const b = raw as { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
    return { accountIndex: b.accountIndex, mint: b.mint, owner: b.owner ?? null, amount: BigInt(b.uiTokenAmount.amount) };
  });

/** Gateway on the RPC of SOLANA_RPC_URL. The keypair is only read when the recipient or a refund needs it. */
export function createSolanaGateway(o: { rpcUrl: string; cluster: SolanaClusterName; mint: string }): SolanaGateway {
  const rpc = createSolanaRpc(o.rpcUrl);
  const mint = address(o.mint);
  let signer: Promise<KeyPairSigner> | null = null;
  // createKeyPairSignerFromBytes checks that the public half matches the secret half.
  const signerOf = () => (signer ??= createKeyPairSignerFromBytes(keypairBytes()).catch((e) => ((signer = null), Promise.reject(e))));
  const ata = async (owner: string, m: string) =>
    (await findAssociatedTokenPda({ owner: address(owner), mint: address(m), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0] as string;

  return {
    cluster: o.cluster,
    mint: o.mint,
    recipient: () => keypairAddress(keypairBytes()),
    ata,

    async mintDecimals() {
      const account = await fetchMint(rpc, mint, { commitment: "confirmed" });
      if (account.programAddress !== TOKEN_PROGRAM_ADDRESS) throw new Error(`SOLANA_PAY_MINT ${o.mint} is not an SPL Token mint.`);
      return account.data.decimals;
    },

    async signaturesFor(reference) {
      const list = await rpc.getSignaturesForAddress(address(reference), { commitment: "confirmed", limit: 100 }).send();
      return [...list].reverse().map((s) => ({ signature: s.signature as string, failed: s.err !== null }));
    },

    async transaction(signature) {
      const tx = await rpc
        .getTransaction(signature as Signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .send();
      if (!tx || !tx.meta) return null;
      // jsonParsed lists every account (loaded addresses included) with its pubkey and signer flag.
      const accounts = tx.transaction.message.accountKeys as readonly { pubkey: string; signer: boolean }[];
      return {
        err: tx.meta.err,
        accountKeys: accounts.map((k) => k.pubkey),
        signers: accounts.filter((k) => k.signer).map((k) => k.pubkey),
        preTokenBalances: toBalances(tx.meta.preTokenBalances),
        postTokenBalances: toBalances(tx.meta.postTokenBalances),
      };
    },

    async signatureState(signature) {
      const { value } = await rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
      const st = value[0];
      if (!st) return "unknown";
      if (st.err) return "failed";
      return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "confirmed" : "unknown";
    },

    async blockHeight() {
      return BigInt(await rpc.getBlockHeight({ commitment: "confirmed" }).send());
    },

    async signRefund(r) {
      if (r.amount <= 0n) throw new Error("refund amount must be positive");
      const authority = await signerOf();
      const destination = await ata(r.to, o.mint);
      const memo: Instruction = { programAddress: address(MEMO_PROGRAM_ADDRESS), data: new TextEncoder().encode(r.memo) };
      const instructions: Instruction[] = [
        getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: address(destination), owner: address(r.to), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getTransferCheckedInstruction({
          source: address(await ata(authority.address, o.mint)),
          mint,
          destination: address(destination),
          authority,
          amount: r.amount,
          decimals: r.decimals,
        }),
        memo,
      ];
      const { value: latest, context } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(authority, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      return {
        signature: getSignatureFromTransaction(signed),
        wire: getBase64EncodedWireTransaction(signed),
        blockhash: latest.blockhash,
        lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        slot: BigInt(context.slot),
      };
    },

    async broadcast(wire, b = {}) {
      const opts = b.resend
        ? ({ encoding: "base64", skipPreflight: true, maxRetries: 0n } as const)
        : ({ encoding: "base64", preflightCommitment: "confirmed" } as const);
      await rpc.sendTransaction(wire as Base64EncodedWireTransaction, opts).send();
    },

    async findByMemo(memo, sinceSlot) {
      const account = address(await ata(keypairAddress(keypairBytes()), o.mint));
      let before: Signature | undefined;
      for (let page = 0; page < MEMO_SCAN_PAGES; page++) {
        const list = await rpc
          .getSignaturesForAddress(account, { commitment: "confirmed", limit: 1000, ...(before ? { before } : {}) })
          .send();
        for (const s of list) {
          if (BigInt(s.slot) < sinceSlot) return null;
          // The RPC renders memos as "[len] text"; a failed transaction moved nothing.
          if (s.err === null && s.memo && s.memo.split(/[\s;]+/).includes(memo)) return s.signature as string;
        }
        if (list.length < 1000) return null;
        before = list[list.length - 1]!.signature;
      }
      throw new Error(`could not scan the recipient token account back to slot ${sinceSlot}`);
    },
  };
}

let gateway: SolanaGateway | null = null;

/** The gateway of this server's env (one per process). */
export function solanaGateway(): SolanaGateway {
  return (gateway ??= createSolanaGateway({ rpcUrl: env.SOLANA_RPC_URL, cluster: env.SOLANA_CLUSTER, mint: env.SOLANA_PAY_MINT }));
}
