import { isAddress } from "@solana/kit";
import { loadAccount } from "@solvers/chain";
import { z } from "zod";

import { readSolanaKeypair } from "./solana-pay/keypair.js";

// Environment of the API, the worker and the CLIs (plan §3.6). Source of truth for configuration; the template with every
// variable is infra/.env.example.

/** An empty variable in .env (`X=`) counts as unset (applied before every optional parser below). */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const bool = z.preprocess(
  blank,
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
);

/** Boolean without a fixed default: undefined when unset (the default depends on the network). */
const optBool = z.preprocess(
  blank,
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
);

/** An empty variable in .env (`X=`) counts as unset. */
const blankToUndefined = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address")
  .transform((v) => v.toLowerCase() as `0x${string}`);
const optAddress = blankToUndefined.pipe(address.optional());
/** Token base units (bigint) from a decimal string. */
const units = z.coerce.bigint().refine((v) => v >= 0n, "must be >= 0");

export const CHAIN = { mainnet: 4217, moderato: 42431, local: 31337 } as const;

/** Defaults of the Solana network paired with Tempo (testnets -> devnet, mainnet -> mainnet-beta). */
export const SOLANA_DEFAULTS = {
  devnet: { rpcUrl: "https://api.devnet.solana.com", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
  "mainnet-beta": { rpcUrl: "https://api.mainnet-beta.solana.com", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
} as const;
const solanaAddress = blankToUndefined.pipe(z.string().refine((v) => isAddress(v), "expected a base58 Solana address").optional());

const base = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3018),
  /** Public URL of the API (same domain as the web app: /api /mcp /oauth /.well-known). */
  PUBLIC_API_URL: z.string().url().default("http://localhost:3018"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:3001"),
  /** Hosts accepted in SIWE messages (comma separated). Defaults to the hosts of PUBLIC_WEB_URL and PUBLIC_API_URL. */
  SIWE_DOMAINS: blankToUndefined,

  DATABASE_URL: z.string().default("postgres://solvers:solvers@127.0.0.1:5546/solvers_tempo"),

  // ---- chain (Tempo) ----
  CHAIN_ID: z.coerce
    .number()
    .refine((v) => v === CHAIN.mainnet || v === CHAIN.moderato || v === CHAIN.local, "CHAIN_ID must be 4217, 42431 or 31337")
    .default(CHAIN.local),
  RPC_URL: z.string().url().default("http://127.0.0.1:8545"),
  RPC_WS_URL: blankToUndefined,
  EXPLORER_URL: blankToUndefined,
  /** TIP-20 payment token (pathUSD on Moderato); validated at boot against `decimals()` on-chain. */
  PAYMENT_TOKEN: address.default("0x20c0000000000000000000000000000000000000"),
  PAYMENT_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  PAYMENT_TOKEN_SYMBOL: z.string().min(1).default("USD"),
  /** deployments/<CHAIN_ID>.json; empty = the addresses generated into @solvers/contracts-client. */
  DEPLOYMENTS_FILE: blankToUndefined,
  CONTRACT_REGISTRY: optAddress,
  CONTRACT_LICENSE: optAddress,
  CONTRACT_CREDITS: optAddress,
  CONTRACT_REVIEWS: optAddress,
  CONTRACT_ESCROW: optAddress,
  CONTRACT_STAKING: optAddress,

  // ---- keys (hex or a path to a key file under apps/server/.keys; never committed) ----
  // Optional here so the worker and offline CLIs run without them; the API requires them (chain/index.ts createChainContext).
  /** Holds the stablecoin float; `*For` purchases (Pix, agent-pay) and usage batches (PLATFORM_ROLE + USAGE_ROLE). */
  PLATFORM_PRIVATE_KEY: blankToUndefined,
  /** Pays fees only (relay and in-process sponsorship). No contract role (D3, D11). */
  RELAY_PRIVATE_KEY: blankToUndefined,
  /** markPassed / setEval (VERIFIER_ROLE). */
  VERIFIER_PRIVATE_KEY: blankToUndefined,
  /** Dev/demo only (CLIs): approve agents, resolve disputes. Refused on mainnet (MAINNET_FORBIDDEN_KEYS). */
  ADMIN_PRIVATE_KEY: blankToUndefined,
  /** Fee recipient (cold). Must match the Registry's treasury. */
  TREASURY_ADDRESS: optAddress,

  // ---- relay (D3) ----
  RELAY_ENABLED: bool.default("true"),
  RELAY_MAX_GAS_PER_TX: z.coerce.bigint().default(6_000_000n),
  RELAY_DAILY_GAS_PER_WALLET: z.coerce.bigint().default(60_000_000n),
  RELAY_DAILY_GAS_PER_IP: z.coerce.bigint().default(200_000_000n),
  /** Ceiling of all sponsored gas per rolling 24 h (what the RELAY key may spend); admins are alerted when reached. */
  RELAY_DAILY_GAS_GLOBAL: z.coerce.bigint().default(2_000_000_000n),
  /** Caps on the gas price of sponsored transactions (fee-token base units per gas, as returned by the RPC). */
  RELAY_MAX_FEE_PER_GAS: z.coerce.bigint().default(50_000_000_000n),
  RELAY_MAX_PRIORITY_FEE_PER_GAS: z.coerce.bigint().default(2_000_000_000n),
  /** Alert when PLATFORM or RELAY holds less than this (token base units). */
  FLOAT_LOW_BALANCE_UNITS: units.default(50_000_000n),

  // ---- indexer (D9) ----
  INDEXER_ENABLED: bool.default("true"),
  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(1000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  /** Blocks per eth_getLogs call (Moderato caps ranges at 100,000). */
  INDEXER_BLOCK_BATCH: z.coerce.number().int().min(1).max(100_000).default(2000),
  /** First block to scan; empty = deployBlock of the deployment. */
  INDEXER_START_BLOCK: blankToUndefined,

  // ---- auth ----
  JWT_SECRET: z.string().min(32),
  /** 32 bytes in base64: encrypts the memory keys. */
  SERVER_KEK: z.string().min(40),
  PRIVY_APP_ID: blankToUndefined,
  PRIVY_APP_SECRET: blankToUndefined,
  PRIVY_VERIFICATION_KEY: blankToUndefined,

  FAUCET_ENABLED: bool.default("false"),
  /** Faucet amount in whole stablecoin units (testnets only). */
  FAUCET_AMOUNT: z.coerce.number().positive().default(50),
  /** Fallback USD->BRL rate when the FX API fails. */
  BRL_PER_USD: z.coerce.number().default(5.4),

  CLOUDINARY_CLOUD_NAME: blankToUndefined,
  CLOUDINARY_API_KEY: blankToUndefined,
  CLOUDINARY_API_SECRET: blankToUndefined,

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  EMBEDDING_MODEL: z.string().default("Xenova/multilingual-e5-small"),
  SEARCH_MODE: z.enum(["local", "fts"]).default("local"),

  AGENTS_DIR: z.string().default("../../agents"),
  SUBMISSIONS_DIR: z.string().default("./data/submissions"),
  PUBLISHED_DIR: z.string().default("./data/packages"),
  /** Wallets (comma separated) that review submissions on the site. Reviewing on the site signs nothing on-chain. */
  ADMIN_WALLETS: z.string().default(""),
  SUBMISSION_MAX_ZIP_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  SUBMISSION_MAX_UNZIPPED_BYTES: z.coerce.number().int().positive().default(150 * 1024 * 1024),
  SUBMISSION_MAX_FILES: z.coerce.number().int().positive().default(2000),
  SUBMISSION_MAX_PENDING: z.coerce.number().int().min(1).default(3),
  SUBMISSION_MAX_PER_DAY: z.coerce.number().int().min(1).default(5),
  SUBMISSIONS_INLINE: bool.default("false"),
  SEARCH_DAILY_QUOTA: z.coerce.number().int().min(0).default(300),
  DELIVERABLES_DIR: z.string().default("./deliverables"),
  VERIFIER_IMAGE: z.string().default("solvers-tempo-react-test"),
  VERIFIER_MODE: z.enum(["docker", "simulated"]).default("docker"),
  ESCROW_REVIEW_WINDOW_SECS: z.coerce.number().default(72 * 3600),
  AUTO_RELEASE_ENABLED: bool.default("true"),
  GUARANTEE_MIN_SALES: z.coerce.number().int().min(0).default(10),
  GUARANTEE_MIN_RATING: z.coerce.number().min(0).max(5).default(4),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(60),

  // ---- Pix (Mercado Pago), D10 ----
  MP_ACCESS_TOKEN: z.string().min(10).optional(),
  MP_WEBHOOK_SECRET: z.string().min(8).optional(),
  MP_TEST_MODE: optBool,
  /** Simulated Pix approval without Mercado Pago. Default true off mainnet; never on mainnet. */
  PIX_SIMULATE: optBool,

  // ---- agent payments (MPP), D4 ----
  AGENT_PAY_ENABLED: bool.default("false"),
  MPP_SECRET_KEY: blankToUndefined,
  MPP_REALM: blankToUndefined,
  AGENT_PAY_MIN_PRICE: z.coerce.number().positive().default(5),
  AGENT_PAY_MAX_PRICE: z.coerce.number().positive().default(100),
  AGENT_PAY_ORDER_TTL_SECS: z.coerce.number().int().min(60).default(900),

  // ---- Solana Pay (USDC on Solana, fulfilled on Tempo from the PLATFORM float) ----
  SOLANA_PAY_ENABLED: bool.default("false"),
  /** devnet pairs with the Tempo testnet and the local chain, mainnet-beta with Tempo mainnet. Default: the paired one. */
  SOLANA_CLUSTER: z.preprocess(blank, z.enum(["devnet", "mainnet-beta"]).optional()),
  /** Default: the public endpoint of the cluster. */
  SOLANA_RPC_URL: blankToUndefined.pipe(z.string().url().optional()),
  /** SPL mint accepted (USDC). Default: Circle USDC of the cluster. Its decimals must equal PAYMENT_TOKEN_DECIMALS. */
  SOLANA_PAY_MINT: solanaAddress,
  /** solana-keygen JSON file: the recipient wallet, also the refund signer and fee payer. Required when enabled. */
  SOLANA_PAY_KEYPAIR: blankToUndefined,
  SOLANA_PAY_TTL_MIN: z.coerce.number().int().min(5).max(24 * 60).default(30),
  /** Tempo mainnet accepts only Circle USDC as SOLANA_PAY_MINT unless this is true. */
  SOLANA_PAY_ALLOW_CUSTOM_MINT: bool.default("false"),
});

const schema = base.transform((e) => {
  const mainnet = e.CHAIN_ID === CHAIN.mainnet;
  const cluster = e.SOLANA_CLUSTER ?? (mainnet ? "mainnet-beta" : "devnet");
  return {
    ...e,
    SOLANA_CLUSTER: cluster,
    SOLANA_RPC_URL: e.SOLANA_RPC_URL ?? SOLANA_DEFAULTS[cluster].rpcUrl,
    SOLANA_PAY_MINT: e.SOLANA_PAY_MINT ?? SOLANA_DEFAULTS[cluster].mint,
    MP_TEST_MODE: e.MP_TEST_MODE ?? !mainnet,
    PIX_SIMULATE: !mainnet && (e.PIX_SIMULATE ?? true),
    FAUCET_ENABLED: !mainnet && e.FAUCET_ENABLED,
  };
});

export type Env = z.infer<typeof schema>;

/**
 * Keys that grant power over the contracts and that the server must NEVER load on mainnet: the default admin and any
 * guardian/upgrader key. They stay in a cold wallet / Safe and are used only from outside (CLIs with the key at hand).
 */
export const MAINNET_FORBIDDEN_KEYS = ["ADMIN_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"] as const;

/** Forbidden variables set (non-empty) in `source`. */
export function forbiddenMainnetKeys(source: NodeJS.ProcessEnv): string[] {
  return MAINNET_FORBIDDEN_KEYS.filter((k) => (source[k] ?? "").trim() !== "");
}

/** Address of a configured key (hex or key file), or null when unset or unreadable (createChainContext reports those). */
function keyAddress(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return loadAccount(value, "key").address.toLowerCase();
  } catch {
    return null;
  }
}

