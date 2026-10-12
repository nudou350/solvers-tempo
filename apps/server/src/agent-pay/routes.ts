import { Router, type NextFunction, type Request, type Response } from "express";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { Credential } from "mppx";
import { numberToUnits, type AgentPayConfig } from "@solvers/shared";
import { parseEventLogs, type Hex } from "viem";
import { Abis, Transaction } from "viem/tempo";

import { chainContext, explorerUrl } from "../chain/index.js";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { HttpError, badRequest, h, notFound } from "../lib/http.js";
import { initPayments, registerProvider } from "../payments/index.js";
import { assertLicenseSellable, findAgent, sellableAgent } from "../payments/intent.js";
import { readMinPrice } from "../payments/chain.js";
import { decodePurchaseRef } from "../payments/lifecycle.js";
import { expiresAtOf, loadCharge, payloadOf, type LedgerRow } from "../payments/ledger.js";
import { isRowSoldOut } from "../store/supply-rules.js";
import { challengeIssuedHere, chargeOrder, initMpp } from "./mpp.js";
import { AgentPayProvider, decodeTransferCall } from "./provider.js";
import { MAX_OPEN_ORDERS_PER_IP, UNKNOWN_BUYER, chargeIdOfCredential, memoBoundTo, priceBounds, priceInBounds } from "./rules.js";

// License purchases by AI agents over HTTP 402 (MPP, decisions.md D4). Mounted under /api only with AGENT_PAY_ENABLED.
//
//   GET  /api/agent-pay/solvers/:idOrSlug            public quote (no order)
//   POST /api/agent-pay/solvers/:idOrSlug/license    no credential -> order + 402 `WWW-Authenticate: Payment`;
//                                                    `Authorization: Payment <credential>` -> settle, then the license
//                                                    is minted to the wallet that paid (200 with the order)
//   GET  /api/agent-pay/orders/:id                   order status (for clients that lost the 200)
//
// Agents with their own wallet can also buy through POST /api/purchases/intent (direct-wallet, sponsored by the relay).

initPayments();
const provider = new AgentPayProvider();
if (env.AGENT_PAY_ENABLED) {
  registerProvider(provider);
  initMpp(provider);
}

export function agentPayConfig(): AgentPayConfig {
  return {
    enabled: env.AGENT_PAY_ENABLED,
    protocol: "mpp",
    minPriceUnits: numberToUnits(env.AGENT_PAY_MIN_PRICE, env.PAYMENT_TOKEN_DECIMALS).toString(),
    maxPriceUnits: numberToUnits(env.AGENT_PAY_MAX_PRICE, env.PAYMENT_TOKEN_DECIMALS).toString(),
  };
}

export const agentPayRouter = Router();

const NO_STORE = "no-store, private";
const ORDER_ID = /^ap_[0-9a-f]{24}$/;

function assertEnabled() {
  if (!env.AGENT_PAY_ENABLED) throw new HttpError(503, "Agent payments are unavailable.", "agent_pay_disabled");
}

async function bounds() {
  return priceBounds(
    {
      minUnits: numberToUnits(env.AGENT_PAY_MIN_PRICE, env.PAYMENT_TOKEN_DECIMALS),
      maxUnits: numberToUnits(env.AGENT_PAY_MAX_PRICE, env.PAYMENT_TOKEN_DECIMALS),
    },
    await readMinPrice(),
  );
}

const endpointOf = (agentId: string) => `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/agent-pay/solvers/${agentId}/license`;

function orderView(row: LedgerRow) {
  const p = payloadOf(row);
  const tokenId = row.ref && row.status === "fulfilled" ? decodePurchaseRef(row.ref as Hex).value.toString() : null;
  return {
    orderId: row.id,
    status: row.status,
    agentId: row.agentId,
    priceUnits: row.tokenAmount.toString(),
    owner: row.buyerWallet === UNKNOWN_BUYER ? null : row.buyerWallet,
    licenseId: tokenId,
    purchaseId: row.purchaseId,
    txHash: row.status === "fulfilled" ? row.txHash : null,
    explorerUrl: row.status === "fulfilled" && row.txHash ? explorerUrl(row.txHash) : null,
    settlementTx: (p.settlementTx as string | undefined) ?? null,
    refundTx: (p.refundTx as string | undefined) ?? null,
    error: row.error,
    expiresAt: expiresAtOf(row)?.toISOString() ?? null,
  };
}

// ---------- Quote ----------

