import { Router } from "express";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { claimCalls, parseSolversEvents, transferWithRoyaltyCalls } from "@solvers/chain";
import {
  bytes32ToAgentId,
  isAddress,
  MAX_TOTAL_ROYALTY_BPS,
  normalizeAddress,
  TxHash,
  type AgentAccess,
  type ConfirmResponse,
  type DeferredPayouts,
  type FaucetResponse,
  type License,
  type LicenseMetadata,
  type MyTrial,
  type Profile,
  type RoyaltyQuote,
  type TokenBalance,
  type TxResponse,
  type UsageSummary,
} from "@solvers/shared";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { chainContext, explorerUrl } from "../chain/index.js";
import { sendServerCalls } from "../chain/lanes.js";
import { db, schema } from "../db/index.js";
import { CHAIN, env } from "../env.js";
import { toImageRefs } from "../images/refs.js";
import { processTxHash } from "../indexer/index.js";
import { searchAgentRows } from "../knowledge/search.js";
import { badRequest, forbidden, h, HttpError, notFound, parse } from "../lib/http.js";
import { displayUnits, unitsFromNumber } from "../lib/money.js";
import { trialUsage } from "../runtime/access.js";
import { refreshLicenseOwner } from "../runtime/licenses.js";
import { getPackage } from "../runtime/packages.js";
import { myTrial, trialLeft, trialLimits } from "../runtime/trial.js";
import { findAgentRow, getAgentDetail, getCreator, getCreatorProfile, listAgents, listCategories, listCreators, listReviews, mapAgents } from "./catalog.js";
import {
  callTargets,
  deferredOnChain,
  licenseOnChain,
  licenseOwnerOf,
  quoteRoyaltyOnChain,
  registryConfig,
  tokenBalance,
} from "./chain-reads.js";
import { promoteDisputeDrafts } from "./dispute-drafts.js";
import { fillEscrowTexts } from "./escrow.js";
import { catalogLangOf } from "./lang-rules.js";
import { toLicense, toReputation } from "./mappers.js";
import { assertTransfersOpen } from "./pause-gate.js";
import { ensureProfile } from "./profile.js";
import { publicConfig } from "./public-config.js";
import { buildChecked } from "./tx-build.js";

export const storeRouter = Router();

const TokenIdParam = z.string().regex(/^\d{1,78}$/, "invalid license id");

// ---------- Public ----------

storeRouter.get("/config", h(async () => publicConfig()));

