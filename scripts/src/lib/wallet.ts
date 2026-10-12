// A test user wallet driving the API like the web app does: SIWE sign-in (EIP-4361), then every on-chain action is a
// Tempo 0x76 batch signed by the wallet and sponsored by the platform relay (POST /api/relay, `feePayer: true`), then
// `/api/tx/confirm` so the server indexes it at once.
import { sendCalls, waitForSuccess, type Call } from "@solvers/chain";
import { MEMORY_KEY_MESSAGE } from "@solvers/shared";
import { createWalletClient, http, type Account, type Chain, type Hex, type TransactionReceipt, type Transport, type WalletClient } from "viem";
import { withRelay } from "viem/tempo";
import type { PrivateKeyAccount } from "viem/accounts";
import { API_URL, network, sleep } from "../env.js";
import { get, post, request } from "./http.js";

export type Confirmed = { txHash: Hex; status: string; events?: { name: string; contract: string; args: Record<string, unknown> }[]; explorerUrl?: string | null };

export class TestWallet {
  token = "";
  constructor(
    readonly account: PrivateKeyAccount,
    readonly label = "wallet",
  ) {}

  get address(): `0x${string}` {
    return this.account.address;
  }
  get lower(): string {
    return this.account.address.toLowerCase();
  }

  /** SIWE sign-in: signs the server-built message of `/api/auth/nonce` and keeps the session token (Bearer). */
  async login(): Promise<this> {
    const n = await get<{ message: string }>(`/api/auth/nonce?address=${this.address}`);
    const signature = await this.account.signMessage({ message: n.message });
    const res = await post<{ wallet: string; token?: string }>("/api/auth/verify", undefined, { message: n.message, signature, returnToken: true });
    if (!res.token) throw new Error(`login did not return a token: ${JSON.stringify(res)}`);
    if (res.wallet.toLowerCase() !== this.lower) throw new Error(`login returned another wallet: ${res.wallet}`);
    this.token = res.token;
    return this;
  }

  get<T = any>(path: string) {
    return get<T>(path, this.token);
  }
  post<T = any>(path: string, body?: unknown) {
    return post<T>(path, this.token, body);
  }
  request<T = any>(method: string, path: string, body?: unknown) {
    return request<T>(method, path, { token: this.token, ...(body !== undefined ? { body } : {}) });
  }

  /** EIP-191 signature of the memory-key message (D8). */
  memorySignature(): Promise<Hex> {
    return this.account.signMessage({ message: MEMORY_KEY_MESSAGE });
  }

  /** viem wallet client whose fee is paid by the platform relay; the relay authenticates the session token. */
  async relayClient(token = this.token): Promise<WalletClient<Transport, Chain, Account>> {
    const n = await network();
    if (!token) throw new Error(`${this.label}: sign in before using the relay`);
    return createWalletClient({
      account: this.account as Account,
      chain: n.chain,
      transport: withRelay(http(n.rpcUrl), http(`${API_URL}/api/relay`, { fetchOptions: { headers: { authorization: `Bearer ${token}` } } }), {
        policy: "sign-and-broadcast",
      }),
    });
  }

  /** Sends one sponsored batch and waits for success (throws on revert or relay refusal). */
  async send(calls: readonly Call[], token = this.token): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    const n = await network();
    const client = await this.relayClient(token);
    const hash = await sendCalls(client as never, calls, { feePayer: true });
    const receipt = await waitForSuccess(n.publicClient as never, hash, 90_000);
    return { hash, receipt };
  }

  /** Sends the batch through the relay, then asks the server to confirm and index it. */
  async sendAndConfirm(calls: readonly Call[]): Promise<Confirmed & { receipt: TransactionReceipt }> {
    const { hash, receipt } = await this.send(calls);
    const c = await confirm(this.token, hash);
    if (c.status !== "confirmed") throw new Error(`confirm ${hash}: ${JSON.stringify(c)}`);
    return { ...c, receipt };
  }
}

/** `/api/tx/confirm`, retried while the server answers 202 (receipt not seen yet), waiting between attempts. */
export async function confirm(token: string, txHash: Hex, attempts = 6, delayMs = 1500): Promise<Confirmed> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs * i);
    const c = await post<Confirmed & { code?: string }>("/api/tx/confirm", token, { txHash });
    if (c.code !== "pending") return c;
  }
  throw new Error(`confirm ${txHash}: still pending after ${attempts} attempts`);
}

/** Fee payer recorded in a 0x76 receipt (the relay address when sponsored). */
export const feePayerOf = (r: TransactionReceipt): string => String((r as unknown as { feePayer?: string }).feePayer ?? "").toLowerCase();
