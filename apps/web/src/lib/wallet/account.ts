// A viem account for a wallet that can only sign raw hashes and messages (the Privy embedded wallet exposes
// `secp256k1_sign` and `personal_sign`). Transactions are serialized here, with the chain's Tempo serializer, exactly as
// viem's `privateKeyToAccount` does (serialize -> keccak256 -> sign the hash -> serialize with the signature), so the
// Privy path and the dev wallet path produce byte-identical transactions for the same key (unit-tested).
import { keccak256, parseSignature, type Address, type Hex, type LocalAccount, type SignableMessage, type TransactionSerializable } from "viem";
import { toAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";

export type HashSigner = {
  address: Address;
  /** Signs a 32-byte hash with the wallet key, no prefix (secp256k1). Returns the 65-byte signature as hex. */
  signHash(hash: Hex): Promise<Hex>;
  /** EIP-191 `personal_sign` of a message. */
  signMessage(message: SignableMessage): Promise<Hex>;
  /** EIP-712 typed data (optional; used only by permit-style flows). */
  signTypedData?: LocalAccount["signTypedData"];
};

type Serializer = (tx: TransactionSerializable, signature?: ReturnType<typeof parseSignature>) => Promise<Hex> | Hex;

export function hashSignerAccount(s: HashSigner): LocalAccount {
  return toAccount({
    address: s.address,
    sign: ({ hash }) => s.signHash(hash),
    signMessage: ({ message }) => s.signMessage(message),
    signTypedData:
      s.signTypedData ??
      (() => {
        throw new Error("typed-data signing is not supported by this wallet");
      }),
    async signTransaction(transaction, options) {
      const serialize = (options?.serializer ?? (Transaction.serialize as unknown as Serializer)) as Serializer;
      const hash = keccak256(await serialize(transaction as TransactionSerializable));
      const signature = parseSignature(await s.signHash(hash));
      return (await serialize(transaction as TransactionSerializable, signature)) as never;
    },
  });
}
