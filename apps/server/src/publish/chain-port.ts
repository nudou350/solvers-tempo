import {
  approveAgentCalls,
  decodeSolversError,
  parseSolversEvents,
  publishAgentCalls,
  setRoyaltyBpsCalls,
  suspendAgentCalls,
  updateMetadataUriCalls,
  updatePricingCalls,
  updateVersionCalls,
  type Call,
} from "@solvers/chain";
import { solversRegistryAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, agentStatusName, type TxResponse } from "@solvers/shared";
import { erc20Abi, type Address, type Hex } from "viem";
import { chainContext } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { env } from "../env.js";
import { HttpError } from "../lib/http.js";
import {
  approvedPriceUnits,
  checkCreatorTx,
  fromChainHash,
  pricePerUseFor,
  registrationFor,
  termsDiffer,
  toChainHash,
  type ApprovedRecord,
  type ChainAgentState,
  type OnchainStatus,
  type TouchKind,
  type TxVerdict,
} from "./approval-rules.js";
import { processTxHash, syncAgent } from "../indexer/index.js";

// The single boundary between the publication module and the chain. Everything that needs RPC or a signature goes
// through `PublishChain`: the publication code (routes, finalization, approval, suspension) only talks to this
// interface, and the DB tests swap it for an in-memory one (test/helpers/fake-publish-chain.ts). The real implementation
// uses the chain context (`chainContext()`, initialized at boot by the API and by the CLIs; never by the worker).

/** Registry configuration that publication needs (token base units, bps). */
export type PublishConfig = { minStake: bigint; minPrice: bigint; platformRoyaltyBps: number };

export type PublishChain = {
  /** The agent on-chain (version, hash, price, status, creator), or `{ exists: false }`. */
  fetchAgentState(agentId: string): Promise<ChainAgentState>;
  /** Registry config: `registerAgent` pulls `minStake` from the creator; the royalty cap uses the platform share. */
  config(): Promise<PublishConfig>;
  /** Payment-token balance of a wallet (base units). */
  tokenBalance(wallet: string): Promise<bigint>;
  /** Simulates the batch as `wallet` (null = it would succeed; otherwise the decoded contract error). */
  simulate(wallet: string, calls: readonly Call[]): Promise<{ name: string; message: string } | null>;
  /** The batch the creator signs, built from the approved record only (the relay sponsors the fee). */
  buildRegister(wallet: string, agentId: string, approved: ApprovedRecord, opts?: { maxSupply?: number }): Promise<TxResponse>;
  buildUpdateVersion(wallet: string, agentId: string, approved: ApprovedRecord, chain: ChainAgentState): Promise<TxResponse>;
  /** Price and terms (royalty while editable; pay-per-use and metadata URI as `nextPublicationStep` compares them). */
  buildUpdatePricing(wallet: string, agentId: string, approved: ApprovedRecord, chain: ChainAgentState): Promise<TxResponse>;
  /**
   * Confirmation by tx hash: the receipt succeeded, was sent by `creatorWallet` and its Registry events for this agent
   * match the approved record (see `checkCreatorTx`).
   */
  verifyCreatorTx(txHash: string, agentId: string, expected: { creatorWallet: string; approved: ApprovedRecord; kind?: TouchKind }): Promise<TxVerdict>;
  /** Admin operations (cold key; only the `cli:approve` / `cli:suspend` CLIs hold it). Addresses lowercase. */
  adminAddress(): Promise<string | null>;
  onchainAdmin(): Promise<string>;
  /** Signs and sends through the admin nonce lane, fee sponsored by RELAY (D20). Returns the confirmed tx hash. */
  approveAgent(agentId: string): Promise<string>;
  suspendAgent(agentId: string): Promise<string>;
  /** Mirrors the agent's chain state onto its row (the indexer's `syncAgent`). */
  syncAgent(agentId: string): Promise<void>;
  /** Hands a confirmed tx hash to the indexer (idempotent). */
  indexTx(txHash: string): Promise<void>;
};

