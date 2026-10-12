// Publishes the platform-folder packages (agents/): computes the versionHash, ingests the knowledge, mirrors the catalog
// in the database and, for Solvers sold on-chain, registers them in the Registry (creator batch), fixes the price, the
// license cap and the version, approves them (admin lane) and records the eval (verifier lane, D6). Idempotent: running
// it again only changes what differs.
//
//   pnpm --filter @solvers/server cli:publish            # every agents/ package that is sold on-chain (dev/demo chains)
//   pnpm --filter @solvers/server cli:publish frontend-react ui-design
//   pnpm --filter @solvers/server cli:publish --no-chain # platform Solvers (PLATFORM_AGENTS, e.g. criador-de-solvers): database only
//
// `--no-chain`: no on-chain agent, price 0, `status = active`, listed; no key and no RPC needed. It is the path of the
// platform Solvers, which have no on-chain agent and are not sold. Third-party creators NEVER come here (they publish
// through the site, PACKAGE_SPEC.md 15). The catalog is built by publish/catalog.ts, the same code as the site's finalization.
//
// Creator keys (chain mode): CREATOR_KEYS_DIR/<creator.id>.key (hex), created when missing, never on mainnet. The creator's
// transactions are sponsored in-process by the RELAY key; the stake (if minStake > 0) comes from the PLATFORM float off mainnet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadAccount, publishAgentCalls, setEvalCalls, setSupplyCapCalls, updatePricingCalls, updateVersionCalls, type Call } from "@solvers/chain";
import { solversRegistryAbi } from "@solvers/contracts-client";
import { agentIdToBytes32, numberToUnits } from "@solvers/shared";
import { encodeFunctionData, erc20Abi, type Account, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN, env } from "../env.js";
import { chainContext, initChain } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { db, pool, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { ingestPackage } from "../knowledge/ingest.js";
import { nextMaxLicenses } from "../store/supply-rules.js";
import { isPlatformPair } from "../runtime/platform-agents.js";
import { packages, type SolverPackage } from "../runtime/packages.js";
import { relist, upsertCatalog } from "../publish/catalog.js";
import { royaltyProblem, toChainHash } from "../publish/approval-rules.js";
import { metadataUri, realPublishChain } from "../publish/chain-port.js";
import { indexTx, sendAsWallet } from "./wallet-send.js";

const KEYS_DIR = process.env.CREATOR_KEYS_DIR ?? join(process.cwd(), ".keys", "creators");

/** The creator's key (dev/demo): loaded from CREATOR_KEYS_DIR, created off mainnet when missing. Never printed. */
export function creatorAccount(creatorId: string): Account {
  const file = join(KEYS_DIR, `${creatorId}.key`);
  if (existsSync(file)) return loadAccount(file, `creator key ${creatorId}`);
  if (env.CHAIN_ID === CHAIN.mainnet) throw new Error(`creator key ${creatorId} not found in ${file}`);
  mkdirSync(KEYS_DIR, { recursive: true });
  const pk = generatePrivateKey();
  writeFileSync(file, pk, { mode: 0o600 });
  return privateKeyToAccount(readFileSync(file, "utf8").trim() as Hex);
}

/**
 * What the review "approved": in `cli:publish` the admin is the publisher, so recording the version here BEFORE any
 * transaction is the equivalent of the site's approval. Without it the indexer would flag the freshly registered version
 * as "not approved" (PACKAGE_SPEC.md 15.3, step 1). Older versions stay (the creator may revert to them).
 */
export async function recordApprovedVersion(pkg: SolverPackage, price: bigint, approveTx?: string) {
  const v = { agentId: pkg.manifest.id, version: pkg.manifest.version, versionHash: pkg.versionHash, priceUsdc: price };
  await db
    .insert(schema.agentPublishedVersions)
    .values({ ...v, approveTx: approveTx ?? null })
    .onConflictDoUpdate({
      target: [schema.agentPublishedVersions.agentId, schema.agentPublishedVersions.version],
      set: { versionHash: v.versionHash, priceUsdc: v.priceUsdc, ...(approveTx ? { approveTx } : {}) },
    });
}

/** A creator batch, signed by the creator key and sponsored in-process by RELAY. */
async function asCreator(creator: Account, calls: Call[]): Promise<Hex> {
  return (await sendAsWallet(creator, calls)).hash;
}

/** Off mainnet: tops up the creator from the PLATFORM float so `registerAgent` can pull the stake. */
async function ensureStake(creator: Account, minStake: bigint) {
  if (minStake === 0n) return;
  const c = chainContext();
  const balance = await c.publicClient.readContract({ address: c.deployment.token, abi: erc20Abi, functionName: "balanceOf", args: [creator.address] });
  if (balance >= minStake) return;
  if (env.CHAIN_ID === CHAIN.mainnet) throw new Error(`creator ${creator.address} has ${balance} base units, needs ${minStake} for the stake`);
  const amount = minStake - balance;
  await sendServerCalls({
    signer: "platform",
    lane: "platform",
    calls: [{ to: c.deployment.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [creator.address, amount] }) }],
    kind: "publish-fund-creator",
    ref: creator.address.toLowerCase(),
  });
}

