import { explorerBase, getChain } from "@solvers/chain";
import {
  DEFAULT_MIN_PRICE_UNITS,
  FREE_TRIAL_USES,
  GUARANTEE_LIMITS_USDC,
  MAX_TOTAL_ROYALTY_BPS,
  type PublicConfig,
} from "@solvers/shared";
import type { Address } from "viem";
import { CHAIN, env } from "../env.js";
import { HttpError } from "../lib/http.js";
import { agentPayConfig } from "../agent-pay/routes.js";
import { pixConfig } from "../pix/provider.js";
import { solanaPayConfig } from "../solana-pay/provider.js";
import { deploymentOrNull, registryConfig } from "./chain-reads.js";
import { brlPerUsd } from "./fx.js";

/** Default creator share of the transfer royalty for NEW Solvers (D15: 5% creator + 5% platform of the original price). */
export const DEFAULT_CREATOR_ROYALTY_BPS = 500;

/** Public RPC the browser may use: the chain's public endpoint (env RPC_URL may carry a provider key), env on local chains. */
function publicRpcUrl(): string {
  if (env.CHAIN_ID === CHAIN.local) return env.RPC_URL;
  return getChain(env.CHAIN_ID).rpcUrls.default.http[0] ?? env.RPC_URL;
}

/**
 * GET /api/config: env + the Registry config (fee, platform royalty, minimum price; that part cached 10 s and invalidated by
 * the indexer) + the server clock.
 */
export async function publicConfig(): Promise<PublicConfig> {
  const d = deploymentOrNull();
  if (!d) throw new HttpError(503, "The chain is not configured on this server.", "chain_unavailable");
  const config = await registryConfig();
  const lower = (a: Address) => a.toLowerCase() as Address;
  return {
    chainId: env.CHAIN_ID,
    rpcUrl: publicRpcUrl(),
    explorerUrl: env.EXPLORER_URL ?? explorerBase(env.CHAIN_ID) ?? "",
    contracts: {
      registry: lower(d.registry),
      license: lower(d.license),
      credits: lower(d.credits),
      reviews: lower(d.reviews),
      escrow: lower(d.escrow),
      staking: lower(d.staking),
    },
    paymentToken: { address: env.PAYMENT_TOKEN, symbol: env.PAYMENT_TOKEN_SYMBOL, decimals: env.PAYMENT_TOKEN_DECIMALS },
    feeBps: config?.feeBps ?? null,
    royalty: {
      creatorBps: DEFAULT_CREATOR_ROYALTY_BPS,
      platformBps: config ? Math.min(config.platformRoyaltyBps, MAX_TOTAL_ROYALTY_BPS) : null,
    },
    minPriceUnits: (config?.minPrice ?? DEFAULT_MIN_PRICE_UNITS(env.PAYMENT_TOKEN_DECIMALS)).toString(),
    faucetEnabled: env.FAUCET_ENABLED,
    brlPerUsd: await brlPerUsd(),
    connectorUrl: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/mcp`,
    freeTrialUses: FREE_TRIAL_USES,
    reviewWindowSecs: env.ESCROW_REVIEW_WINDOW_SECS,
    guaranteeLimitsUsdc: GUARANTEE_LIMITS_USDC,
    guaranteeMinSales: env.GUARANTEE_MIN_SALES,
    guaranteeMinRating: env.GUARANTEE_MIN_RATING,
    pix: pixConfig(),
    solanaPay: solanaPayConfig(),
    agentPay: agentPayConfig(),
    // The relay checks `validBefore` against this clock; browsers offset their own clock by it (never cached).
    serverTime: Math.floor(Date.now() / 1000),
  };
}