export function metadataUri(agentId: string): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/agents/${agentId}/metadata.json`;
}

const STATUS = (code: number): OnchainStatus => agentStatusName(code);

function txResponse(calls: Call[]): TxResponse {
  return { calls: calls.map((c) => ({ to: c.to.toLowerCase() as Address, data: c.data })), feePayer: true, chainId: chainContext().chain.id };
}

async function readAgent(agentId: string): Promise<ChainAgentState> {
  const c = chainContext();
  const reg = { address: c.deployment.registry, abi: solversRegistryAbi } as const;
  const id = agentIdToBytes32(agentId);
  if (!(await c.publicClient.readContract({ ...reg, functionName: "agentExists", args: [id] }))) return { exists: false };
  const a = await c.publicClient.readContract({ ...reg, functionName: "getAgent", args: [id] });
  return {
    exists: true,
    creator: a.creator.toLowerCase(),
    version: a.version,
    versionHash: fromChainHash(a.versionHash),
    price: a.price,
    status: STATUS(a.status),
    pricePerUse: a.pricePerUse,
    metadataUri: a.metadataUri,
    royaltyBps: a.royaltyBps,
    totalSales: a.totalSales,
    maxSupply: a.maxSupply,
    stake: a.stake,
    disputesLost: a.disputesLost,
    index: a.index,
  };
}

async function readConfig(): Promise<PublishConfig> {
  const c = chainContext();
  const [, , platformRoyaltyBps, , minStake, minPrice] = await c.publicClient.readContract({
    address: c.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "config",
  });
  return { minStake, minPrice, platformRoyaltyBps };
}

/**
 * Calls that bring price and terms to the approved record: `updatePricing` (when the price or a fixed pay-per-use price
 * differs; it carries the creator's current pay-per-use price otherwise, never 0, see `pricePerUseFor`), `setRoyaltyBps`
 * (only before the first sale: RoyaltyLocked afterwards) and `updateMetadataUri` (when the record fixes the URI).
 */
export function termsCalls(agentId: string, approved: ApprovedRecord, chain: ChainAgentState, opts: { alwaysPrice?: boolean } = {}): Call[] {
  const d = chainContext().deployment;
  const id = agentIdToBytes32(agentId);
  const calls: Call[] = [];
  const terms = termsDiffer(approved, chain);
  const priceDiffers = !chain.exists || chain.price !== approvedPriceUnits(approved);
  // `alwaysPrice` (the update-pricing step): never an empty batch, even if only the royalty/URI were left.
  const otherTerms = terms.royalty || terms.metadataUri;
  if (priceDiffers || terms.pricePerUse || (opts.alwaysPrice && !otherTerms)) {
    calls.push(...updatePricingCalls(d, { agentId: id, price: approvedPriceUnits(approved), pricePerUse: pricePerUseFor(approved, chain) }));
  }
  if (terms.royalty) calls.push(...setRoyaltyBpsCalls(d, { agentId: id, royaltyBps: approved.royaltyBps }));
  if (terms.metadataUri && approved.metadataUri) calls.push(...updateMetadataUriCalls(d, { agentId: id, metadataUri: approved.metadataUri }));
  return calls;
}

export function realPublishChain(): PublishChain {
  return {
    fetchAgentState: readAgent,
    config: readConfig,
    async tokenBalance(wallet) {
      const c = chainContext();
      return c.publicClient.readContract({ address: c.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [wallet as Address] });
    },
    async simulate(wallet, calls) {
      const c = chainContext();
      try {
        await c.publicClient.estimateGas({ account: wallet as Address, calls: calls.map((x) => ({ to: x.to, data: x.data })) } as never);
        return null;
      } catch (e) {
        const d = decodeSolversError(e);
        // Infrastructure failures (RPC down) are not a contract refusal: let the wallet try and report the real error.
        if (d.name === "Unknown" && !/revert/i.test((e as Error)?.message ?? "")) return null;
        return { name: d.name, message: d.message };
      }
    },
    async buildRegister(_wallet, agentId, approved, opts = {}) {
      const c = chainContext();
      const { minStake } = await readConfig();
      const calls = publishAgentCalls(c.deployment, {
        registration: registrationFor(agentId, approved, metadataUri(agentId)),
        minStake,
        ...(opts.maxSupply ? { maxSupply: opts.maxSupply } : {}),
      });
      return txResponse(calls);
    },
    async buildUpdateVersion(_wallet, agentId, approved, chain) {
      const d = chainContext().deployment;
      // One signature for the whole update: the version, and the price/terms when the approved record changed them.
      const calls = updateVersionCalls(d, { agentId: agentIdToBytes32(agentId), version: approved.version, versionHash: toChainHash(approved.versionHash) });
      calls.push(...termsCalls(agentId, approved, chain));
      return txResponse(calls);
    },
    async buildUpdatePricing(_wallet, agentId, approved, chain) {
      return txResponse(termsCalls(agentId, approved, chain, { alwaysPrice: true }));
    },
    async verifyCreatorTx(txHash, agentId, expected) {
      const c = chainContext();
      let receipt;
      try {
        receipt = await c.publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 30_000 });
      } catch {
        return { ok: false, reason: "transaction not found on the network (yet)" };
      }
      const events = parseSolversEvents(receipt.logs, c.deployment)
        .filter((e) => e.contract === "registry")
        .map((e) => ({ name: e.eventName as string, args: e.args as unknown as Record<string, unknown> }));
      return checkCreatorTx({ events, from: receipt.from, success: receipt.status === "success" }, { agentId, ...expected });
    },
    async adminAddress() {
      return chainContext().accounts.admin?.address.toLowerCase() ?? null;
    },
    async onchainAdmin() {
      const c = chainContext();
      const admin = await c.publicClient.readContract({ address: c.deployment.registry, abi: solversRegistryAbi, functionName: "defaultAdmin" });
      return admin.toLowerCase();
    },
    async approveAgent(agentId) {
      const c = chainContext();
      const r = await sendServerCalls({
        signer: "admin",
        lane: "admin",
        calls: approveAgentCalls(c.deployment, agentIdToBytes32(agentId)),
        kind: "admin-approve-agent",
        ref: agentId,
      });
      return r.hash;
    },
    async suspendAgent(agentId) {
      const c = chainContext();
      const r = await sendServerCalls({
        signer: "admin",
        lane: "admin",
        calls: suspendAgentCalls(c.deployment, agentIdToBytes32(agentId)),
        kind: "admin-suspend-agent",
        ref: agentId,
      });
      return r.hash;
    },
    async syncAgent(agentId) {
      await syncAgent(agentId);
    },
    async indexTx(hash) {
      await processTxHash(hash as Hex);
    },
  };
}

/** Turns a failed simulation into the HTTP refusal the creator sees (409 with the contract error name). */
export function simulationRefused(err: { name: string; message: string }): HttpError {
  return new HttpError(409, err.message, "simulation_failed", { error: err.name });
}

let override: PublishChain | null = null;

/** Swaps the boundary (tests). `null` restores the real implementation. */
export function setPublishChain(port: PublishChain | null): void {
  override = port;
}

export function publishChain(): PublishChain {
  return override ?? realPublishChain();
}
