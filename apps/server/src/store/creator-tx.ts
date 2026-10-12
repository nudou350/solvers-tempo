import { Router } from "express";
import { z } from "zod";
import {
  cancelStakeExitCalls,
  contestSlashCalls,
  requestStakeExitCalls,
  setRoyaltyBpsCalls,
  setSupplyCapCalls,
  topUpStakeCalls,
  updateMetadataUriCalls,
  updatePricingCalls,
  withdrawStakeCalls,
} from "@solvers/chain";
import { AGENT_STATUS, agentIdToBytes32, MAX_TOTAL_ROYALTY_BPS, type TxResponse } from "@solvers/shared";
import type { Address, Hex } from "viem";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { env } from "../env.js";
import { sha256 } from "../lib/crypto.js";
import { badRequest, forbidden, h, HttpError, parse } from "../lib/http.js";
import { findAgentRow } from "./catalog.js";
import { agentOnChain, callTargets, registryConfig, stakeExitOnChain, tokenBalance, type AgentOnChain } from "./chain-reads.js";
import { nextMaxLicenses } from "./supply-rules.js";
import { buildChecked } from "./tx-build.js";

// Creator operations on a registered Solver: the server checks the rules the contracts enforce (so the creator gets a
// clear answer instead of a revert) and returns the calls; the creator's wallet signs, the relay pays the fee.
// Version, price and registration go through the reviewed publication flow (src/publish), never through these routes:
// a price set here would diverge from the approved one and block sales (`price_in_review`).

export const creatorTxRouter = Router();

/** Contract limit of `metadataUri` (`MAX_URI_LEN`). */
export const MAX_URI_BYTES = 200;

const Units = z.string().regex(/^\d{1,30}$/, "invalid base-unit amount");

/** The Solver and its on-chain record; only its on-chain creator may continue. */
async function creatorAgent(req: { params: Record<string, unknown> }, wallet: string): Promise<{ id: string; agentId: Hex; onchain: AgentOnChain; slug: string }> {
  const row = await findAgentRow(String(req.params.idOrSlug));
  const onchain = await agentOnChain(row.id);
  if (!onchain) throw badRequest("This specialist is not registered on-chain yet.", "not_registered");
  if (onchain.creator !== wallet.toLowerCase()) throw forbidden("Only the specialist's creator can do this.");
  return { id: row.id, agentId: agentIdToBytes32(row.id), onchain, slug: row.slug };
}

/** Pay-per-use price of the credits (the license price stays the approved one). */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/pricing",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { pricePerUseUnits } = parse(z.object({ pricePerUseUnits: Units }), req.body);
    const a = await creatorAgent(req, wallet);
    const pricePerUse = BigInt(pricePerUseUnits);
    if (pricePerUse > a.onchain.price) throw badRequest("The price per use can't be higher than the license price.", "invalid_price");
    return buildChecked(wallet, updatePricingCalls(callTargets(), { agentId: a.agentId, price: a.onchain.price, pricePerUse }), "pricing");
  }),
);

/** Creator share of the transfer royalty: editable only before the first sale (D15). */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/royalty",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { royaltyBps } = parse(z.object({ royaltyBps: z.number().int().min(0).max(MAX_TOTAL_ROYALTY_BPS) }), req.body);
    const a = await creatorAgent(req, wallet);
    if (a.onchain.totalSales > 0) throw new HttpError(409, "The royalty can't change after the first sale.", "royalty_locked");
    const config = await registryConfig();
    if (config && royaltyBps + config.platformRoyaltyBps > MAX_TOTAL_ROYALTY_BPS) {
      throw badRequest(`Creator and platform royalty together can't exceed ${MAX_TOTAL_ROYALTY_BPS / 100}%.`, "royalty_too_high", {
        maxCreatorBps: MAX_TOTAL_ROYALTY_BPS - config.platformRoyaltyBps,
      });
    }
    return buildChecked(wallet, setRoyaltyBpsCalls(callTargets(), { agentId: a.agentId, royaltyBps }), "royalty");
  }),
);

/** License cap: from unlimited it needs at least max(1, sold); afterwards it can only go up. Never "only N will exist". */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/supply-cap",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { max } = parse(z.object({ max: z.number().int() }), req.body);
    const a = await creatorAgent(req, wallet);
    const plan = nextMaxLicenses(a.onchain.maxSupply, max, a.onchain.totalSales);
    if (!plan.ok) throw badRequest(plan.message, `supply_${plan.reason}`);
    if (plan.action === "none") throw new HttpError(409, "The license cap already has this value.", "supply_unchanged");
    return buildChecked(wallet, setSupplyCapCalls(callTargets(), { agentId: a.agentId, max: plan.max }), "supply-cap");
  }),
);