storeRouter.get(
  "/agents",
  h(async (req, res) => {
    const q = parse(
      z.object({
        q: z.string().max(200).optional(),
        category: z.string().max(60).optional(),
        sort: z.enum(["rating", "uses", "trend", "new"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      req.query,
    );
    return listAgents({ ...q, lang: catalogLangOf(req, res) });
  }),
);

storeRouter.get("/categories", h(async () => listCategories()));

/** The Solver's `metadataUri` (registered on-chain): public JSON in the usual NFT metadata shape. */
storeRouter.get(
  "/agents/:idOrSlug/metadata.json",
  h(async (req) => {
    const row = await findAgentRow(String(req.params.idOrSlug));
    return {
      name: row.name,
      symbol: "SOLVER",
      description: row.tagline,
      external_url: `${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/solvers/${row.slug}`,
      attributes: [
        { trait_type: "agent_id", value: row.id },
        { trait_type: "category", value: row.category },
        { trait_type: "version", value: row.version },
      ],
    };
  }),
);

/**
 * ERC-721 metadata of a license (`tokenURI` = `<baseURI><tokenId>`, base `<PUBLIC_API_URL>/api/license/`). Reads the
 * mirror, falling back to the contract for a license the indexer has not written yet.
 */
storeRouter.get(
  "/license/:id",
  h(async (req, res): Promise<LicenseMetadata> => {
    const id = parse(TokenIdParam, String(req.params.id));
    let [lic] = await db.select().from(schema.licenses).where(eq(schema.licenses.id, id));
    let agentId = lic?.agentId ?? null;
    let originalPrice = lic?.originalPrice ?? null;
    let mintedAt = lic?.acquiredAt ?? null;
    if (!lic) {
      const onchain = await licenseOnChain(BigInt(id)).catch(() => null);
      if (!onchain) throw notFound("License not found");
      agentId = bytes32ToAgentId(onchain.agentId);
      originalPrice = onchain.originalPrice;
      mintedAt = new Date(onchain.mintedAt * 1000);
    }
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId!));
    if (!agent) throw notFound("License not found");
    const [image] = await db.select().from(schema.agentImages).where(eq(schema.agentImages.agentId, agent.id)).orderBy(asc(schema.agentImages.position)).limit(1);
    res.setHeader("Cache-Control", "public, max-age=300");
    const web = env.PUBLIC_WEB_URL.replace(/\/$/, "");
    return {
      name: `${agent.name} license #${id}`,
      description: `Lifetime license of ${agent.name}, a Solvers specialist: ${agent.tagline}`,
      ...(image ? { image: toImageRefs([image])[0]!.url } : {}),
      external_url: `${web}/solvers/${agent.slug}`,
      attributes: [
        { trait_type: "Agent", value: agent.name },
        { trait_type: "Agent ID", value: agent.id },
        { trait_type: "Version", value: agent.version },
        { trait_type: "Original price", value: displayUnits(originalPrice ?? 0n) },
        { trait_type: "Currency", value: env.PAYMENT_TOKEN_SYMBOL },
        { trait_type: "Creator royalty (bps)", value: agent.royaltyBps },
        ...(mintedAt ? [{ trait_type: "Minted", value: mintedAt.toISOString().slice(0, 10) }] : []),
      ],
    };
  }),
);

storeRouter.get(
  "/agents/:idOrSlug/reviews",
  h(async (req) => {
    const row = await findAgentRow(String(req.params.idOrSlug));
    return listReviews(row.id, 200);
  }),
);

storeRouter.get("/agents/:idOrSlug", h(async (req, res) => getAgentDetail(String(req.params.idOrSlug), catalogLangOf(req, res))));

storeRouter.post(
  "/search",
  h(async (req, res) => {
    const { need } = parse(z.object({ need: z.string().min(3).max(500) }), req.body);
    return mapAgents(await searchAgentRows(need, 3), catalogLangOf(req, res));
  }),
);

storeRouter.get("/creators", h(async (req, res) => listCreators(catalogLangOf(req, res))));

storeRouter.get("/creators/:id", h(async (req, res) => getCreatorProfile(String(req.params.id), catalogLangOf(req, res))));

// ---------- Authenticated ----------

storeRouter.get(
  "/me/licenses",
  requireAuth,
  h(async (req): Promise<License[]> => {
    const wallet = requireWallet(req);
    const lic = await db
      .select()
      .from(schema.licenses)
      .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.burned, false)))
      .orderBy(desc(schema.licenses.acquiredAt));
    return lic.map(toLicense);
  }),
);

storeRouter.post(
  "/me/licenses/refresh",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const lic = await db.select({ id: schema.licenses.id }).from(schema.licenses).where(eq(schema.licenses.ownerWallet, wallet));
    for (const l of lic) await refreshLicenseOwner(l.id).catch(() => undefined);
    return { ok: true };
  }),
);

/** The license must be the session wallet's, read on-chain (the mirror may lag a transfer). */
async function ownedLicense(wallet: string, id: string) {
  const tokenId = BigInt(parse(TokenIdParam, id));
  const [owner, lic] = await Promise.all([licenseOwnerOf(tokenId), licenseOnChain(tokenId)]);
  if (!owner || !lic) throw notFound("License not found");
  if (owner !== wallet.toLowerCase()) throw forbidden("This license belongs to another wallet");
  return { tokenId, lic };
}

async function transferQuote(wallet: string, id: string): Promise<RoyaltyQuote> {
  const { tokenId, lic } = await ownedLicense(wallet, id);
  const agentId = bytes32ToAgentId(lic.agentId);
  const [quote, config, [agent]] = await Promise.all([
    quoteRoyaltyOnChain(tokenId),
    registryConfig(),
    db.select({ royaltyBps: schema.agents.royaltyBps }).from(schema.agents).where(eq(schema.agents.id, agentId)),
  ]);
  const creatorBps = agent?.royaltyBps ?? 0;
  const platformBps = config ? Math.min(config.platformRoyaltyBps, MAX_TOTAL_ROYALTY_BPS - creatorBps) : 0;
  return {
    licenseId: tokenId.toString(),
    agentId,
    token: env.PAYMENT_TOKEN,
    decimals: env.PAYMENT_TOKEN_DECIMALS,
    originalPriceUnits: lic.originalPrice.toString(),
    creatorBps,
    platformBps,
    creatorAmountUnits: quote.creatorAmount.toString(),
    platformAmountUnits: quote.platformAmount.toString(),
    totalUnits: (quote.creatorAmount + quote.platformAmount).toString(),
  };
}

