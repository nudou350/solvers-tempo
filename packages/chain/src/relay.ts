import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, decodeFunctionData, erc20Abi, http, toFunctionSelector, type Address, type Chain, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { Relay, Transaction } from "viem/tempo";
import { rpcTransport } from "./send.js";

/**
 * Sponsorship policy of the platform relay (decision D3). The relay pays fees only for Tempo transactions that touch our
 * contracts, at a bounded price, in our fee token, so a leaked endpoint cannot be used as free gas or to drain the RELAY
 * key.
 *
 * How viem's relay sponsors (viem 2.57 `tempo/internal/relay/feePayer.ts`, `request.ts`, `Transport.ts`): a client using
 * `withRelay(http(rpc), http(relay))` sends `eth_fillTransaction` to the relay; the relay fills gas/fees, runs `validate`
 * and returns the fill ALREADY co-signed by the fee payer (before the sender signs); the client then signs and broadcasts
 * through the public RPC. The fee-payer signature covers the sender address and every field of the fill, so the sender
 * cannot change calls, gas, fees or token afterwards, but the co-signed fill can be broadcast by the sender until
 * `validBefore`. Raw sends (`eth_sendRawTransaction*`) that still lack the fee-payer signature are validated and co-signed
 * the same way. Quotas are therefore counted at sponsorship time (fill or raw), keyed by the fee-payer `signPayload`.
 */
export type RelayPolicy = {
  chainId: number;
  /** The six Solvers contracts. */
  contracts: readonly Address[];
  /** Payment token: `approve` / `permit` allowed only towards our contracts. */
  token: Address;
  /** Gas limit cap per sponsored transaction (`RELAY_MAX_GAS_PER_TX`). */
  maxGasPerTx: bigint;
  /** Cap on `maxFeePerGas` (and on `gas × maxFeePerGas`, i.e. the worst-case fee) of a sponsored transaction. */
  maxFeePerGas: bigint;
  /** Cap on `maxPriorityFeePerGas`. */
  maxPriorityFeePerGas: bigint;
  /** The only fee token the sponsor pays in (a client-chosen token is refused). */
  feeToken: Address;
  /** `validBefore` must be set and at most this far in the future (seconds). Default 120. */
  maxValiditySecs?: number;
  /** Maximum calls per batch. Default 4. */
  maxCalls?: number;
};

export type RelayVerdict = { ok: true } | { ok: false; reason: string };

const APPROVE = toFunctionSelector("approve(address,uint256)");
const PERMIT = toFunctionSelector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)");
const permitAbi = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** The fields of a Tempo transaction request the policy looks at. */
export type SponsoredTx = {
  chainId?: number | Hex | undefined;
  from?: Address | undefined;
  calls?: readonly { to?: Address | null | undefined; data?: Hex | undefined; value?: bigint | undefined }[] | undefined;
  gas?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
  feeToken?: Address | bigint | null | undefined;
  validBefore?: number | bigint | undefined;
  validAfter?: number | bigint | undefined;
  authorizationList?: readonly unknown[] | undefined;
  keyAuthorization?: unknown;
};

/** Pure D3 checks (chain, calls, targets, token selectors and spender, gas and fee caps, fee token, validity window). */
export function checkSponsoredTransaction(tx: SponsoredTx, policy: RelayPolicy, nowSecs: number): RelayVerdict {
  const ours = new Set(policy.contracts.map((a) => a.toLowerCase()));
  const token = policy.token.toLowerCase();
  if (Number(tx.chainId) !== policy.chainId) return { ok: false, reason: "wrong chain" };
  if (tx.authorizationList && tx.authorizationList.length > 0) return { ok: false, reason: "authorization list not sponsored" };
  if (tx.keyAuthorization !== undefined && tx.keyAuthorization !== null) return { ok: false, reason: "key authorization not sponsored" };
  if (tx.feeToken !== undefined && tx.feeToken !== null && String(tx.feeToken).toLowerCase() !== policy.feeToken.toLowerCase()) {
    return { ok: false, reason: "fee token not allowed" };
  }
  const calls = tx.calls ?? [];
  if (calls.length < 1 || calls.length > (policy.maxCalls ?? 4)) return { ok: false, reason: "call count" };
  for (const c of calls) {
    if (c.value && c.value !== 0n) return { ok: false, reason: "value must be 0" };
    const to = c.to?.toLowerCase();
    if (!to) return { ok: false, reason: "contract creation is not sponsored" };
    if (ours.has(to)) continue;
    if (to !== token || !c.data) return { ok: false, reason: `target not allowed: ${to}` };
    const selector = c.data.slice(0, 10).toLowerCase();
    try {
      if (selector === APPROVE) {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
        if (!ours.has(String(args[0]).toLowerCase())) return { ok: false, reason: "approve spender not allowed" };
      } else if (selector === PERMIT) {
        const { args } = decodeFunctionData({ abi: permitAbi, data: c.data });
        if (!ours.has(String(args[1]).toLowerCase())) return { ok: false, reason: "permit spender not allowed" };
      } else {
        return { ok: false, reason: "token call not allowed" };
      }
    } catch {
      return { ok: false, reason: "undecodable token call" };
    }
  }
  if (tx.gas === undefined || tx.gas > policy.maxGasPerTx) return { ok: false, reason: "gas limit above the cap" };
  if (tx.maxFeePerGas !== undefined && tx.maxFeePerGas > policy.maxFeePerGas) return { ok: false, reason: "fee per gas above the cap" };
  if (tx.maxPriorityFeePerGas !== undefined && tx.maxPriorityFeePerGas > policy.maxPriorityFeePerGas) {
    return { ok: false, reason: "priority fee above the cap" };
  }
  const vb = tx.validBefore === undefined ? undefined : Number(tx.validBefore);
  if (vb === undefined || vb === 0) return { ok: false, reason: "validBefore required" };
  if (vb > nowSecs + (policy.maxValiditySecs ?? 120)) return { ok: false, reason: "validBefore too far" };
  if (vb <= nowSecs) return { ok: false, reason: "expired" };
  if (tx.validAfter !== undefined && Number(tx.validAfter) > nowSecs) return { ok: false, reason: "validAfter in the future" };
  return { ok: true };
}

