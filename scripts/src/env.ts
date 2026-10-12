// Shared configuration of the e2e and smoke scripts (viem only).
//
// Environment (all optional):
//   API_URL           API under test (default http://127.0.0.1:3018, the dev API on Moderato)
//   CHAIN_ID          42431 | 31337 (default: the API's /api/config, else 42431); mainnet (4217) is always refused,
//                     also when the RPC answers eth_chainId 4217, and CHAIN_ID must match the RPC's eth_chainId
//   RPC_URL           JSON-RPC endpoint (default: the chain's public RPC; local anvil http://127.0.0.1:8545)
//   DEPLOYMENTS_FILE  deployments/<chainId>.json (default: <repo>/deployments/<chainId>.json when it exists, else the
//                     addresses generated into @solvers/contracts-client)
//   SERVER_ENV_FILE   server env file the scripts read admin/platform key paths from (default apps/server/.env;
//                     the local QA environment uses apps/server/.env.qa)
//   SCRIPT_KEYS_DIR   where generated test keys are kept (default scripts/.keys, gitignored)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getChain, loadDeployment, loadPrivateKey, publicClientFor, type Deployment } from "@solvers/chain";
import { createWalletClient, erc20Abi, formatUnits, http, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const SERVER_DIR = join(ROOT, "apps", "server");
export const KEYS_DIR = process.env.SCRIPT_KEYS_DIR ?? join(ROOT, "scripts", ".keys");

export const API_URL = (process.env.API_URL ?? "http://127.0.0.1:3018").replace(/\/$/, "");

const PUBLIC_RPC: Record<number, string> = {
  42431: "https://rpc.moderato.tempo.xyz",
  31337: "http://127.0.0.1:8545",
};

export type Network = {
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  deployment: Deployment;
  publicClient: PublicClient<Transport, Chain>;
  /** Token decimals (6 for every TIP-20). */
  decimals: number;
  explorer: (hash: string) => string;
};

let cached: Network | undefined;

/** Reads `KEY=value` lines of an env file (no interpolation); missing file = {}. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export const SERVER_ENV_FILE = process.env.SERVER_ENV_FILE ?? join(SERVER_DIR, ".env");
export const serverEnv = (): Record<string, string> => readEnvFile(SERVER_ENV_FILE);

async function apiChainId(): Promise<number | undefined> {
  try {
    const res = await fetch(`${API_URL}/api/config`);
    if (!res.ok) return undefined;
    return Number(((await res.json()) as { chainId?: number }).chainId) || undefined;
  } catch {
    return undefined;
  }
}

/** The network the API under test runs on: chain, RPC, deployment, public client. */
export async function network(): Promise<Network> {
  if (cached) return cached;
  const chainId = Number(process.env.CHAIN_ID ?? (await apiChainId()) ?? 42431);
  // Guards run before anything is cached, so a refused network can never be returned by a later call.
  if (chainId === 4217) throw new Error("the scripts never run against Tempo mainnet");
  const rpcUrl = process.env.RPC_URL ?? (chainId === 31337 ? readEnvFile(SERVER_ENV_FILE).RPC_URL : undefined) ?? PUBLIC_RPC[chainId];
  if (!rpcUrl) throw new Error(`no RPC_URL for chain ${chainId}`);
  const chain = getChain(chainId, rpcUrl);
  const publicClient = publicClientFor(chain, rpcUrl);
  // The RPC must serve the chain we think it does (a mainnet RPC_URL with CHAIN_ID=42431 is refused too).
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId === 4217) throw new Error(`${rpcUrl} is Tempo mainnet: the scripts never run against it`);
  if (rpcChainId !== chainId) throw new Error(`CHAIN_ID ${chainId} does not match the RPC's eth_chainId ${rpcChainId} (${rpcUrl})`);
  const repoFile = join(ROOT, "deployments", `${chainId}.json`);
  const file = process.env.DEPLOYMENTS_FILE ?? (existsSync(repoFile) ? repoFile : undefined);
  const deployment = loadDeployment(chainId, { file });
  const base = chainId === 42431 ? "https://explore.testnet.tempo.xyz" : null;
  cached = {
    chainId,
    chain,
    rpcUrl,
    deployment,
    publicClient,
    decimals: 6,
    explorer: (hash) => (base ? `${base}/${hash.length === 66 ? "tx" : "address"}/${hash}` : hash),
  };
  return cached;
}

// ---------- child processes ----------

/** Databases of the old project: never touched from this repository, whatever an env file says. */
const FORBIDDEN_DB_PORTS = new Set([5433, 5543, 5544]);
export const QA_DB_PORT = 5546;
/** Variables a child process must take from its env file, never from the calling shell. */
const PINNED = new Set(["DATABASE_URL", "TEST_DATABASE_URL", "CHAIN_ID", "RPC_URL", "DEPLOYMENTS_FILE", "PAYMENT_TOKEN", "PAYMENT_TOKEN_DECIMALS", "TREASURY_ADDRESS", "ADMIN_WALLETS"]);

/** Port of a postgres URL (5432 when absent). */
export function dbPortOf(url: string): number {
  return Number(new URL(url).port || 5432);
}

