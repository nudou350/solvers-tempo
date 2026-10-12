// Chain context of the admin CLIs (`cli:approve`, `cli:suspend`, `cli:admin`). Unlike the API it does not need the
// PLATFORM/VERIFIER keys: it needs the RELAY key (fee payer: D20, the admin key never holds tokens) and the signer key
// (the Registry's default admin, or the new admin / a guardian for the commands that say so). The signer is installed as
// the `admin` account of the chain context, so it signs on the admin nonce lane through `sendServerCalls`.

import { getChain, loadAccount, loadDeployment, publicClientFor, serverWalletClient } from "@solvers/chain";
import type { Account } from "viem";
import { setChainContext, type ChainContext } from "../chain/index.js";
import { env } from "../env.js";
import { adminKeySource, assertNetwork, type NetworkName } from "./admin-guard.js";

export type CliChain = { ctx: ChainContext; network: NetworkName; warning: string | null; signer: Account | null };

/**
 * Builds and installs the chain context for an admin CLI. Order: network guard (RPC chain id = CHAIN_ID; mainnet only
 * with `--allow-network mainnet`), then the signer key (`adminKeySource`: on mainnet only `--key-file`), then RELAY.
 * Works without a signer key (dry-runs). Never prints a key.
 */
export async function initCliChain(opts: { keyFile: string | null; allowNetwork: string | null }): Promise<CliChain> {
  const chain = getChain(env.CHAIN_ID, env.RPC_URL);
  const publicClient = publicClientFor(chain, env.RPC_URL);
  const { network, warning } = assertNetwork(await publicClient.getChainId(), env.CHAIN_ID, opts.allowNetwork);
  const source = adminKeySource({ network, keyFile: opts.keyFile, envKeySet: !!env.ADMIN_PRIVATE_KEY });
  const signer = source.source === "key-file" ? loadAccount(source.path, "--key-file") : source.source === "env" ? loadAccount(env.ADMIN_PRIVATE_KEY, "ADMIN_PRIVATE_KEY") : null;
  if (!env.RELAY_PRIVATE_KEY) throw new Error("RELAY_PRIVATE_KEY is required: the relay key pays the fee of admin transactions (D20)");
  const relay = loadAccount(env.RELAY_PRIVATE_KEY, "RELAY_PRIVATE_KEY");
  // PLATFORM/VERIFIER are not used by the admin CLIs; when absent the relay stands in (never signs for them here).
  const platform = env.PLATFORM_PRIVATE_KEY ? loadAccount(env.PLATFORM_PRIVATE_KEY, "PLATFORM_PRIVATE_KEY") : relay;
  const verifier = env.VERIFIER_PRIVATE_KEY ? loadAccount(env.VERIFIER_PRIVATE_KEY, "VERIFIER_PRIVATE_KEY") : relay;
  const deployment = loadDeployment(env.CHAIN_ID, {
    file: env.DEPLOYMENTS_FILE,
    overrides: {
      registry: env.CONTRACT_REGISTRY,
      license: env.CONTRACT_LICENSE,
      credits: env.CONTRACT_CREDITS,
      reviews: env.CONTRACT_REVIEWS,
      escrow: env.CONTRACT_ESCROW,
      staking: env.CONTRACT_STAKING,
    },
  });
  const ctx: ChainContext = {
    chain,
    deployment,
    publicClient,
    accounts: { platform, relay, verifier, admin: signer },
    wallets: {
      platform: serverWalletClient(platform, chain, env.RPC_URL),
      verifier: serverWalletClient(verifier, chain, env.RPC_URL),
      admin: signer ? serverWalletClient(signer, chain, env.RPC_URL) : null,
    },
  };
  setChainContext(ctx);
  return { ctx, network, warning, signer };
}

/** Explorer link (or the bare hash on the local chain). */
export function txLink(explorerUrl: (v: string) => string | null, hash: string): string {
  return explorerUrl(hash) ?? hash;
}