agentPayRouter.get(
  "/agent-pay/solvers/:idOrSlug",
  h(async (req, res) => {
    assertEnabled();
    res.setHeader("Cache-Control", "no-store");
    const agent = await findAgent(String(req.params.idOrSlug));
    let reason: string | undefined;
    let price: bigint | null = null;
    try {
      const { chainAgent } = await sellableAgent(agent.id);
      price = chainAgent.price;
      if (isRowSoldOut({ totalSales: chainAgent.totalSales, maxLicenses: chainAgent.maxSupply === 0 ? null : chainAgent.maxSupply })) reason = "sold_out";
    } catch (e) {
      reason = e instanceof HttpError ? (e.code ?? "unavailable") : "unavailable";
    }
    const b = await bounds();
    if (!reason && price !== null && !priceInBounds(price, b)) reason = "price_out_of_range";
    return {
      agentId: agent.id,
      slug: agent.slug,
      name: agent.name,
      priceUnits: price?.toString() ?? null,
      decimals: env.PAYMENT_TOKEN_DECIMALS,
      token: env.PAYMENT_TOKEN,
      chainId: env.CHAIN_ID,
      available: !reason,
      reason,
      limits: { minUnits: b.min.toString(), maxUnits: b.max.toString() },
      protocol: "mpp",
      intent: "charge",
      endpoint: endpointOf(agent.id),
    };
  }),
);

// ---------- Order status ----------

agentPayRouter.get(
  "/agent-pay/orders/:id",
  h(async (req, res) => {
    assertEnabled();
    res.setHeader("Cache-Control", NO_STORE);
    const id = String(req.params.id);
    const row = ORDER_ID.test(id) ? await loadCharge(id) : undefined;
    if (!row || row.provider !== "agent-pay") throw notFound("Order not found");
    return orderView(row);
  }),
);

// ---------- Purchase ----------

agentPayRouter.post("/agent-pay/solvers/:idOrSlug/license", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", NO_STORE);
  const run = async () => {
    assertEnabled();
    const header = req.get("authorization");
    if (header && Credential.extractPaymentScheme(header)) return paid(req, res, next, header);
    return openOrder(req, res, next);
  };
  run().catch(next);
});

/** (a) No credential: checks, order row first, then the 402 challenge for exactly the current price. */
async function openOrder(req: Request, res: Response, next: NextFunction) {
  const { agent, chainAgent } = await sellableAgent(String(req.params.idOrSlug));
  if (isRowSoldOut({ totalSales: chainAgent.totalSales, maxLicenses: chainAgent.maxSupply === 0 ? null : chainAgent.maxSupply })) {
    throw new HttpError(409, "This Solver is sold out.", "sold_out");
  }
  const b = await bounds();
  if (!priceInBounds(chainAgent.price, b)) {
    throw badRequest("This specialist's price is outside the limits for agent purchases.", "price_out_of_range", {
      priceUnits: chainAgent.price.toString(),
      minUnits: b.min.toString(),
      maxUnits: b.max.toString(),
    });
  }
  const ip = req.ip ?? null;
  if (ip) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(schema.paymentLedger)
      .where(
        and(
          eq(schema.paymentLedger.provider, "agent-pay"),
          inArray(schema.paymentLedger.status, ["created", "pending_payment"]),
          sql`${schema.paymentLedger.providerPayload} ->> 'ip' = ${ip}`,
          sql`(${schema.paymentLedger.providerPayload} ->> 'expiresAt')::timestamptz > now()`,
        ),
      );
    if (n >= MAX_OPEN_ORDERS_PER_IP) throw new HttpError(429, "Too many open orders. Pay one of them or wait for them to expire.", "too_many_open_orders");
  }
  const row = await provider.openOrder({ agentId: agent.id, price: chainAgent.price, ip, description: `Lifetime license for the Solver ${agent.name}` });
  // No credential on the request: the middleware answers 402 with the challenge (and never calls next).
  chargeOrder(row)(req, res, next);
}

/**
 * The paying wallet of a credential, before anything is broadcast (pull: the signed tx; push: the mined tx). Only a
 * transaction that pays THIS order is accepted: a transfer of exactly the order amount of the payment token to the
 * float, with the memo bound to the credential's challenge.
 */
