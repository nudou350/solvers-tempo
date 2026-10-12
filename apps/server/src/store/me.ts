import { Router } from "express";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { averageRating, bpsToScore, MEMORY_KEY_MESSAGE, type ConnectorStatus, type CreatorDashboard, type Memory } from "@solvers/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { requireAuth, requireWallet } from "../auth/jwt.js";
import { badRequest, h, HttpError, notFound, parse, unauthorized } from "../lib/http.js";
import { deleteAllMemories, deleteMemory, memoryKeyFor, memoryKeyFromSignature, readMemories, storeMemoryKey, wrapKey } from "../memory/crypto.js";
import { getCreator } from "./catalog.js";
import { catalogLangOf } from "./lang-rules.js";
import { supplyOfRow } from "./supply-rules.js";
import { currentEvalBps } from "./mappers.js";
import { agentOnChain, deploymentOrNull, registryConfig, slashOnChain, stakeExitOnChain } from "./chain-reads.js";
import { slashView, stakeExitView, sumUnits, unitsFromSql } from "./dashboard-rules.js";

export const meRouter = Router();

// ---------- Memories (storefront) ----------

/** The storefront asks the wallet to sign the fixed message (EIP-191, D8) and sends it here; the key lasts as long as the session. */
meRouter.post(
  "/me/memory-key",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    if (!req.tokenId) throw unauthorized("Session has no identifier; please sign in again");
    const { signature } = parse(z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4000) }), req.body);
    const key = await memoryKeyFromSignature(wallet, signature);
    // Not 401: the session itself is fine (a 401 would sign the person out); only this signature was refused.
    if (!key) throw badRequest("The wallet signature was refused: sign the memory message with the signed-in wallet.", "memory_signature_refused");
    await storeMemoryKey(req.tokenId, wallet, wrapKey(key), new Date(Date.now() + 24 * 3600 * 1000));
    return { ok: true };
  }),
);

meRouter.get(
  "/me/memories",
  requireAuth,
  h(async (req): Promise<Memory[]> => {
    const wallet = requireWallet(req);
    const key = await memoryKeyFor(req.tokenId, wallet);
    if (!key) {
      throw new HttpError(409, "To see your memories, confirm the signature in your wallet.", "memory_key_required", {
        message: MEMORY_KEY_MESSAGE,
      });
    }
    const mems = await readMemories(wallet, key);
    return mems.map((m) => ({ id: m.id, agentId: m.agentId, summary: m.summary, profile: m.profile, notes: m.notes, updatedAt: m.updatedAt.toISOString() }));
  }),
);

meRouter.get(
  "/me/memories/count",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const rows = await db
      .select({ agentId: schema.memories.agentId, updatedAt: schema.memories.updatedAt })
      .from(schema.memories)
      .where(eq(schema.memories.wallet, wallet));
    return { count: rows.length, agents: rows.map((r) => ({ agentId: r.agentId, updatedAt: r.updatedAt.toISOString() })) };
  }),
);

meRouter.delete(
  "/me/memories/:id",
  requireAuth,
  h(async (req) => {
    if (!(await deleteMemory(requireWallet(req), String(req.params.id)))) throw notFound("Memory not found");
    return { ok: true };
  }),
);

meRouter.delete(
  "/me/memories",
  requireAuth,
  h(async (req) => {
    await deleteAllMemories(requireWallet(req));
    return { ok: true };
  }),
);

// ---------- Connector ----------

