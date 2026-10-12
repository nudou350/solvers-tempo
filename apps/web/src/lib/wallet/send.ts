// Sends ONE Tempo 0x76 batch whose network fee is paid by the platform relay (decisions.md D3): the wallet client's
// transport is viem's `withRelay` (public RPC + `POST /api/relay` with the session cookie). The relay fills gas and
// fee token and co-signs as fee payer; then the wallet signs as sender and the transaction is broadcast.
//
// When the relay declines to sponsor (policy, quota or a simulated revert), viem's relay returns an UNSPONSORED fill and
// the wallet would pay the fee itself. This module refuses that case before the wallet signs anything
// (`SponsorDeclinedError`), so a person never pays a network fee by surprise.
import { getChain } from "@solvers/chain/browser";
import type { Call } from "@solvers/shared";
import { createWalletClient, http, type Account, type Hex } from "viem";
import { withRelay } from "viem/tempo";

/**
 * Seconds the signed transaction stays valid (`validBefore`), counted on the SERVER's clock: the relay accepts at most
 * `now + 120` by its own clock, so 60 leaves room for the round trips and for a few seconds of offset error.
 */
export const VALIDITY_SECS = 60;

/** Offset (seconds) to add to this device's clock to get the server's, from `PublicConfig.serverTime` received at `localMs`. */
export function clockOffsetSecs(serverTime: number, localMs: number): number {
  return Number.isFinite(serverTime) && serverTime > 0 ? serverTime - Math.floor(localMs / 1000) : 0;
}

/** A clock in unix seconds that follows the server's (this device's clock plus the measured offset). */
export function serverClock(offsetSecs: number, localNowMs: () => number = Date.now): () => number {
  return () => Math.floor(localNowMs() / 1000) + offsetSecs;
}

export class SponsorDeclinedError extends Error {
  readonly code = "sponsor_declined";
  constructor() {
    super("The platform did not sponsor this transaction's network fee.");
  }
}

export type SendSponsoredInput = {
  account: Account;
  chainId: number;
  /** Public RPC of the chain (`PublicConfig.rpcUrl`). */
  rpcUrl: string;
  /** Absolute URL of `POST /api/relay`. */
  relayUrl: string;
  calls: readonly Call[];
  /**
   * The server's clock in unix seconds (`serverClock(offset)` from the public config). Without it this device's clock is
   * used, which the relay refuses (or accepts already expired) when the device clock is off by about a minute or more.
   */
  nowSecs?: () => number;
};

/** True when a filled Tempo request carries the fee payer's co-signature (the relay agreed to pay the fee). */
export function isSponsoredFill(request: unknown): boolean {
  const sig = (request as { feePayerSignature?: unknown } | null)?.feePayerSignature;
  return typeof sig === "object" && sig !== null;
}

export async function sendSponsoredCalls(i: SendSponsoredInput): Promise<Hex> {
  if (i.calls.length === 0) throw new Error("no calls to send");
  const chain = getChain(i.chainId, i.rpcUrl);
  const client = createWalletClient({
    account: i.account,
    chain,
    transport: withRelay(http(i.rpcUrl), http(i.relayUrl, { fetchOptions: { credentials: "include" } }), { policy: "sign-and-broadcast" }),
  });
  const now = i.nowSecs ?? (() => Math.floor(Date.now() / 1000));
  const request = await client.prepareTransactionRequest({
    calls: i.calls.map((c) => ({ to: c.to, data: c.data })),
    feePayer: true,
    validBefore: now() + VALIDITY_SECS,
  } as never);
  if (!isSponsoredFill(request)) throw new SponsorDeclinedError();
  const serializedTransaction = await client.signTransaction(request as never);
  return client.sendRawTransaction({ serializedTransaction });
}