async function publishOnChain(pkg: SolverPackage, creator: Account) {
  const c = chainContext();
  const port = realPublishChain();
  const m = pkg.manifest;
  const id = agentIdToBytes32(m.id);
  const price = numberToUnits(m.pricing.priceUsdc, env.PAYMENT_TOKEN_DECIMALS);
  const config = await port.config();
  const royalty = royaltyProblem(m.pricing.royaltyBps, config.platformRoyaltyBps);
  if (royalty) throw new Error(royalty);

  let state = await port.fetchAgentState(m.id);
  if (!state.exists) {
    await ensureStake(creator, config.minStake);
    const max = m.supply?.maxLicenses;
    await asCreator(
      creator,
      publishAgentCalls(c.deployment, {
        registration: { agentId: id, metadataUri: metadataUri(m.id), version: m.version, versionHash: toChainHash(pkg.versionHash), price, pricePerUse: 0n, royaltyBps: m.pricing.royaltyBps },
        minStake: config.minStake,
        ...(max ? { maxSupply: max } : {}),
      }),
    );
    console.log(`  registered on-chain${max ? ` (license cap ${max})` : ""}`);
  } else {
    if (state.creator !== creator.address.toLowerCase()) throw new Error(`the on-chain agent belongs to ${state.creator}, not to the creator key ${creator.address}`);
    const calls: Call[] = [];
    if (state.version !== m.version || state.versionHash !== pkg.versionHash) {
      calls.push(...updateVersionCalls(c.deployment, { agentId: id, version: m.version, versionHash: toChainHash(pkg.versionHash) }));
    }
    // The pay-per-use price is the creator's own setting (POST /tx/creator/:id/pricing): a price change carries it
    // (capped at the new price, as the Registry requires) instead of switching credits off with 0.
    if (state.price !== price) {
      const current = state.pricePerUse ?? 0n;
      calls.push(...updatePricingCalls(c.deployment, { agentId: id, price, pricePerUse: current > price ? price : current }));
    }
    // License cap: only goes up; a manifest without `supply` never makes it unlimited (store/supply-rules.ts).
    const plan = nextMaxLicenses(state.maxSupply ? state.maxSupply : null, m.supply?.maxLicenses ?? null, state.totalSales ?? 0);
    if (!plan.ok) console.warn(`  ! license cap: ${plan.message}`);
    else if (plan.action !== "none") calls.push(...setSupplyCapCalls(c.deployment, { agentId: id, max: plan.max }));
    if (calls.length) {
      await asCreator(creator, calls);
      console.log(`  on-chain update: ${calls.length} call(s) (version ${m.version}, price ${m.pricing.priceUsdc})`);
    }
  }

  state = await port.fetchAgentState(m.id);
  if (state.exists && state.status !== "active") {
    const approveTx = await port.approveAgent(m.id);
    await recordApprovedVersion(pkg, price, approveTx.toLowerCase());
    await indexTx(approveTx as Hex);
    console.log("  approved by the admin");
  }
  if (pkg.evalReport) {
    const current = await c.publicClient.readContract({
      address: c.deployment.registry,
      abi: solversRegistryAbi,
      functionName: "evalOf",
      args: [id, toChainHash(pkg.versionHash)],
    });
    const evalHash = toChainHash(pkg.evalReport.hash);
    if (current.scoreBps !== pkg.evalReport.scoreBps || current.evalHash.toLowerCase() !== evalHash) {
      const r = await sendServerCalls({
        signer: "verifier",
        lane: "verifier",
        calls: setEvalCalls(c.deployment, { agentId: id, versionHash: toChainHash(pkg.versionHash), scoreBps: pkg.evalReport.scoreBps, evalHash }),
        kind: "set-eval",
        ref: `${m.id}:${m.version}`,
      });
      await indexTx(r.hash);
      // Rating label: "internal team test", never "verified" (apps/web/src/lib/eval-label.ts).
      console.log(`  eval (internal team test): ${pkg.evalReport.scoreBps / 100}%`);
    }
  }
}

export type PublishOptions = {
  /** Database only: platform Solvers (no on-chain agent, price 0, status active). */
  noChain?: boolean;
};

/** Packages of the platform folder (AGENTS_DIR), without the id/slug double entries. Creator packages (PUBLISHED_DIR) never come here. */
function platformFolderPackages(): SolverPackage[] {
  return [...new Map([...packages().values()].map((p) => [p.manifest.id, p])).values()].filter((p) => (p.source ?? "agents") === "agents");
}

