import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { withRelay } from "viem/tempo";

import type { Call } from "./calls.js";

/**
 * 2D nonce lanes of the server keys (D3): each lane is an independent nonce sequence, so the platform can send a Pix
 * fulfilment, a verifier mark and a usage batch in parallel without blocking each other.
 */
export const NONCE_LANES = { platform: 1n, verifier: 2n, usage: 3n, admin: 4n } as const;

/**
 * HTTP transport to a public RPC. Public endpoints (Moderato among them) rate-limit bursts with JSON-RPC `-32005`, which
 * viem retries; the default (3 retries from 150 ms, ~1 s in total) is too short for a burst of server sends, so retries
 * back off from 250 ms over 6 attempts (~16 s).
 */
export function rpcTransport(url: string) {
  return http(url, { retryCount: 6, retryDelay: 250 });
}

export function publicClientFor(chain: Chain, rpcUrl?: string): PublicClient<Transport, Chain> {
  return createPublicClient({ chain, transport: rpcTransport(rpcUrl ?? chain.rpcUrls.default.http[0]!) });
}

/**
 * Wallet client for a user or agent account whose transactions are sponsored by the platform relay at `relayUrl`.
 * `sendTransaction({ calls, feePayer: true })` asks the relay to fill (gas, fee token) and co-sign, then broadcast.
 */
export function relayedWalletClient(
  account: Account,
  chain: Chain,
  relayUrl: string,
  rpcUrl?: string,
): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    account,
    chain,
    transport: withRelay(rpcTransport(rpcUrl ?? chain.rpcUrls.default.http[0]!), http(relayUrl), { policy: "sign-and-broadcast" }),
  });
}

/** Wallet client for a server key (PLATFORM / VERIFIER / admin CLI) that is sponsored in-process by `feePayer`. */
export function serverWalletClient(account: Account, chain: Chain, rpcUrl?: string): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ account, chain, transport: rpcTransport(rpcUrl ?? chain.rpcUrls.default.http[0]!) });
}

export type SendOptions = {
  /** In-process fee payer (RELAY key) for server-sent transactions; omit to let the sender pay. */
  feePayer?: Account | true;
  /** 2D nonce lane (`NONCE_LANES`). */
  nonceKey?: bigint;
  /** Explicit nonce within the lane (from the lane allocator); omitted = fetched from chain. */
  nonce?: number;
  /** Seconds until the transaction expires if not included (lets a stuck tx die). Default 120. */
  validitySecs?: number;
  /** Explicit gas limit (skip estimation). */
  gas?: bigint;
};

type SendingClient = { sendTransaction: (args: never) => Promise<Hex> };

/** Sends one Tempo 0x76 batch and returns its hash (does not wait). */
export async function sendCalls(client: SendingClient, calls: readonly Call[], o: SendOptions = {}): Promise<Hex> {
  const validBefore = Math.floor(Date.now() / 1000) + (o.validitySecs ?? 120);
  return client.sendTransaction({
    calls: calls.map((c) => ({ to: c.to, data: c.data })),
    ...(o.feePayer ? { feePayer: o.feePayer } : {}),
    ...(o.nonceKey !== undefined ? { nonceKey: o.nonceKey } : {}),
    ...(o.nonce !== undefined ? { nonce: o.nonce } : {}),
    ...(o.gas !== undefined ? { gas: o.gas } : {}),
    validBefore,
  } as never);
}

/** Waits for a receipt and throws if the transaction reverted. */
export async function waitForSuccess(
  client: { waitForTransactionReceipt: (args: { hash: Hex; timeout?: number }) => Promise<TransactionReceipt> },
  hash: Hex,
  timeoutMs = 60_000,
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}
