import { createSponsorRelay, decodeSolversError, type RelayRequestContext, type SponsoredTx } from "@solvers/chain";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Address, Chain, PublicClient, Transport } from "viem";
import type { LocalAccount } from "viem/accounts";

import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { chainContext } from "../chain/index.js";
import { sendTelegram } from "../notify/telegram.js";
import { GLOBAL_QUOTA_REFUSAL, QUOTA_WINDOW_MS, callsSummary, quotaRefusal, relayPolicy, senderRefusal, type RelayLimits } from "./rules.js";

// The platform relay (decisions.md D3): co-signs (as the RELAY key, fee payer only) Tempo 0x76 transactions of signed-in
// wallets that touch our contracts. On top of the pure policy of @solvers/chain (`checkSponsoredTransaction`), `check`
// enforces: sender == session wallet, a simulation of the whole batch (a sponsored revert still burns fees) and the daily
// gas quotas per wallet and per IP. viem co-signs a FILL before the sender signs it (packages/chain/src/relay.ts header),
// so quotas are counted at co-signing time: `check` reserves the gas in relay_log (status `reserved`, under an advisory
// lock per wallet and IP so parallel fills cannot overrun a quota) and `onSponsored` turns the reservation into
// `sponsored` with the fee-payer sign payload (and the tx hash on the raw path). A reservation whose co-signing failed stays
// counted (conservative). Refusals are logged with their reason.

/** Request context of one JSON-RPC call (one object per call: the reservation id travels in it). */
export type RelayCtx = RelayRequestContext & { method?: string; reservationId?: number };

export type RelayLog = {
  reserve(r: { sender: string; ip: string | null; method: string | null; gas: bigint; calls: { to: string; selector: string }[] }, l: RelayLimits): Promise<{ refusal: string } | { id: number }>;
  sponsored(e: { id?: number; sender: string; ip: string | null; method: string; signPayload: string; txHash: string | null; gas: bigint | null }): Promise<void>;
  refused(e: { sender: string | null; ip: string | null; method: string | null; reason: string; gas: bigint | null; calls: { to: string; selector: string }[] }): Promise<void>;
};

const ACTIVE = ["sponsored", "reserved"];

/** relay_log in Postgres. */
export const dbRelayLog: RelayLog = {
  async reserve(r, l) {
    return db.transaction(async (tx) => {
      // Serialize quota decisions per wallet, per network and globally (always in this order: no lock cycles).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay:w:${r.sender}`}))`);
      if (r.ip) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay:ip:${r.ip}`}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('relay:global'))`);
      const since = new Date(Date.now() - QUOTA_WINDOW_MS);
      const total = sql<string>`coalesce(sum(${schema.relayLog.gasLimit}), 0)::text`;
      const [w] = await tx
        .select({ total })
        .from(schema.relayLog)
        .where(and(eq(schema.relayLog.sender, r.sender), inArray(schema.relayLog.status, ACTIVE), gte(schema.relayLog.createdAt, since)));
      let ipUsed: bigint | null = null;
      if (r.ip) {
        const [i] = await tx
          .select({ total })
          .from(schema.relayLog)
          .where(and(eq(schema.relayLog.ip, r.ip), inArray(schema.relayLog.status, ACTIVE), gte(schema.relayLog.createdAt, since)));
        ipUsed = BigInt(i?.total ?? "0");
      }
      const [g] = await tx
        .select({ total })
        .from(schema.relayLog)
        .where(and(inArray(schema.relayLog.status, ACTIVE), gte(schema.relayLog.createdAt, since)));
      const refusal = quotaRefusal(r.gas, { wallet: BigInt(w?.total ?? "0"), ip: ipUsed, global: BigInt(g?.total ?? "0") }, l);
      if (refusal) return { refusal };
      const [row] = await tx
        .insert(schema.relayLog)
        .values({ sender: r.sender, ip: r.ip, method: r.method ?? "unknown", gasLimit: r.gas, calls: r.calls, status: "reserved" })
        .returning({ id: schema.relayLog.id });
      return { id: row!.id };
    });
  },
  async sponsored(e) {
    const set = { status: "sponsored", method: e.method, signPayload: e.signPayload.toLowerCase(), txHash: e.txHash?.toLowerCase() ?? null };
    if (e.id !== undefined) {
      const updated = await db.update(schema.relayLog).set(set).where(eq(schema.relayLog.id, e.id)).returning({ id: schema.relayLog.id });
      if (updated.length > 0) return;
    }
    await db.insert(schema.relayLog).values({ ...set, sender: e.sender, ip: e.ip, gasLimit: e.gas });
  },
  async refused(e) {
    await db.insert(schema.relayLog).values({ sender: e.sender, ip: e.ip, method: e.method ?? "unknown", gasLimit: e.gas, calls: e.calls, status: "refused", reason: e.reason.slice(0, 500) });
  },
};