/** Royalty the owner pays to transfer the license (creator + platform shares of the original price, D15). */
storeRouter.get(
  "/me/licenses/:id/transfer-quote",
  requireAuth,
  h(async (req) => transferQuote(requireWallet(req), String(req.params.id))),
);

storeRouter.get(
  "/me/reputation",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const [row] = await db.select().from(schema.userReputation).where(eq(schema.userReputation.wallet, wallet));
    return toReputation(wallet, row);
  }),
);

const KIND_LABEL: Record<string, string> = {
  purchase: "License purchase",
  credits: "Credits purchase",
  escrow: "Guaranteed task created",
  royalty: "License transfer",
  release: "Guarantee step paid",
  refund: "Guarantee step refunded",
  slash: "Stake slashed",
  claim: "Held payout claimed",
  stake: "Stake updated",
};

storeRouter.get(
  "/me/profile",
  requireAuth,
  h(async (req, res): Promise<Profile> => {
    const wallet = requireWallet(req);
    const lang = catalogLangOf(req, res);
    const [rep] = await db.select().from(schema.userReputation).where(eq(schema.userReputation.wallet, wallet));
    const [creatorRow] = await db.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
    const profile = await ensureProfile(wallet);
    const txs = await db
      .select()
      .from(schema.chainTxs)
      .where(eq(schema.chainTxs.wallet, wallet))
      .orderBy(desc(sql`coalesce(${schema.chainTxs.blockTime}, ${schema.chainTxs.createdAt})`))
      .limit(30);
    return {
      wallet: wallet as Address,
      displayName: profile.displayName,
      email: profile.email,
      memberSince: profile.createdAt.toISOString(),
      reputation: toReputation(wallet, rep),
      creator: creatorRow ? await getCreator(creatorRow.id, lang) : null,
      explorerUrl: explorerUrl(wallet) ?? "",
      history: txs.map((t) => ({
        kind: t.kind,
        label: KIND_LABEL[t.kind] ?? t.kind,
        // Block time; created_at is only when the indexer saw the transaction.
        at: (t.blockTime ?? t.createdAt).toISOString(),
        txHash: t.txHash as Hex,
      })),
    };
  }),
);

/** Profile name and e-mail (the web sends the data of the e-mail login). */
storeRouter.patch(
  "/me/profile",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const body = parse(
      z.object({
        displayName: z.string().trim().min(1).max(80).nullable().optional(),
        email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
      }),
      req.body,
    );
    await ensureProfile(wallet);
    await db
      .update(schema.userProfiles)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.userProfiles.wallet, wallet));
    return { ok: true };
  }),
);

/** Payment-token balance of the session wallet (`balanceOf`), in base units. */
storeRouter.get(
  "/me/balance",
  requireAuth,
  h(async (req): Promise<TokenBalance> => {
    const wallet = requireWallet(req) as Address;
    return {
      token: env.PAYMENT_TOKEN,
      symbol: env.PAYMENT_TOKEN_SYMBOL,
      decimals: env.PAYMENT_TOKEN_DECIMALS,
      units: (await tokenBalance(wallet)).toString(),
    };
  }),
);

/** Payouts held for the wallet because a direct transfer to it was blocked (D5): the `payouts_deferred` mirror. */
storeRouter.get(
  "/me/payouts",
  requireAuth,
  h(async (req): Promise<DeferredPayouts> => {
    const wallet = requireWallet(req);
    const rows = await db
      .select()
      .from(schema.payoutsDeferred)
      .where(and(eq(schema.payoutsDeferred.recipient, wallet), gt(schema.payoutsDeferred.amount, 0n)));
    const total = rows.reduce((s, r) => s + r.amount, 0n);
    return { totalUnits: total.toString(), contracts: rows.map((r) => ({ contract: r.contract as Address, units: r.amount.toString() })) };
  }),
);