meRouter.get(
  "/connector",
  requireAuth,
  h(async (req): Promise<ConnectorStatus> => {
    const wallet = requireWallet(req);
    const rows = await db
      .select({ clientId: schema.oauthTokens.clientId, createdAt: schema.oauthTokens.createdAt, metadata: schema.oauthClients.metadata })
      .from(schema.oauthTokens)
      .innerJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthTokens.clientId))
      .where(and(eq(schema.oauthTokens.wallet, wallet), eq(schema.oauthTokens.revoked, false), gt(schema.oauthTokens.expiresAt, new Date())))
      .orderBy(desc(schema.oauthTokens.createdAt));
    const seen = new Set<string>();
    const authorizedClients = rows
      .filter((r) => (seen.has(r.clientId) ? false : seen.add(r.clientId)))
      .map((r) => ({ clientName: String((r.metadata as { client_name?: string }).client_name ?? "AI assistant"), authorizedAt: r.createdAt.toISOString() }));
    return { url: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/mcp`, authorizedClients };
  }),
);

meRouter.post(
  "/connector/revoke",
  requireAuth,
  h(async (req) => {
    const wallet = requireWallet(req);
    const toks = await db
      .update(schema.oauthTokens)
      .set({ revoked: true })
      .where(and(eq(schema.oauthTokens.wallet, wallet), eq(schema.oauthTokens.revoked, false)))
      .returning({ id: schema.oauthTokens.id });
    if (toks.length) await db.delete(schema.memoryKeys).where(inArray(schema.memoryKeys.tokenId, toks.map((t) => t.id)));
    return { revoked: toks.length };
  }),
);

// ---------- Creator dashboard ----------

type DashAgent = CreatorDashboard["agents"][number];
type LiveState = Pick<DashAgent, "chainRead" | "stakeExit" | "slash" | "metadataUri">;

/** Upper bound of the live Staking/Registry reads of one Solver: a slow RPC must not hold the whole dashboard. */
const LIVE_READ_TIMEOUT_MS = 4000;

/**
 * Stake exit, pending slash and metadata link of a Solver, read live from the contracts. Not registered on-chain: none of
 * them exists. RPC failure or timeout: `chainRead: false` and every field null (unknown), never an error for the page.
 */
async function liveAgentState(agentId: string, registered: boolean): Promise<LiveState> {
  const unknown: LiveState = { chainRead: false, stakeExit: null, slash: null, metadataUri: null };
  if (!registered) return { chainRead: true, stakeExit: null, slash: null, metadataUri: null };
  if (!deploymentOrNull()) return unknown;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("live read timeout")), LIVE_READ_TIMEOUT_MS);
  });
  try {
    const reads = Promise.all([agentOnChain(agentId), stakeExitOnChain(agentId), slashOnChain(agentId)]);
    const [agent, exit, slash] = await Promise.race([reads, timeout]);
    return { chainRead: true, stakeExit: stakeExitView(exit), slash: slashView(slash), metadataUri: agent?.metadataUri || null };
  } catch (e) {
    console.warn(`[dashboard] live reads of ${agentId} failed: ${(e as Error).message}`);
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

meRouter.get(
  "/creator/dashboard",
  requireAuth,
  h(async (req, res): Promise<CreatorDashboard> => {
    const wallet = requireWallet(req);
    const lang = catalogLangOf(req, res);
    const [creatorRow] = await db.select().from(schema.creators).where(eq(schema.creators.wallet, wallet));
    const empty: CreatorDashboard = {
      creator: null,
      totals: { sales: 0, uses: 0, salesRevenueUnits: "0", royaltiesUnits: "0", disputesOpened: 0, disputesOpen: 0, disputesLost: 0 },
      last30: { sales: 0, uses: 0, revenueUnits: "0" },
      creatorSharePct: 90,
      agents: [],
      daily: [],
      guarantee: { earnedUnits: "0", last30Units: "0", releases: 0, recent: [] },
      disputes: [],
    };
    if (!creatorRow) return empty;
    // The current fee only serves to show "your share" and for rows without recorded amounts. Revenue adds what each
    // transaction really paid the creator (chain_txs.creator_amount, from the event), never recomputed.
    const feeBps = Math.trunc((await registryConfig())?.feeBps ?? 1000);
    const creatorSharePct = (10_000 - feeBps) / 100;
    empty.creatorSharePct = creatorSharePct;
    const tx = schema.chainTxs;
    // Transaction date = block time (created_at is when the indexer saw it).
    const when = sql`coalesce(${tx.blockTime}, ${tx.createdAt})`;
    // Creator share of each sale: the executed amount; without it, the gross minus the fee recorded on the transaction
    // (or, only if that is missing too, the current fee), floored like the contract. numeric: no bigint overflow.
    const creatorCut = sql`coalesce(${tx.creatorAmount}::numeric, ${tx.amount}::numeric - div(${tx.amount}::numeric * coalesce(${tx.feeBps}, ${sql.raw(String(feeBps))}), 10000))`;
    const agents = await db.select().from(schema.agents).where(eq(schema.agents.creatorId, creatorRow.id));
    if (agents.length === 0) return { ...empty, creator: await getCreator(creatorRow.id, lang) };
    const ids = agents.map((a) => a.id);

    // Disputes on guarantee milestones of this creator's Solvers.
    const disputeRows = await db
      .select({
        escrowId: schema.milestones.escrowId,
        index: schema.milestones.idx,
        agentId: schema.escrows.agentId,
        taskTitle: schema.escrows.title,
        milestoneTitle: schema.milestones.title,
        criterion: schema.milestones.disputeCriterion,
        reason: schema.milestones.disputeReason,
        amount: schema.milestones.amount,
        status: schema.milestones.status,
        openedAt: schema.milestones.disputedAt,
      })
      .from(schema.milestones)
      .innerJoin(schema.escrows, eq(schema.escrows.id, schema.milestones.escrowId))
      // disputedAt is written only once the dispute is confirmed on-chain (abandoned attempts stay out).
      .where(and(inArray(schema.escrows.agentId, ids), isNotNull(schema.milestones.disputedAt)))
      .orderBy(desc(schema.milestones.disputedAt));
    const disputes = disputeRows
      .filter((d) => ["disputed", "refunded", "approved"].includes(d.status))
      .map((d) => ({
        escrowId: d.escrowId,
        index: d.index,
        agentId: d.agentId,
        taskTitle: d.taskTitle,
        milestoneTitle: d.milestoneTitle,
        criterion: d.criterion,
        reason: d.reason,
        amountUnits: d.amount.toString(),
        openedAt: d.openedAt?.toISOString() ?? null,
        result: (d.status === "disputed" ? "open" : d.status === "refunded" ? "buyer" : "creator") as "open" | "buyer" | "creator",
      }));
    const disputesBy = new Map<string, number>();
    for (const d of disputes) disputesBy.set(d.agentId, (disputesBy.get(d.agentId) ?? 0) + 1);

    // Revenue by what the creator really received (licenses and credit packs), net of the platform fee.
    const paid = await db
      .select({ agentId: tx.agentId, sum: sql<string>`coalesce(sum(${creatorCut}), 0)::text` })
      .from(tx)
      .where(and(inArray(tx.agentId, ids), inArray(tx.kind, ["purchase", "credits"])))
      .groupBy(tx.agentId);
    const paidBy = new Map(paid.map((p) => [p.agentId, unitsFromSql(p.sum)]));

    const live = await Promise.all(agents.map((a) => liveAgentState(a.id, a.chainIndex != null)));
    const perAgent: DashAgent[] = agents.map((a, i) => ({
      agentId: a.id,
      slug: a.slug,
      name: (lang === "pt" ? a.translations?.pt?.name : undefined) || a.name,
      category: a.category,
      version: a.version,
      status: (["active", "pending", "suspended", "retired"].includes(a.status) ? a.status : "pending") as DashAgent["status"],
      listed: a.listed,
      userRating: averageRating(a.ratingSum, a.ratingCount),
      evalScore: bpsToScore(currentEvalBps(a)),
      sales: Number(a.totalSales),
      uses: Number(a.verifiedUses),
      revenueUnits: (paidBy.get(a.id) ?? 0n).toString(),
      disputes: disputesBy.get(a.id) ?? 0,
      supply: supplyOfRow(a),
      priceUnits: a.price.toString(),
      pricePerUseUnits: a.pricePerUse.toString(),
      royaltyBps: a.royaltyBps,
      stakeUnits: a.stake.toString(),
      ...live[i]!,
    }));

    const daily = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${when}), 'YYYY-MM-DD')`,
        // "Sales" = licenses (same count as the on-chain total); revenue includes the credit packs.
        sales: sql<number>`count(*) filter (where ${tx.kind} = 'purchase')`.mapWith(Number),
        revenue: sql<string>`coalesce(sum(${creatorCut}) filter (where ${tx.kind} in ('purchase', 'credits')), 0)::text`,
      })
      .from(tx)
      .where(and(inArray(tx.agentId, ids), inArray(tx.kind, ["purchase", "credits"]), gt(when, sql`now() - interval '30 days'`)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const usesDaily = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${schema.usageEvents.createdAt}), 'YYYY-MM-DD')`,
        uses: sql<number>`count(*)`.mapWith(Number),
      })
      .from(schema.usageEvents)
      .where(and(inArray(schema.usageEvents.agentId, ids), eq(schema.usageEvents.tool, "activate_solver"), gt(schema.usageEvents.createdAt, sql`now() - interval '30 days'`)))
      .groupBy(sql`1`);
    const usesBy = new Map(usesDaily.map((u) => [u.date, u.uses]));
    const revenueBy = new Map(daily.map((d) => [d.date, { sales: d.sales, revenue: unitsFromSql(d.revenue) }]));
    const dates = new Set([...daily.map((d) => d.date), ...usesDaily.map((u) => u.date)]);
    const dailyOut = [...dates].sort().map((date) => {
      const d = revenueBy.get(date);
      return { date, sales: d?.sales ?? 0, uses: usesBy.get(date) ?? 0, revenue: d?.revenue ?? 0n };
    });

    // Guarantee earnings: milestones paid to the creator (approval, auto-release or a dispute the creator won).
    const [g] = await db
      .select({
        total: sql<string>`coalesce(sum(${tx.creatorAmount}), 0)::text`,
        releases: sql<number>`count(*) filter (where ${tx.creatorAmount} > 0)`.mapWith(Number),
        last30: sql<string>`coalesce(sum(${tx.creatorAmount}) filter (where ${when} > now() - interval '30 days'), 0)::text`,
      })
      .from(tx)
      .where(and(inArray(tx.agentId, ids), eq(tx.kind, "release")));
    const recentGuarantee = await db
      .select({
        txHash: tx.txHash,
        agentId: tx.agentId,
        amount: tx.creatorAmount,
        at: sql<string>`to_char(${when} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      })
      .from(tx)
      .where(and(inArray(tx.agentId, ids), eq(tx.kind, "release"), gt(tx.creatorAmount, 0n)))
      .orderBy(desc(when))
      .limit(10);
    const guarantee = {
      earnedUnits: unitsFromSql(g?.total).toString(),
      last30Units: unitsFromSql(g?.last30).toString(),
      releases: g?.releases ?? 0,
      recent: recentGuarantee.map((r) => ({ txHash: r.txHash as `0x${string}`, agentId: r.agentId, amountUnits: (r.amount ?? 0n).toString(), at: r.at })),
    };

    // Royalties from license transfers: the creator share of each transfer of this creator's Solvers, as the event recorded it.
    const [royalty] = await db
      .select({ total: sql<string>`coalesce(sum(${tx.creatorAmount}), 0)::text` })
      .from(tx)
      .where(and(inArray(tx.agentId, ids), eq(tx.kind, "royalty")));

    const count = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
    return {
      creator: await getCreator(creatorRow.id, lang),
      totals: {
        sales: count(perAgent, (a) => a.sales),
        uses: count(perAgent, (a) => a.uses),
        salesRevenueUnits: sumUnits(perAgent.map((a) => BigInt(a.revenueUnits))).toString(),
        royaltiesUnits: unitsFromSql(royalty?.total).toString(),
        disputesOpened: disputes.length,
        disputesOpen: disputes.filter((d) => d.result === "open").length,
        disputesLost: count(agents, (a) => a.disputesLost),
      },
      last30: {
        sales: count(dailyOut, (d) => d.sales),
        uses: count(dailyOut, (d) => d.uses),
        revenueUnits: sumUnits(dailyOut.map((d) => d.revenue)).toString(),
      },
      creatorSharePct,
      agents: perAgent,
      daily: dailyOut.map((d) => ({ date: d.date, sales: d.sales, uses: d.uses, revenueUnits: d.revenue.toString() })),
      guarantee,
      disputes,
    };
  }),
);