let lastBudgetAlert = 0;

/** Tells the admins (at most once an hour) that the global daily sponsorship budget refuses transactions. */
function alertBudgetExhausted(): void {
  if (Date.now() - lastBudgetAlert < 3600_000) return;
  lastBudgetAlert = Date.now();
  const text = `Solvers relay: the daily sponsorship budget (RELAY_DAILY_GAS_GLOBAL=${env.RELAY_DAILY_GAS_GLOBAL}) is exhausted; sponsored transactions are refused.`;
  console.warn(`[ALERT] ${text}`);
  sendTelegram(env.TELEGRAM_ADMIN_CHAT_ID, text).catch(() => undefined);
}

export type RelayCheckDeps = {
  publicClient: Pick<PublicClient<Transport, Chain>, "estimateGas">;
  limits: RelayLimits;
  log: RelayLog;
};

/** Simulates the batch as the sender; returns the refusal (decoded custom error) or null. */
export async function simulationRefusal(pc: RelayCheckDeps["publicClient"], tx: SponsoredTx): Promise<string | null> {
  try {
    await pc.estimateGas({ account: tx.from as Address, calls: (tx.calls ?? []).map((c) => ({ to: c.to, data: c.data })) } as never);
    return null;
  } catch (e) {
    const d = decodeSolversError(e);
    return `simulation reverted: ${d.name}`;
  }
}

/** The server-side `check` of the relay: sender, simulation, then the quota reservation (in this order). */
export function relayCheck(deps: RelayCheckDeps) {
  return async (tx: SponsoredTx, ctx: RelayCtx): Promise<string | null> => {
    const bad = senderRefusal(tx.from, ctx.sender);
    if (bad) return bad;
    const sim = await simulationRefusal(deps.publicClient, tx);
    if (sim) return sim;
    const r = await deps.log.reserve(
      { sender: ctx.sender!.toLowerCase(), ip: ctx.ip ?? null, method: ctx.method ?? null, gas: tx.gas ?? 0n, calls: callsSummary(tx.calls) },
      deps.limits,
    );
    if ("refusal" in r) {
      if (r.refusal === GLOBAL_QUOTA_REFUSAL) alertBudgetExhausted();
      return r.refusal;
    }
    ctx.reservationId = r.id;
    return null;
  };
}

export function limitsFromEnv(): RelayLimits {
  return {
    maxGasPerTx: env.RELAY_MAX_GAS_PER_TX,
    maxFeePerGas: env.RELAY_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: env.RELAY_MAX_PRIORITY_FEE_PER_GAS,
    dailyGasPerWallet: env.RELAY_DAILY_GAS_PER_WALLET,
    dailyGasPerIp: env.RELAY_DAILY_GAS_PER_IP,
    dailyGasGlobal: env.RELAY_DAILY_GAS_GLOBAL,
  };
}

export type RelayService = { handle(body: unknown, ctx: RelayCtx): Promise<unknown> };

/** Builds the relay from the chain context (RELAY key, deployment, public client) and env (policy, quotas). */
export function createRelayService(o: { limits?: RelayLimits; log?: RelayLog } = {}): RelayService {
  const c = chainContext();
  const limits = o.limits ?? limitsFromEnv();
  const log = o.log ?? dbRelayLog;
  const feePayer = c.accounts.relay;
  if (feePayer.type !== "local") throw new Error("RELAY key must be a local account");
  const relay = createSponsorRelay({
    chain: c.chain,
    rpcUrl: env.RPC_URL,
    feePayer: feePayer as LocalAccount,
    policy: relayPolicy(env.CHAIN_ID, c.deployment, env.PAYMENT_TOKEN, limits),
    check: relayCheck({ publicClient: c.publicClient, limits, log }) as (tx: SponsoredTx, ctx: RelayRequestContext) => Promise<string | null>,
    onSponsored: async (event, ctx) => {
      const x = ctx as RelayCtx;
      await log.sponsored({
        id: x.reservationId,
        sender: event.sender.toLowerCase(),
        ip: x.ip ?? null,
        method: event.method,
        signPayload: event.signPayload,
        txHash: event.transactionHash ?? null,
        gas: null,
      });
    },
    onRefused: (reason, tx, ctx) => {
      const x = ctx as RelayCtx;
      log
        .refused({ sender: (tx?.from ?? x.sender ?? null)?.toLowerCase() ?? null, ip: x.ip ?? null, method: x.method ?? null, reason, gas: tx?.gas ?? null, calls: callsSummary(tx?.calls) })
        .catch((e: unknown) => console.error("[relay] could not log a refusal", e));
    },
  });
  return { handle: (body, ctx) => relay.handle(body, ctx) };
}
