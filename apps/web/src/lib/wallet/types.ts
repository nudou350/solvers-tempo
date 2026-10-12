import type { Call } from "@solvers/shared";
import type { Address, Hex, LocalAccount } from "viem";

export type WalletKind = "privy" | "dev";
export type WalletStatus = "loading" | "disconnected" | "connected";

/** What `useWallet()` returns. Every component that signs or sends goes through this object. */
export type Wallet = {
  status: WalletStatus;
  address: Address | null;
  kind: WalletKind | null;
  /**
   * Opens the sign-in of the wallet (Privy e-mail login, or creates/loads the dev wallet) and resolves once a wallet is
   * connected, with its address. Resolves at once when that wallet is already connected. Default: the connected wallet,
   * else Privy when configured, else the dev wallet; pass `"dev"` to pick the test wallet explicitly. Reads live state, so
   * it is safe to call on a `Wallet` value from an earlier render.
   */
  connect(kind?: WalletKind): Promise<Address>;
  disconnect(): Promise<void>;
  /** EIP-191 `personal_sign` of a UTF-8 message; the 65-byte signature as hex. */
  signMessage(message: string): Promise<Hex>;
  /**
   * Sends the calls as ONE Tempo 0x76 batch whose network fee is paid by the platform relay (`POST /api/relay`, with the
   * session cookie), with `validBefore` set. Resolves with the transaction hash once it is broadcast.
   */
  sendCalls(calls: readonly Call[]): Promise<Hex>;
  /** Which wallet kinds this build offers (Privy configured; dev wallet allowed on this network). */
  available: { privy: boolean; dev: boolean };
  /** E-mail verified by Privy for the connected wallet, when there is one. */
  email: string | null;
  /**
   * E-mail of the source that is connected NOW (live, unlike `email`, which is the value of the last render): read it
   * right after `connect()`, before React re-renders.
   */
  liveEmail(): string | null;
  /** Privy identity token (for `/api/auth/privy/link`); null for the dev wallet or when Privy does not return one. */
  identityToken(): Promise<string | null>;
  /** Dev wallet only: forgets this browser's test key (the next connect creates another wallet). */
  forgetDevWallet(): void;
};

/** A wallet source as the provider sees it (the Privy bridge or the dev key). */
export type WalletSource = {
  kind: WalletKind;
  /** False while the SDK loads. */
  ready: boolean;
  address: Address | null;
  email: string | null;
  connect(): Promise<Address>;
  disconnect(): Promise<void>;
  /** viem account that signs for `address` (transactions serialized with the Tempo serializer). */
  account(): Promise<LocalAccount>;
  identityToken(): Promise<string | null>;
};