/**
 * Environment for a server child process started with `--env-file=<file>`. Node's `--env-file` never overrides a
 * variable already set in the calling shell, so a shell DATABASE_URL, CHAIN_ID, RPC_URL or key would silently win.
 * The child gets the inherited environment minus every variable the file defines, the pinned ones (database, chain,
 * token, treasury, admin wallets) and every `*_PRIVATE_KEY`, plus the file's values set explicitly, plus `extra`.
 * Refuses a DATABASE_URL on the old project's ports; with `qa`, anything but the QA database on 127.0.0.1:5546.
 */
export function childEnv(envFile: string, o: { qa?: boolean; extra?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  if (!existsSync(envFile)) throw new Error(`${envFile} is missing`);
  const fileEnv = readEnvFile(envFile);
  const db = fileEnv.DATABASE_URL;
  if (!db) throw new Error(`${envFile} has no DATABASE_URL`);
  let url: URL;
  try {
    url = new URL(db);
  } catch {
    throw new Error(`${envFile}: DATABASE_URL is not a URL`);
  }
  const port = dbPortOf(db);
  if (FORBIDDEN_DB_PORTS.has(port)) throw new Error(`${envFile}: DATABASE_URL uses port ${port}, which this repository never touches`);
  if (o.qa && (port !== QA_DB_PORT || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/solvers_tempo_qa")) {
    throw new Error(`${envFile}: DATABASE_URL is not the QA database (127.0.0.1:${QA_DB_PORT}/solvers_tempo_qa): host ${url.hostname}, port ${port}, database ${url.pathname.slice(1)}`);
  }
  const fileKeys = new Set(Object.keys(fileEnv).map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase(); // Windows variable names are case-insensitive
    if (!fileKeys.has(K) && !PINNED.has(K) && !K.endsWith("_PRIVATE_KEY")) env[k] = v;
  }
  return { ...env, ...fileEnv, ...o.extra };
}

/** Whole stablecoin units -> base units (6 decimals). */
export const units = (n: number | string): bigint => {
  const [i, f = ""] = String(n).split(".");
  return BigInt(i!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};
export const fmt = (u: bigint): string => formatUnits(u, 6);

export async function tokenBalance(address: Address): Promise<bigint> {
  const n = await network();
  return n.publicClient.readContract({ address: n.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

// ---------- keys ----------

/** A test key kept under scripts/.keys/<name>.key (created on first use). Never printed. */
export function namedAccount(name: string): PrivateKeyAccount {
  const file = join(KEYS_DIR, `${name}.key`);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  }
  return privateKeyToAccount(loadPrivateKey(file, `scripts key ${name}`));
}

/** A fresh, throwaway test wallet (not stored). */
export const freshAccount = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

/**
 * A server key from the server env file (`PLATFORM_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`, ...), hex or a path relative to
 * apps/server. `override` (e.g. process.env.ADMIN_KEY) wins.
 */
export function serverAccount(variable: string, override?: string): PrivateKeyAccount {
  const raw = override ?? serverEnv()[variable] ?? process.env[variable];
  if (!raw) throw new Error(`${variable} is not set in ${SERVER_ENV_FILE}`);
  const value = /^0x[0-9a-fA-F]{64}$/.test(raw) || isAbsolute(raw) ? raw : join(SERVER_DIR, raw);
  return privateKeyToAccount(loadPrivateKey(value, variable));
}

// ---------- test funds ----------

/** Anvil dev account 0 (public test key; holds 2^64-1 of every predeployed stablecoin on `anvil --tempo`). */
const ANVIL_FUNDER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/**
 * Makes sure `address` holds at least `min` base units of the payment token. Moderato: the public faucet RPC
 * (`tempo_fundAddress`, plan T7), repeated until the balance is enough; local anvil: a transfer from dev account 0.
 * Returns the faucet/transfer tx hashes.
 */
export async function fund(address: Address, min: bigint): Promise<Hex[]> {
  const n = await network();
  const hashes: Hex[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await tokenBalance(address);
    if (balance >= min) return hashes;
    if (n.chainId === 31337) {
      const w = createWalletClient({ account: privateKeyToAccount(ANVIL_FUNDER), chain: n.chain, transport: http(n.rpcUrl) });
      const hash = await w.writeContract({ address: n.deployment.token, abi: erc20Abi, functionName: "transfer", args: [address, min - balance] } as never);
      await n.publicClient.waitForTransactionReceipt({ hash });
      hashes.push(hash);
      continue;
    }
    const result = (await n.publicClient.request({ method: "tempo_fundAddress", params: [address] } as never)) as unknown;
    const got = ((Array.isArray(result) ? result : [result]) as unknown[]).filter((x): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x));
    for (const h of got) await n.publicClient.waitForTransactionReceipt({ hash: h, timeout: 60_000 }).catch(() => undefined);
    hashes.push(...got);
  }
  const final = await tokenBalance(address);
  if (final < min) throw new Error(`could not fund ${address}: balance ${fmt(final)}, needed ${fmt(min)}`);
  return hashes;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