/** Who is asking (set by the server route from the session JWT and the request). */
export type RelayRequestContext = { sender?: Address | undefined; ip?: string | undefined };

export type SponsorRelayOptions = {
  chain: Chain;
  rpcUrl: string;
  /** RELAY key: pays fees only, holds no contract role (D11). */
  feePayer: LocalAccount;
  policy: RelayPolicy;
  /**
   * Extra async checks with the request context: sender == session wallet, per-wallet/IP quotas, simulation. Return a
   * refusal reason or null.
   */
  check?: (tx: SponsoredTx, ctx: RelayRequestContext) => Promise<string | null>;
  /** Called after the fee payer signed and before the fill/raw tx is returned or broadcast (write `relay_log`; a throw aborts). */
  onSponsored?: (event: Relay.feePayer.SponsoredEvent, ctx: RelayRequestContext) => Promise<void> | void;
  /** Called with every refusal (logging). */
  onRefused?: (reason: string, tx: SponsoredTx | null, ctx: RelayRequestContext) => void;
  now?: () => number;
};

/** JSON-RPC methods the relay answers; everything else is refused (the relay is not a general RPC proxy). */
export const RELAY_METHODS = new Set(["eth_chainId", "eth_fillTransaction", "eth_sendRawTransaction", "eth_sendRawTransactionSync"]);

type JsonRpcRequest = { jsonrpc?: string; id?: number | string | null; method: string; params?: readonly unknown[] };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };

/**
 * The platform relay (D3): a viem `Relay` whose fee-payer plugin co-signs Tempo 0x76 transactions that pass the policy
 * and the server's `check`. `handle(body, ctx)` answers one JSON-RPC request or a batch; serve it behind authentication
 * and pass the session wallet and IP as `ctx`.
 */
export function createSponsorRelay(o: SponsorRelayOptions) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const als = new AsyncLocalStorage<RelayRequestContext>();
  const relay = Relay.create({
    client: createClient({ chain: o.chain, transport: rpcTransport(o.rpcUrl) }) as never,
    plugins: [
      Relay.feePayer({
        account: o.feePayer,
        feeToken: o.policy.feeToken,
        validate: async (tx) => {
          const ctx = als.getStore() ?? {};
          const t = tx as unknown as SponsoredTx;
          const verdict = checkSponsoredTransaction(t, o.policy, now());
          if (!verdict.ok) {
            o.onRefused?.(verdict.reason, t, ctx);
            return false;
          }
          const extra = o.check ? await o.check(t, ctx) : null;
          if (extra) {
            o.onRefused?.(extra, t, ctx);
            return false;
          }
          return true;
        },
        onSponsored: async (event) => {
          await o.onSponsored?.(event, als.getStore() ?? {});
        },
      }),
    ],
  });

  async function one(req: JsonRpcRequest, ctx: RelayRequestContext): Promise<JsonRpcResponse> {
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    const id = req.id ?? null;
    if (typeof req.method !== "string" || !RELAY_METHODS.has(req.method)) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported by the relay" } };
    }
    // The relay is not a broadcast proxy: raw transactions must ask for sponsorship (Tempo 0x76 with an empty fee-payer
    // signature); anything else goes to the public RPC directly.
    if ((req.method === "eth_sendRawTransaction" || req.method === "eth_sendRawTransactionSync") && !requestsSponsorship(req.params)) {
      o.onRefused?.("raw transaction without a sponsorship request", null, ctx);
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Only sponsored Tempo transactions are accepted" } };
    }
    try {
      const result = await als.run(ctx, () => relay.request({ method: req.method, params: req.params }));
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      const err = e as { code?: number; message?: string; data?: unknown; shortMessage?: string };
      return {
        jsonrpc: "2.0",
        id,
        error: { code: typeof err.code === "number" ? err.code : -32000, message: err.shortMessage ?? err.message ?? "relay error", ...(err.data !== undefined ? { data: err.data } : {}) },
      };
    }
  }

  return {
    /** Answers a parsed JSON-RPC body (single request or batch of up to 10). */
    async handle(body: unknown, ctx: RelayRequestContext): Promise<JsonRpcResponse | JsonRpcResponse[]> {
      if (Array.isArray(body)) {
        if (body.length === 0 || body.length > 10) {
          return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch" } };
        }
        // Each call gets its own context copy (per-call state such as a quota reservation must not be shared).
        return Promise.all(body.map((r) => one(r as JsonRpcRequest, { ...ctx })));
      }
      return one(body as JsonRpcRequest, { ...ctx });
    },
  };
}

/** True when `params[0]` is a serialized Tempo transaction explicitly requesting sponsorship (same rule as viem's relay). */
export function requestsSponsorship(params: unknown): boolean {
  const serialized = Array.isArray(params) ? params[0] : undefined;
  if (typeof serialized !== "string" || !serialized.startsWith("0x76")) return false;
  try {
    const tx = Transaction.deserialize(serialized as Hex) as Record<string, unknown>;
    return "feePayerSignature" in tx && tx.feePayerSignature === null;
  } catch {
    return false;
  }
}