/** Usage of each Solver by the wallet (library): totals, current month and 8 weeks. */
storeRouter.get(
  "/me/usage",
  requireAuth,
  h(async (req): Promise<UsageSummary[]> => {
    const wallet = requireWallet(req);
    const act = sql`${schema.usageEvents.tool} = 'activate_solver'`;
    const rows = await db
      .select({
        agentId: schema.usageEvents.agentId,
        activations: sql<number>`count(*) filter (where ${act})`.mapWith(Number),
        calls: sql<number>`count(*)`.mapWith(Number),
        lastUsedAt: sql<string>`max(${schema.usageEvents.createdAt})`,
        usesThisMonth: sql<number>`count(*) filter (where ${act} and ${schema.usageEvents.createdAt} >= date_trunc('month', now()))`.mapWith(Number),
      })
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.wallet, wallet))
      .groupBy(schema.usageEvents.agentId);
    // Activations per week (0 = current week ... 7 = seven weeks ago).
    const weeks = await db
      .select({
        agentId: schema.usageEvents.agentId,
        ago: sql<number>`((date_trunc('week', now())::date - date_trunc('week', ${schema.usageEvents.createdAt})::date) / 7)`.mapWith(Number),
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.wallet, wallet), act, gt(schema.usageEvents.createdAt, sql`date_trunc('week', now()) - interval '7 weeks'`)))
      .groupBy(sql`1`, sql`2`);
    const weekly = (agentId: string) => {
      const out = [0, 0, 0, 0, 0, 0, 0, 0];
      for (const w of weeks) if (w.agentId === agentId && w.ago >= 0 && w.ago < 8) out[7 - w.ago] = w.n;
      return out;
    };
    return rows.flatMap((r) =>
      r.agentId
        ? [
            {
              agentId: r.agentId,
              activations: r.activations,
              calls: r.calls,
              lastUsedAt: new Date(r.lastUsedAt).toISOString(),
              usesThisMonth: r.usesThisMonth,
              weekly: weekly(r.agentId),
            },
          ]
        : [],
    );
  }),
);

/** How the wallet accesses a Solver right now (license or the free trial's balance). */
storeRouter.get(
  "/me/access/:idOrSlug",
  requireAuth,
  h(async (req): Promise<AgentAccess> => {
    const wallet = requireWallet(req);
    const row = await findAgentRow(String(req.params.idOrSlug));
    const [lic] = await db
      .select()
      .from(schema.licenses)
      .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.agentId, row.id), eq(schema.licenses.burned, false)));
    const pkg = getPackage(row.id);
    const limits = pkg ? trialLimits(pkg.manifest) : null;
    if (!limits) return { agentId: row.id, license: lic ? lic.id : null, trialUsesLeft: 0, trial: null };
    const { used, usage } = await trialUsage(wallet, row.id);
    return {
      agentId: row.id,
      license: lic ? lic.id : null,
      trialUsesLeft: Math.max(0, limits.uses - used),
      trial: trialLeft(limits, usage),
    };
  }),
);

/** The wallet's free trials in progress (library): only Solvers already activated and still without a license. */
storeRouter.get(
  "/me/trials",
  requireAuth,
  h(async (req): Promise<MyTrial[]> => {
    const wallet = requireWallet(req);
    const rows = await db.select().from(schema.trials).where(eq(schema.trials.wallet, wallet)).orderBy(desc(schema.trials.updatedAt));
    if (!rows.length) return [];
    const owned = await db
      .select({ agentId: schema.licenses.agentId })
      .from(schema.licenses)
      .where(and(eq(schema.licenses.ownerWallet, wallet), eq(schema.licenses.burned, false)));
    const licensed = new Set(owned.map((l) => l.agentId));
    return rows.flatMap((r) => {
      const pkg = getPackage(r.agentId);
      const limits = pkg ? trialLimits(pkg.manifest) : null;
      if (!limits || licensed.has(r.agentId) || r.used <= 0) return [];
      return [myTrial(r.agentId, limits, r.used, { searchesUsed: r.searchesUsed, toolRuns: r.toolRuns }, r.updatedAt)];
    });
  }),
);