/** Picks what to publish and checks the mode: platform Solvers only with `--no-chain`; the others only with the chain. */
export function selectPackages(all: SolverPackage[], slugs: string[], opts: PublishOptions): SolverPackage[] {
  const wanted = slugs.length ? all.filter((p) => slugs.includes(p.manifest.slug) || slugs.includes(p.manifest.id)) : all;
  if (slugs.length) {
    const missing = slugs.filter((x) => !all.some((p) => p.manifest.slug === x || p.manifest.id === x));
    if (missing.length) throw new Error(`no platform package found for: ${missing.join(", ")} (creator packages are published through the site)`);
    for (const p of wanted) {
      const platform = isPlatformPair(p.manifest);
      if (opts.noChain && !platform) throw new Error(`${p.manifest.slug} is not a platform Solver (PLATFORM_AGENTS): --no-chain is only for those`);
      if (!opts.noChain && platform) throw new Error(`${p.manifest.slug} is a platform Solver without an on-chain agent: publish it with --no-chain`);
    }
    return wanted;
  }
  // Without names: each mode takes its own group.
  return wanted.filter((p) => isPlatformPair(p.manifest) === (opts.noChain === true));
}

/** Platform Solver: database only. Price 0, `status = active`, listed; nothing on-chain and no key needed. */
export async function publishNoChain(pkg: SolverPackage) {
  const m = pkg.manifest;
  if (m.pricing.priceUsdc !== 0) console.warn(`  ! the manifest asks for ${m.pricing.priceUsdc}; a platform Solver is free (published with price 0)`);
  const chunks = await ingestPackage(pkg);
  console.log(`  knowledge: ${chunks} chunks`);
  // `creators.wallet` is required and unique: keep the profile's if it exists; otherwise the platform wallet.
  const [creator] = await db.select({ wallet: schema.creators.wallet }).from(schema.creators).where(eq(schema.creators.id, m.creator.id));
  let wallet = creator?.wallet;
  if (!wallet) {
    if (!env.PLATFORM_PRIVATE_KEY) throw new Error(`creator ${m.creator.id} has no profile and PLATFORM_PRIVATE_KEY is not set (its address names the platform creator)`);
    wallet = loadAccount(env.PLATFORM_PRIVATE_KEY, "PLATFORM_PRIVATE_KEY").address.toLowerCase();
  }
  await recordApprovedVersion(pkg, 0n);
  // `platform_status` is only born `active` (column default): republishing never lifts an admin suspension.
  await upsertCatalog(pkg, wallet, { priceUnits: 0n, status: "active" });
  await relist(m.id);
  console.log("  database only (no on-chain agent): price 0, active and listed");
}

export async function publish(slugs: string[], opts: PublishOptions = {}) {
  // The metadata URI goes on-chain: never publish localhost outside the local chain.
  if (!opts.noChain && env.CHAIN_ID !== CHAIN.local && /localhost|127\.0\.0\.1/.test(env.PUBLIC_API_URL)) {
    throw new Error(`PUBLIC_API_URL=${env.PUBLIC_API_URL} cannot go on-chain on chain ${env.CHAIN_ID}`);
  }
  const selected = selectPackages(platformFolderPackages(), slugs, opts);
  if (selected.length === 0) throw new Error(slugs.length ? `no package found for: ${slugs.join(", ")}` : "no package to publish in this mode");
  for (const pkg of selected) {
    const m = pkg.manifest;
    console.log(`\n> ${m.name} (${m.slug}) v${m.version}`);
    if (opts.noChain) {
      await publishNoChain(pkg);
      console.log(`  versionHash ${pkg.versionHash.slice(0, 16)}...  ok`);
      continue;
    }
    const creator = creatorAccount(m.creator.id);
    // Order: knowledge, chain and only then the catalog (price, version, guarantee). If something fails midway the
    // store keeps showing the previous version, consistent with the chain.
    const chunks = await ingestPackage(pkg);
    console.log(`  knowledge: ${chunks} chunks`);
    // Approved version BEFORE any transaction (the mirror checks it; PACKAGE_SPEC.md 15.3, step 1).
    await recordApprovedVersion(pkg, numberToUnits(m.pricing.priceUsdc, env.PAYMENT_TOKEN_DECIMALS));
    await publishOnChain(pkg, creator);
    await upsertCatalog(pkg, creator.address.toLowerCase(), { insertStatus: "active" });
    await relist(m.id);
    await realPublishChain().syncAgent(m.id);
    console.log(`  versionHash ${pkg.versionHash.slice(0, 16)}...  ok`);
  }
}

if (/cli[\\/]publish\.(ts|js)$/.test(process.argv[1] ?? "")) {
  const args = process.argv.slice(2);
  const noChain = args.includes("--no-chain");
  await runMigrations();
  // `--no-chain` never touches the chain (no keys, no RPC).
  if (!noChain) await initChain();
  try {
    await publish(args.filter((a) => !a.startsWith("--")), { noChain });
  } finally {
    await pool.end();
  }
  process.exit(0);
}