/** Points the on-chain `metadataUri` at the Solver's public metadata (or a given URL), at most 200 bytes. */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/metadata",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const body = parse(z.object({ metadataUri: z.string().url().optional() }), req.body ?? {});
    const a = await creatorAgent(req, wallet);
    const metadataUri = body.metadataUri ?? `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/agents/${a.id}/metadata.json`;
    if (Buffer.byteLength(metadataUri) > MAX_URI_BYTES) throw badRequest(`The metadata URL is over ${MAX_URI_BYTES} bytes (on-chain limit).`, "uri_too_long");
    if (metadataUri === a.onchain.metadataUri) throw new HttpError(409, "The metadata URL already has this value.", "metadata_unchanged");
    return buildChecked(wallet, updateMetadataUriCalls(callTargets(), { agentId: a.agentId, metadataUri }), "metadata");
  }),
);

creatorTxRouter.post(
  "/tx/creator/:idOrSlug/stake/top-up",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { amountUnits } = parse(z.object({ amountUnits: Units }), req.body);
    const amount = BigInt(amountUnits);
    if (amount <= 0n) throw badRequest("The amount must be greater than zero.", "invalid_amount");
    const a = await creatorAgent(req, wallet);
    // X17: a retired Solver's stake cannot be topped up.
    if (a.onchain.status === AGENT_STATUS.Retired) throw new HttpError(409, "This specialist is retired; its stake can only be withdrawn.", "agent_retired");
    const balance = await tokenBalance(wallet);
    if (balance < amount) {
      throw new HttpError(400, `Insufficient ${env.PAYMENT_TOKEN_SYMBOL} balance`, "insufficient_funds", { balanceUnits: balance.toString(), neededUnits: amountUnits });
    }
    return buildChecked(wallet, topUpStakeCalls(callTargets(), { agentId: a.agentId, amount }), "stake-top-up");
  }),
);

/** Starts the 30-day stake exit: the Solver is retired (no new sales; paid access keeps working). */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/stake/exit",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const a = await creatorAgent(req, wallet);
    if (a.onchain.status === AGENT_STATUS.Retired) throw new HttpError(409, "The stake exit was already requested.", "agent_retired");
    return buildChecked(wallet, requestStakeExitCalls(callTargets(), a.agentId), "stake-exit");
  }),
);

creatorTxRouter.post(
  "/tx/creator/:idOrSlug/stake/cancel-exit",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const a = await creatorAgent(req, wallet);
    if (a.onchain.status !== AGENT_STATUS.Retired) throw new HttpError(409, "There is no stake exit to cancel.", "no_stake_exit");
    const exit = await stakeExitOnChain(a.id);
    if (exit.extensions > 0) throw new HttpError(409, "The platform extended this exit; it can no longer be cancelled.", "stake_exit_extended");
    return buildChecked(wallet, cancelStakeExitCalls(callTargets(), a.agentId), "stake-cancel-exit");
  }),
);

creatorTxRouter.post(
  "/tx/creator/:idOrSlug/stake/withdraw",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const a = await creatorAgent(req, wallet);
    if (a.onchain.status !== AGENT_STATUS.Retired) throw new HttpError(409, "Request the stake exit first.", "no_stake_exit");
    const exit = await stakeExitOnChain(a.id);
    if (exit.exitAt * 1000 > Date.now()) {
      throw new HttpError(409, `The stake can be withdrawn from ${new Date(exit.exitAt * 1000).toISOString()}.`, "stake_exit_not_reached", {
        exitAt: new Date(exit.exitAt * 1000).toISOString(),
      });
    }
    return buildChecked(wallet, withdrawStakeCalls(callTargets(), a.agentId), "stake-withdraw");
  }),
);

/** Contests a proposed slash once (the reason text stays off-chain; its hash goes on-chain). */
creatorTxRouter.post(
  "/tx/creator/:idOrSlug/slash/contest",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(4000) }), req.body);
    const a = await creatorAgent(req, wallet);
    const contestHash = `0x${sha256(reason).toString("hex")}` as Hex;
    return buildChecked(wallet, contestSlashCalls(callTargets(), { agentId: a.agentId, contestHash }), "slash-contest");
  }),
);