// ---------- Transactions (the server returns calls; the wallet sends them, the relay pays the fee) ----------

async function assertBalance(wallet: Address, needed: bigint): Promise<void> {
  if (needed === 0n) return;
  const balance = await tokenBalance(wallet);
  if (balance < needed) {
    throw new HttpError(400, `Insufficient ${env.PAYMENT_TOKEN_SYMBOL} balance`, "insufficient_funds", {
      balanceUnits: balance.toString(),
      neededUnits: needed.toString(),
      faucetEnabled: env.FAUCET_ENABLED,
    });
  }
}

/**
 * Transfers a license to another wallet. The owner pays the transfer royalty (creator + platform shares of the original
 * price); `maxRoyaltyUnits` is the quote the owner accepted: the contract reverts with `RoyaltyChanged` if it went up,
 * and the server answers 409 `royalty_changed` with the new quote before building anything.
 */
storeRouter.post(
  "/tx/transfer",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const body = parse(
      z.object({ licenseId: TokenIdParam, to: z.string().refine((s) => isAddress(s.trim()), "invalid address"), maxRoyaltyUnits: z.string().regex(/^\d{1,30}$/) }),
      req.body,
    );
    const to = normalizeAddress(body.to);
    if (to === wallet.toLowerCase()) throw badRequest("The license is already in this wallet.", "same_wallet");
    if (/^0x0{40}$/.test(to)) throw badRequest("Use a real wallet address.", "invalid_recipient");
    await assertTransfersOpen("transfer");
    const quote = await transferQuote(wallet, body.licenseId);
    const total = BigInt(quote.totalUnits);
    const maxRoyalty = BigInt(body.maxRoyaltyUnits);
    if (total > maxRoyalty) {
      throw new HttpError(409, "The transfer royalty changed. Review the new amount and try again.", "royalty_changed", { quote });
    }
    await assertBalance(wallet, total);
    return buildChecked(wallet, transferWithRoyaltyCalls(callTargets(), { to, tokenId: BigInt(body.licenseId), maxRoyalty }), "transfer");
  }),
);

/** Withdraws every deferred payout of the session wallet: one `claim()` per contract holding one (read live). */
storeRouter.post(
  "/tx/claim",
  requireAuth,
  h(async (req): Promise<TxResponse> => {
    const wallet = requireWallet(req) as Address;
    const held = (await deferredOnChain(wallet)).filter((p) => p.units > 0n);
    if (held.length === 0) throw new HttpError(409, "There is nothing to claim.", "nothing_to_claim");
    return buildChecked(wallet, held.flatMap((p) => claimCalls(p.contract)), "claim");
  }),
);

/** Decoded Solvers events of a receipt, JSON-safe (bigints as decimal strings). */
function eventSummaries(logs: Parameters<typeof parseSolversEvents>[0]): { name: string; contract: string; args: Record<string, unknown> }[] {
  const d = chainContext().deployment;
  const plain = (v: unknown): unknown =>
    typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
  return parseSolversEvents(logs, d).map((e) => ({ name: e.eventName, contract: e.contract, args: plain(e.args) as Record<string, unknown> }));
}

/**
 * After the wallet broadcast a batch: waits for the receipt, indexes it right away (the license shows up in the
 * connector without waiting for the poller) and returns the decoded outcome.
 */
storeRouter.post(
  "/tx/confirm",
  requireAuth,
  h(async (req, res) => {
    const { txHash } = parse(z.object({ txHash: TxHash }), req.body);
    const pc = chainContext().publicClient;
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash, timeout: 20_000 }).catch(() => null);
    if (!receipt) {
      res.status(202);
      return { txHash, status: "failed", code: "pending", error: "Transaction not found yet; try again in a few seconds" } satisfies ConfirmResponse & { code: string };
    }
    if (receipt.status !== "success") {
      return { txHash, status: "failed", error: "The transaction reverted on the network; nothing was charged", explorerUrl: explorerUrl(txHash) } satisfies ConfirmResponse & {
        explorerUrl: string | null;
      };
    }
    await processTxHash(txHash).catch((e: unknown) => console.error(`[confirm] indexing ${txHash}:`, (e as Error).message));
    // A guarantee bought in this transaction gets its off-chain texts right away.
    await fillEscrowTexts().catch(() => 0);
    // A dispute opened in this transaction gets its criterion and reason (the draft with the on-chain hash).
    await promoteDisputeDrafts().catch(() => 0);
    return {
      txHash,
      status: "confirmed",
      blockNumber: receipt.blockNumber.toString(),
      events: eventSummaries(receipt.logs),
      explorerUrl: explorerUrl(txHash),
    } satisfies ConfirmResponse & Record<string, unknown>;
  }),
);

