import {
  explorerUrl as explorerLink,
  getChain,
  loadAccount,
  loadDeployment,
  publicClientFor,
  serverWalletClient,
  type Deployment,
} from "@solvers/chain";
import { solversRegistryAbi } from "@solvers/contracts-client";
import { erc20Abi, keccak256, toBytes, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";

import { env } from "../env.js";

/** Server keys (D11). `admin` exists only in development CLIs (refused on mainnet by env.ts). */
export type ServerAccounts = {
  platform: Account;
  relay: Account;
  verifier: Account;
  admin: Account | null;
};

export type ChainContext = {
  chain: Chain;
  deployment: Deployment;
  publicClient: PublicClient<Transport, Chain>;
  accounts: ServerAccounts;
  /** Wallet clients of the server keys (fees are sponsored in-process by `accounts.relay`). */
  wallets: { platform: WalletClient<Transport, Chain, Account>; verifier: WalletClient<Transport, Chain, Account>; admin: WalletClient<Transport, Chain, Account> | null };
};

let ctx: ChainContext | null = null;

export const ROLE = {
  DEFAULT_ADMIN: `0x${"0".repeat(64)}` as `0x${string}`,
  PLATFORM: keccak256(toBytes("PLATFORM_ROLE")),
  USAGE: keccak256(toBytes("USAGE_ROLE")),
  VERIFIER: keccak256(toBytes("VERIFIER_ROLE")),
  GUARDIAN: keccak256(toBytes("GUARDIAN_ROLE")),
} as const;

/** Roles each hot server key must hold, and implicitly the ones it must NOT hold (every other role, admin above all). */
export const HOT_KEY_ROLES = {
  platform: ["PLATFORM", "USAGE"],
  verifier: ["VERIFIER"],
  relay: [],
} as const satisfies Record<string, readonly (keyof typeof ROLE)[]>;

/** Builds the chain context from env (no network calls). The API needs every server key; the worker never calls this. */
export function createChainContext(): ChainContext {
  const missing = (["PLATFORM_PRIVATE_KEY", "RELAY_PRIVATE_KEY", "VERIFIER_PRIVATE_KEY", "TREASURY_ADDRESS"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`Chain configuration refused: missing ${missing.join(", ")}`);
  const chain = getChain(env.CHAIN_ID, env.RPC_URL);
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
  const accounts: ServerAccounts = {
    platform: loadAccount(env.PLATFORM_PRIVATE_KEY, "PLATFORM_PRIVATE_KEY"),
    relay: loadAccount(env.RELAY_PRIVATE_KEY, "RELAY_PRIVATE_KEY"),
    verifier: loadAccount(env.VERIFIER_PRIVATE_KEY, "VERIFIER_PRIVATE_KEY"),
    admin: env.ADMIN_PRIVATE_KEY ? loadAccount(env.ADMIN_PRIVATE_KEY, "ADMIN_PRIVATE_KEY") : null,
  };
  return {
    chain,
    deployment,
    publicClient: publicClientFor(chain, env.RPC_URL),
    accounts,
    wallets: {
      platform: serverWalletClient(accounts.platform, chain, env.RPC_URL),
      verifier: serverWalletClient(accounts.verifier, chain, env.RPC_URL),
      admin: accounts.admin ? serverWalletClient(accounts.admin, chain, env.RPC_URL) : null,
    },
  };
}

/**
 * Boot validation (plan §6 phase 4 step 1): the RPC is on CHAIN_ID, the payment token has PAYMENT_TOKEN_DECIMALS
 * decimals and is the Registry's token, every contract has code, the treasury matches, and the server keys hold the roles
 * they need. Returns the list of problems (empty = ok); the API refuses to start on any problem.
 */
export async function validateChain(c: ChainContext): Promise<string[]> {
  const problems: string[] = [];
  const pc = c.publicClient;
  const chainId = await pc.getChainId();
  if (chainId !== env.CHAIN_ID) return [`RPC_URL is on chain ${chainId}, expected ${env.CHAIN_ID}`];
  for (const [name, addr] of Object.entries({
    registry: c.deployment.registry,
    license: c.deployment.license,
    credits: c.deployment.credits,
    reviews: c.deployment.reviews,
    escrow: c.deployment.escrow,
    staking: c.deployment.staking,
  })) {
    const code = await pc.getCode({ address: addr });
    if (!code || code === "0x") problems.push(`no contract code at ${name} ${addr}`);
  }
  if (problems.length) return problems;
  const decimals = await pc.readContract({ address: env.PAYMENT_TOKEN, abi: erc20Abi, functionName: "decimals" });
  if (decimals !== env.PAYMENT_TOKEN_DECIMALS) problems.push(`PAYMENT_TOKEN has ${decimals} decimals, env says ${env.PAYMENT_TOKEN_DECIMALS}`);
  const reg = { address: c.deployment.registry, abi: solversRegistryAbi } as const;
  const token = await pc.readContract({ ...reg, functionName: "token" });
  if (token.toLowerCase() !== env.PAYMENT_TOKEN) problems.push(`Registry token ${token} != PAYMENT_TOKEN ${env.PAYMENT_TOKEN}`);
  const treasury = await pc.readContract({ ...reg, functionName: "treasury" });
  if (treasury.toLowerCase() !== env.TREASURY_ADDRESS?.toLowerCase()) problems.push(`Registry treasury ${treasury} != TREASURY_ADDRESS`);
  const has = (role: `0x${string}`, a: Account) => pc.readContract({ ...reg, functionName: "hasRole", args: [role, a.address] });
  const same = (a: Account, b: Account) => a.address.toLowerCase() === b.address.toLowerCase();
  // Local chain only: RELAY may reuse the PLATFORM key (env.ts refuses it elsewhere); then it carries PLATFORM's roles.
  const relayIsPlatform = c.chain.id === 31337 && same(c.accounts.relay, c.accounts.platform);
  for (const [name, must] of Object.entries(HOT_KEY_ROLES) as [keyof typeof HOT_KEY_ROLES, readonly (keyof typeof ROLE)[]][]) {
    if (name === "relay" && relayIsPlatform) continue;
    const account = c.accounts[name];
    for (const role of Object.keys(ROLE) as (keyof typeof ROLE)[]) {
      const held = await has(ROLE[role], account);
      if (must.includes(role) && !held) problems.push(`${name.toUpperCase()} key lacks ${role}_ROLE`);
      // D3/D11: hot keys hold only their own roles; never the default admin or the guardian.
      if (!must.includes(role) && held) problems.push(`${name.toUpperCase()} key must not hold ${role === "DEFAULT_ADMIN" ? "DEFAULT_ADMIN_ROLE" : `${role}_ROLE`}`);
    }
  }
  return problems;
}

/** Initializes (once) and validates the chain context; throws with every problem found. */
export async function initChain(options: { validate?: boolean } = {}): Promise<ChainContext> {
  if (ctx) return ctx;
  const c = createChainContext();
  if (options.validate ?? true) {
    const problems = await validateChain(c);
    if (problems.length) throw new Error(`Chain configuration refused:\n  ${problems.join("\n  ")}`);
  }
  ctx = c;
  return ctx;
}

/** The initialized chain context (call `initChain` at boot). */
export function chainContext(): ChainContext {
  if (!ctx) throw new Error("chain context not initialized (call initChain at boot)");
  return ctx;
}

/** Test hook: install a context built elsewhere (anvil fixture) or reset it. */
export function setChainContext(c: ChainContext | null): void {
  ctx = c;
}

/** Explorer link for a tx hash or address; EXPLORER_URL overrides the default per chain; null on local chains. */
export function explorerUrl(value: string): string | null {
  if (env.EXPLORER_URL) return `${env.EXPLORER_URL.replace(/\/$/, "")}/${value.length === 66 ? "tx" : "address"}/${value}`;
  return explorerLink(env.CHAIN_ID, value);
}