/** Cross-variable rules (pure, testable). Returns the refusal message or null. */
export function configProblem(e: Env, source: NodeJS.ProcessEnv): string | null {
  if (e.CHAIN_ID === CHAIN.mainnet) {
    const found = forbiddenMainnetKeys(source);
    if (found.length > 0) {
      return `${found.join(", ")} must not exist with CHAIN_ID=4217: on mainnet the server never signs as admin, guardian or deployer.`;
    }
  }
  if (e.CHAIN_ID === CHAIN.mainnet && !(source.PAYMENT_TOKEN ?? "").trim()) {
    // Owed decision (plan §8 #1): mainnet stays inert until the payment token is chosen explicitly.
    return "PAYMENT_TOKEN must be set explicitly with CHAIN_ID=4217.";
  }
  // Keys are compared by the address they derive (hex in any case or a key file path), not as strings.
  const platform = keyAddress(e.PLATFORM_PRIVATE_KEY);
  const relay = keyAddress(e.RELAY_PRIVATE_KEY);
  const verifier = keyAddress(e.VERIFIER_PRIVATE_KEY);
  const admin = keyAddress(e.ADMIN_PRIVATE_KEY);
  // D11: the fee-only RELAY key is separate from PLATFORM (relay abuse must never reach the float) except on dev chains.
  if (e.CHAIN_ID !== CHAIN.local && relay && relay === platform) {
    return "RELAY_PRIVATE_KEY must differ from PLATFORM_PRIVATE_KEY outside the local chain (D11).";
  }
  if (e.CHAIN_ID !== CHAIN.local && relay && relay === verifier) {
    return "RELAY_PRIVATE_KEY must differ from VERIFIER_PRIVATE_KEY outside the local chain (D11).";
  }
  if (admin && [platform, relay, verifier].includes(admin)) {
    return "ADMIN_PRIVATE_KEY must be a key of its own.";
  }
  if (e.AGENT_PAY_ENABLED && !e.MPP_SECRET_KEY) return "AGENT_PAY_ENABLED requires MPP_SECRET_KEY.";
  if (e.AGENT_PAY_MIN_PRICE > e.AGENT_PAY_MAX_PRICE) return "AGENT_PAY_MIN_PRICE must not exceed AGENT_PAY_MAX_PRICE.";
  if (e.SOLANA_PAY_ENABLED) {
    // Real money on one side only would be a bug: test USDC must never buy on Tempo mainnet, nor real USDC on a testnet.
    const paired = e.CHAIN_ID === CHAIN.mainnet ? "mainnet-beta" : "devnet";
    if (e.SOLANA_CLUSTER !== paired) return `SOLANA_CLUSTER must be ${paired} with CHAIN_ID=${e.CHAIN_ID} (Solana Pay).`;
    if (!e.SOLANA_PAY_KEYPAIR) return "SOLANA_PAY_ENABLED requires SOLANA_PAY_KEYPAIR.";
    try {
      readSolanaKeypair(e.SOLANA_PAY_KEYPAIR);
    } catch (err) {
      return (err as Error).message;
    }
    if (e.CHAIN_ID === CHAIN.mainnet && e.SOLANA_PAY_MINT !== SOLANA_DEFAULTS["mainnet-beta"].mint && !e.SOLANA_PAY_ALLOW_CUSTOM_MINT) {
      return `SOLANA_PAY_MINT must be Circle USDC (${SOLANA_DEFAULTS["mainnet-beta"].mint}) with CHAIN_ID=4217 unless SOLANA_PAY_ALLOW_CUSTOM_MINT=true.`;
    }
  }
  return null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `X=` in .env means unset: without this, z.coerce turns "" into 0 and string minimums reject it.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  const problem = configProblem(parsed.data, source);
  if (problem) throw new Error(`Configuration refused: ${problem}`);
  return parsed.data;
}

export const env = loadEnv();