// ---------- Faucet (testnets only) ----------

const FAUCET_DAILY_CAP = 200;
/** How long /api/faucet waits for the Moderato faucet's transfers to be mined before answering anyway. */
const FAUCET_RECEIPT_TIMEOUT_MS = 20_000;

/** Atomic reservation of a cooldown key: only one request per window can write it. false while in the cooldown. */
async function claimCooldown(key: string, windowSecs: number): Promise<boolean> {
  const rows = await db
    .insert(schema.kv)
    .values({ key, value: new Date().toISOString() })
    .onConflictDoUpdate({
      target: schema.kv.key,
      set: { value: new Date().toISOString(), updatedAt: new Date() },
      setWhere: sql`${schema.kv.updatedAt} < now() - make_interval(secs => ${windowSecs})`,
    })
    .returning();
  return rows.length > 0;
}

async function faucetDailyCount(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(schema.kv)
    .values({ key: `faucet:day:${day}`, value: 1 })
    .onConflictDoUpdate({ target: schema.kv.key, set: { value: sql`to_jsonb((${schema.kv.value})::text::int + 1)`, updatedAt: new Date() } })
    .returning();
  return Number(row?.value ?? 0);
}

/**
 * Funds the session wallet with the payment token. Moderato: the Tempo faucet RPC (`tempo_fundAddress`, T7); local
 * anvil: a transfer from the PLATFORM float on its nonce lane. Never on mainnet (env refuses FAUCET_ENABLED there).
 */
storeRouter.post(
  "/faucet",
  requireAuth,
  h(async (req): Promise<FaucetResponse> => {
    if (!env.FAUCET_ENABLED || env.CHAIN_ID === CHAIN.mainnet) throw badRequest("The faucet is disabled on this network", "faucet_disabled");
    const wallet = requireWallet(req) as Address;
    // Cooldown per wallet and per IP (new wallets cost nothing to create).
    if (!(await claimCooldown(`faucet:w:${wallet}`, 3600))) {
      throw new HttpError(429, "You recently received test funds. Try again in 1 hour.", "faucet_cooldown");
    }
    if (!(await claimCooldown(`faucet:ip:${req.ip}`, 600))) {
      throw new HttpError(429, "Too many test fund requests from this network. Try again in 10 minutes.", "faucet_cooldown");
    }
    if ((await faucetDailyCount()) > FAUCET_DAILY_CAP) throw new HttpError(429, "The faucet has reached today's limit.", "faucet_daily_cap");
    if (env.CHAIN_ID === CHAIN.local) {
      const amount = unitsFromNumber(env.FAUCET_AMOUNT);
      const { hash } = await sendServerCalls({
        signer: "platform",
        lane: "platform",
        calls: [{ to: env.PAYMENT_TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [wallet, amount] }) }],
        kind: "faucet",
        ref: wallet,
      });
      return { txHash: hash, amountUnits: amount.toString(), explorerUrl: explorerUrl(hash) };
    }
    // Moderato: the network's faucet funds pathUSD and the other test stablecoins (amount not published).
    const result = await chainContext().publicClient.request({ method: "tempo_fundAddress", params: [wallet] } as never);
    const hashes = ((Array.isArray(result) ? result : [result]) as unknown[]).filter((x): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x));
    // The faucet RPC answers before its transfers are mined: wait for them (bounded), so the balance the page re-reads
    // right after this answer already includes the funds. A slow one is not an error: the funds still arrive.
    await Promise.all(
      hashes.map((h) => chainContext().publicClient.waitForTransactionReceipt({ hash: h as Hex, timeout: FAUCET_RECEIPT_TIMEOUT_MS }).catch(() => undefined)),
    );
    return { txHash: (hashes[0]?.toLowerCase() as Hex | undefined) ?? null, amountUnits: null, txHashes: hashes };
  }),
);