async function payerOf(credential: Credential.Credential, row: LedgerRow): Promise<string> {
  const payload = credential.payload as { type?: string; signature?: string; hash?: string };
  const platform = chainContext().accounts.platform.address.toLowerCase();
  const challengeId = credential.challenge.id;
  const paysOrder = (t: { to: string; amount: bigint; memo: string | null } | null) =>
    !!t && t.to === platform && t.amount === row.tokenAmount && !!t.memo && memoBoundTo(t.memo, challengeId);
  if (payload.type === "transaction" && payload.signature) {
    let tx: { from?: string; calls?: readonly { to?: string | null; data?: string | null }[] };
    try {
      tx = Transaction.deserialize(payload.signature as never) as typeof tx;
    } catch {
      throw badRequest("Invalid payment transaction.", "invalid_payment");
    }
    if (!tx.from) throw badRequest("The payment transaction is not signed.", "invalid_payment");
    if (!(tx.calls ?? []).some((c) => paysOrder(decodeTransferCall(c, env.PAYMENT_TOKEN)))) {
      throw badRequest("The payment transaction does not pay this order.", "invalid_payment");
    }
    return tx.from.toLowerCase();
  }
  if (payload.type === "hash" && payload.hash) {
    const receipt = await chainContext()
      .publicClient.getTransactionReceipt({ hash: payload.hash as Hex })
      .catch(() => null);
    if (!receipt || receipt.status !== "success") throw badRequest("The payment transaction is not mined or reverted.", "invalid_payment");
    const logs = receipt.logs.filter((l) => l.address.toLowerCase() === env.PAYMENT_TOKEN.toLowerCase());
    const events = parseEventLogs({ abi: Abis.tip20, logs: logs as never, strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
    const t = events.find(
      (e) =>
        e.eventName === "TransferWithMemo" &&
        paysOrder({ to: String(e.args.to).toLowerCase(), amount: BigInt(e.args.amount as bigint), memo: String(e.args.memo) }),
    );
    if (!t) throw badRequest("The payment transaction does not pay this order.", "invalid_payment");
    return String(t.args.from).toLowerCase();
  }
  throw badRequest("Unsupported payment credential.", "invalid_payment");
}

/** (b) With a credential: bind the payer, re-check the sale for that wallet, settle, then fulfil. */
async function paid(req: Request, res: Response, next: NextFunction, header: string) {
  let credential: Credential.Credential;
  try {
    credential = Credential.deserialize(Credential.extractPaymentScheme(header) ?? header);
  } catch {
    throw badRequest("Invalid payment credential.", "invalid_payment");
  }
  // Nothing in the credential is trusted before its challenge's HMAC (our secret) is verified: the order id, the amount
  // and the expiry all come from it.
  if (!credential.challenge || !challengeIssuedHere(credential.challenge)) {
    throw badRequest("The payment challenge was not issued by this server.", "invalid_payment");
  }
  const chargeId = chargeIdOfCredential(credential);
  if (!chargeId) throw badRequest("The payment doesn't reference an order.", "order_invalid");
  let row = await loadCharge(chargeId);
  if (!row || row.provider !== "agent-pay") throw notFound("Order not found");
  const agent = await findAgent(String(req.params.idOrSlug));
  if (agent.id !== row.agentId) throw badRequest("The order is for another Solver.", "order_invalid");
  if (row.status !== "pending_payment") {
    if (["confirmed", "fulfilling", "fulfilled", "refunding", "refunded"].includes(row.status)) {
      res.json(orderView(row));
      return;
    }
    throw new HttpError(409, "This order is closed; open a new one.", "order_closed");
  }
  const payer = await payerOf(credential, row);
  // Claim the order before anything is broadcast: one in-flight payment per order, one paying wallet per order.
  const claimed = await provider.claimOrder(row, payer, credential.challenge.id);
  if (!claimed) {
    const current = (await loadCharge(chargeId))!;
    if (current.buyerWallet !== UNKNOWN_BUYER && current.buyerWallet !== payer) throw new HttpError(409, "This order is bound to another wallet.", "order_bound");
    if (current.status !== "pending_payment") {
      res.json(orderView(current));
      return;
    }
    throw new HttpError(409, "A payment for this order is already being processed. Check the order status.", "payment_in_progress", {
      orderId: current.id,
    });
  }
  row = claimed;
  // Nothing has moved yet: if this wallet cannot get the license, refuse before the payment is broadcast.
  try {
    const { agent: a, chainAgent } = await sellableAgent(row.agentId);
    await assertLicenseSellable(a, chainAgent, payer, row.tokenAmount);
  } catch (e) {
    await provider.abandon(row, e instanceof HttpError ? (e.code ?? "refused") : "refused");
    throw e;
  }
  const middleware = chargeOrder(row);
  middleware(req, res, (err?: unknown) => {
    if (err) return next(err);
    // Payment verified and broadcast; the success hook confirmed the order (the recovery scan covers a lost hook).
    void (async () => {
      let current = (await loadCharge(chargeId))!;
      if (current.status === "pending_payment") await provider.confirm(chargeId);
      await provider.fulfill(chargeId);
      current = (await loadCharge(chargeId))!;
      res.status(current.status === "fulfilled" ? 200 : 202).json(orderView(current));
    })().catch(next);
  });
}
