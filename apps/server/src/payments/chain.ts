import { parseSolversEvents, type SolversLog } from "@solvers/chain";
import { solversEscrowAbi, solversLicenseAbi, solversRegistryAbi } from "@solvers/contracts-client";
import { PAUSE_FLAGS, PURCHASE_KIND, agentIdToBytes32, isPaused, purchaseKindCode, type ChargeKind } from "@solvers/shared";
import { erc20Abi, type Hex, type Log } from "viem";

import { chainContext } from "../chain/index.js";
import { decodePurchaseRef } from "./lifecycle.js";

// On-chain reads of the payments module (always authoritative: the DB mirror can lag behind the indexer).

export type ChainAgent = {
  creator: `0x${string}`;
  status: number;
  price: bigint;
  pricePerUse: bigint;
  totalSales: number;
  maxSupply: number;
  disputesLost: number;
  version: string;
  versionHash: `0x${string}`;
};

export async function readAgent(agentId: string): Promise<ChainAgent | null> {
  const c = chainContext();
  const a = await c.publicClient.readContract({
    address: c.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "getAgent",
    args: [agentIdToBytes32(agentId)],
  });
  if (/^0x0{40}$/i.test(a.creator)) return null;
  return {
    creator: a.creator.toLowerCase() as `0x${string}`,
    status: a.status,
    price: a.price,
    pricePerUse: a.pricePerUse,
    totalSales: a.totalSales,
    maxSupply: a.maxSupply,
    disputesLost: a.disputesLost,
    version: a.version,
    versionHash: a.versionHash,
  };
}

export async function readPauseFlags(): Promise<number> {
  const c = chainContext();
  return c.publicClient.readContract({ address: c.deployment.registry, abi: solversRegistryAbi, functionName: "pauseFlags" });
}

export async function entriesPaused(): Promise<boolean> {
  return isPaused(await readPauseFlags(), PAUSE_FLAGS.ENTRIES);
}

export async function readMinPrice(): Promise<bigint> {
  const c = chainContext();
  const [, , , minPrice] = await c.publicClient.readContract({
    address: c.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "paymentParams",
  });
  return minPrice;
}

/** `purchaseRef(payer, purchaseId)` (X22): `kind << 248 | ref`, 0 when the id was never used by `payer`. */
export async function readPurchaseRef(payer: string, purchaseId: string): Promise<bigint> {
  const c = chainContext();
  const ref = await c.publicClient.readContract({
    address: c.deployment.registry,
    abi: solversRegistryAbi,
    functionName: "purchaseRef",
    args: [payer as Hex, purchaseId as Hex],
  });
  return BigInt(ref);
}

export async function tokenBalance(account: string): Promise<bigint> {
  const c = chainContext();
  return c.publicClient.readContract({ address: c.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [account as Hex] });
}

/**
 * Does an on-chain `purchaseRef` belong to this charge (same kind, agent and buyer)? License: the token's agent (the
 * original buyer is not stored, but the id is scoped by payer and derived from our charge id, so only our `*For` call or
 * the buyer's own batch can have used it); credits: the ref is the buyer; escrow: buyer and agent of the escrow.
 */
export async function refMatches(charge: { kind: string; agentId: string; buyerWallet: string }, ref: bigint): Promise<boolean> {
  const { kind, value } = decodePurchaseRef(ref);
  if (kind !== purchaseKindCode(charge.kind as ChargeKind)) return false;
  const c = chainContext();
  const agent32 = agentIdToBytes32(charge.agentId).toLowerCase();
  if (kind === PURCHASE_KIND.Credits) return value === BigInt(charge.buyerWallet);
  if (kind === PURCHASE_KIND.License) {
    const [agentId] = await c.publicClient.readContract({
      address: c.deployment.license,
      abi: solversLicenseAbi,
      functionName: "licenseOf",
      args: [value],
    });
    return agentId.toLowerCase() === agent32;
  }
  const e = await c.publicClient.readContract({ address: c.deployment.escrow, abi: solversEscrowAbi, functionName: "escrowOf", args: [value] });
  return e[0].toLowerCase() === charge.buyerWallet.toLowerCase() && e[1].toLowerCase() === agent32;
}

export type SaleDetails = {
  purchaseId: Hex;
  agentId: Hex;
  buyer: `0x${string}`;
  payer: `0x${string}`;
  kind: number;
  /** `kind << 248 | ref`, as `purchaseRef` returns it. */
  ref: bigint;
  txHash: Hex;
  logIndex: number;
  gross: bigint | null;
  fee: bigint | null;
  creatorAmount: bigint | null;
  creatorDeferred: boolean | null;
};

/** The sale of `purchaseId` (paid by `payer`) inside a receipt's logs, with the amounts of its sibling event. */
export function saleFromLogs(logs: readonly Log[], purchaseId: string, payer?: string): SaleDetails | null {
  return saleFromEvents(parseSolversEvents(logs, chainContext().deployment), purchaseId, payer);
}

/**
 * The sale of `purchaseId` among the decoded Solvers events of one transaction (no RPC: the indexer passes the events it
 * already holds), with the amounts of its sibling `LicensePurchased` / `CreditsBought` / `EscrowCreated`.
 */
export function saleFromEvents(events: readonly SolversLog[], purchaseId: string, payer?: string): SaleDetails | null {
  const pid = purchaseId.toLowerCase();
  const sale = events.find(
    (e) =>
      e.eventName === "SaleAuthorized" &&
      e.args.purchaseId.toLowerCase() === pid &&
      (!payer || e.args.payer.toLowerCase() === payer.toLowerCase()),
  );
  if (!sale || sale.eventName !== "SaleAuthorized") return null;
  const out: SaleDetails = {
    purchaseId: sale.args.purchaseId,
    agentId: sale.args.agentId,
    buyer: sale.args.buyer.toLowerCase() as `0x${string}`,
    payer: sale.args.payer.toLowerCase() as `0x${string}`,
    kind: sale.args.kind,
    ref: (BigInt(sale.args.kind) << 248n) | BigInt(sale.args.ref),
    txHash: sale.transactionHash!,
    logIndex: sale.logIndex!,
    gross: null,
    fee: null,
    creatorAmount: null,
    creatorDeferred: null,
  };
  for (const e of events) {
    if (e.eventName === "LicensePurchased" && e.args.purchaseId.toLowerCase() === pid) {
      Object.assign(out, { gross: e.args.price, fee: e.args.fee, creatorAmount: e.args.creatorAmount, creatorDeferred: e.args.creatorDeferred });
    } else if (e.eventName === "CreditsBought" && e.args.purchaseId.toLowerCase() === pid) {
      Object.assign(out, { gross: e.args.total, fee: e.args.fee, creatorAmount: e.args.creatorAmount, creatorDeferred: e.args.creatorDeferred });
    } else if (e.eventName === "EscrowCreated" && e.args.purchaseId.toLowerCase() === pid) {
      // The fee of a guarantee is charged per milestone at release; the escrow holds the whole total meanwhile.
      Object.assign(out, { gross: e.args.total });
    }
  }
  return out;
}

