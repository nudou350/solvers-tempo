// What each Solvers event does to the mirror (D9). Planning happens in two steps so no RPC call runs inside a database
// transaction: `planEvent` re-reads the contract state by id (eth_call) and returns
//   - `effects`: database writes, run inside the event's transaction together with the `processed_events` row (also
//     re-run by a forced reindex: they only mirror the current chain state);
//   - `once`: in-transaction side effects that run only the first time (the payments hook);
//   - `after`: side effects (notifications, governance subscribers), run once, after the commit, only for new events.

import { eq } from "drizzle-orm";
import { formatUnits, type Hex } from "viem";
import type { SolversLog } from "@solvers/chain";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { sendTelegram } from "../notify/telegram.js";
import { onSaleAuthorized } from "../payments/hooks.js";
import type { Tx } from "./db-types.js";
import { emitGovernanceChange, GOVERNANCE_EVENTS, governanceAlertText, isFreshForAlert } from "./governance.js";
import { chainTxFor, type KindContext } from "./kinds.js";
import {
  mirrorAgentAccount,
  mirrorableAgentId,
  readAgent,
  readCredits,
  readDeferred,
  readEscrow,
  readEvalOf,
  readLicense,
  readReputation,
  readReview,
  readVersionHashAt,
  recordChainTx,
  writeCredits,
  writeDeferred,
  writeEscrow,
  writeEval,
  writeLicense,
  writeReputation,
  writeReview,
  type Reads,
} from "./sync.js";

export type Effect = (tx: Tx) => Promise<void>;
export type Plan = { effects: Effect[]; once: Effect[]; after: (() => Promise<void>)[] };
export type EventContext = { reads: Reads; blockTime: (blockNumber: bigint) => Promise<Date | null> };

const AGENT_EVENTS = new Set([
  "AgentRegistered",
  "AgentStatusChanged",
  "AgentVersionUpdated",
  "AgentMetadataUpdated",
  "PricingUpdated",
  "RoyaltyBpsSet",
  "SupplyCapSet",
  "AgentDisputeLost",
  "StakeChanged",
  "UsageRecorded",
  "StakeExitRequested",
  "StakeExitExtended",
  "StakeExitCancelled",
  "SlashProposed",
  "SlashContested",
  "SlashCancelled",
]);
const ESCROW_EVENTS = new Set(["MilestoneUpdated", "DisputeResolved", "EscrowStatusChanged"]);
const PAYOUT_CONTRACTS = new Set(["license", "credits", "escrow", "staking"]);
const ADMIN_ALERT_EVENTS = new Set(["SlashProposed", "SlashExecuted", "SlashContested", "StakeExitExtended"]);

const ZERO = "0x0000000000000000000000000000000000000000";
const s = (v: unknown) => String(v).toLowerCase();
const money = (v: unknown) => `${formatUnits(BigInt(v as bigint), env.PAYMENT_TOKEN_DECIMALS)} ${env.PAYMENT_TOKEN_SYMBOL}`;

export async function alertAdmins(text: string, at?: Date | null): Promise<void> {
  console.warn(`[ALERT] ${text}`);
  if (isFreshForAlert(at)) await sendTelegram(env.TELEGRAM_ADMIN_CHAT_ID, text);
}

/** Effect that re-mirrors an agent (read now, write in the transaction). Empty when absent or not mirrorable. */
async function agentEffect(agentId: string, c: EventContext): Promise<{ effect: Effect | null; creator: string | null; id: string | null }> {
  const id = mirrorableAgentId(agentId);
  if (!id) return { effect: null, creator: null, id: null };
  const st = await readAgent(id, c.reads);
  if (!st) return { effect: null, creator: null, id };
  return { effect: async (tx) => void (await mirrorAgentAccount(st, tx)), creator: st.view.creator, id };
}

/** PayoutDeferred: tell the recipient (a creator on Telegram, else the admins) that a payment waits for `claim()`. */
async function notifyDeferred(contract: string, to: string, amount: unknown, total: unknown, at: Date | null): Promise<void> {
  if (!isFreshForAlert(at)) return void console.warn(`[indexer] old PayoutDeferred to ${to} (not notified)`);
  const [creator] = await db.select({ chat: schema.creators.telegramChatId }).from(schema.creators).where(eq(schema.creators.wallet, to));
  const text =
    `Solvers: a payment of ${money(amount)} to ${to} could not be delivered (the wallet refuses incoming transfers) and is ` +
    `held by the ${contract} contract (total held: ${money(total)}). Claim it from the dashboard once the wallet accepts transfers.`;
  if (creator?.chat) await sendTelegram(creator.chat, text);
  else await alertAdmins(text, at);
}

/**
 * Plans one event. `siblings` are all decoded Solvers events of the same transaction (the payments hook reads the sale
 * amounts from them instead of fetching the receipt).
 */
export async function planEvent(ev: SolversLog, c: EventContext, siblings: readonly SolversLog[] = [ev]): Promise<Plan> {
  const effects: Effect[] = [];
  const once: Effect[] = [];
  const after: (() => Promise<void>)[] = [];
  const a = ev.args as unknown as Record<string, unknown>;
  const name = ev.eventName as string;
  const txHash = s(ev.transactionHash);
  const logIndex = ev.logIndex;
  const blockNumber = ev.blockNumber;
  const ref = async (agentId: string | null) => ({ txHash, logIndex, blockNumber, blockTime: await c.blockTime(blockNumber), agentId });
  const push = (e: Effect | null) => e && effects.push(e);
  const alert = async (text: string) => alertAdmins(text, await c.blockTime(blockNumber));
  const money_ = async (agentId: string | null, kctx: KindContext) => {
    const spec = chainTxFor({ eventName: name, args: a }, kctx);
    if (spec) {
      const r = await ref(agentId);
      effects.push((tx) => recordChainTx(tx, r, spec));
    }
  };

  if (GOVERNANCE_EVENTS.has(name)) {
    // Events without parameters (e.g. DefaultAdminDelayChangeCanceled) decode with no args.
    const change = { name, contract: ev.contract, args: a ?? {}, txHash, blockNumber };
    after.push(async () => {
      emitGovernanceChange(change);
      await alert(governanceAlertText(change));
    });
    return { effects, once, after };
  }

  if (AGENT_EVENTS.has(name)) {
    const ag = await agentEffect(s(a.agentId), c);
    push(ag.effect);
    if (ADMIN_ALERT_EVENTS.has(name)) after.push(() => alert(`Solvers staking: ${name} for agent ${s(a.agentId)} (tx ${txHash})`));
    return { effects, once, after };
  }

  switch (name) {
    case "EvalSet": {
      const ag = await agentEffect(s(a.agentId), c);
      push(ag.effect);
      const st = ag.id ? await readAgent(ag.id, c.reads) : null;
      // An eval of a version that is no longer current is kept with its versionHash (D6), unless the current one is measured.
      if (ag.id && st && !st.eval.measured) {
        const vh = s(a.versionHash) as Hex;
        const e = await readEvalOf(ag.id, vh);
        const id = ag.id;
        if (e) effects.push((tx) => writeEval(tx, id, vh, e));
      }
      break;
    }
    case "SaleAuthorized": {
      // The payments module matches it to its ledger row by (payer, purchaseId); inside the event's transaction, so a
      // failure retries the event and a replay is a no-op for the payments module. Its admin alerts are deferred until
      // after the commit (no network call while the transaction is open).
      const e = {
        purchaseId: s(a.purchaseId) as Hex,
        agentId: s(a.agentId) as Hex,
        buyer: s(a.buyer) as Hex,
        payer: s(a.payer) as Hex,
        kind: Number(a.kind),
        ref: s(a.ref) as Hex,
        txHash: txHash as Hex,
        logIndex,
        blockNumber,
        siblings: siblings.filter((x) => s(x.transactionHash) === txHash),
      };
      const deferred: (() => Promise<unknown>)[] = [];
      once.push(async () => {
        const r = await onSaleAuthorized(e);
        if (r?.after) deferred.push(...r.after);
      });
      after.push(async () => {
        for (const fn of deferred) await fn().catch((err: unknown) => console.error("[indexer] payments alert:", (err as Error).message));
      });
      break;
    }
    case "ReputationChanged": {
      const wallet = s(a.wallet);
      const r = await readReputation(wallet, c.reads);
      effects.push((tx) => writeReputation(tx, wallet, r));
      break;
    }
    case "LicensePurchased": {
      const ag = await agentEffect(s(a.agentId), c);
      push(ag.effect);
      const l = await readLicense(BigInt(a.tokenId as bigint), c.reads);
      if (l && ag.id) {
        const versionHash = await readVersionHashAt(ag.id, blockNumber, c.reads);
        const acquiredAt = await c.blockTime(blockNumber);
        effects.push(async (tx) => void (await writeLicense(tx, l, { acquiredAt, lastOwner: s(a.buyer), txHash, versionHash })));
      }
      await money_(ag.id, { creator: ag.creator });
      break;
    }
    case "Transfer": {
      if (ev.contract !== "license") break;
      const from = s(a.from);
      const to = s(a.to);
      const l = await readLicense(BigInt(a.tokenId as bigint), c.reads);
      if (!l) break;
      const acquiredAt = await c.blockTime(blockNumber);
      // The block time is the acquisition time only if this transfer gave the token to its current owner.
      const fresh = l.owner === to ? acquiredAt : new Date();
      effects.push(async (tx) => void (await writeLicense(tx, l, { acquiredAt: fresh, lastOwner: to === ZERO ? from : to, txHash: from === ZERO ? txHash : null })));
      break;
    }
    case "LicenseReviewed": {
      const l = await readLicense(BigInt(a.tokenId as bigint), c.reads);
      if (l) effects.push(async (tx) => void (await writeLicense(tx, l)));
      break;
    }
    case "RoyaltyPaid": {
      const l = await readLicense(BigInt(a.tokenId as bigint), c.reads);
      await money_(l ? mirrorableAgentId(l.agentId) : null, {});
      break;
    }
    case "CreditsBought":
    case "CreditsConsumed": {
      const ag = await agentEffect(s(a.agentId), c);
      push(ag.effect);
      const owner = s(name === "CreditsBought" ? a.buyer : a.owner);
      if (ag.id) {
        const id = ag.id;
        const cr = await readCredits(id, owner, c.reads);
        effects.push((tx) => writeCredits(tx, id, owner, cr));
      }
      if (name === "CreditsBought") await money_(ag.id, { creator: ag.creator });
      break;
    }
    case "ReviewSubmitted": {
      const ag = await agentEffect(s(a.agentId), c);
      push(ag.effect);
      if (!ag.id) break;
      const id = ag.id;
      const author = s(a.author);
      const r = await readReview(id, author, c.reads);
      if (!r) break;
      // Version current at THIS submission, only if this event is still the review's latest state (D6).
      const latest = s(r.contentHash) === s(a.contentHash) && r.rating === Number(a.rating);
      const versionHash = latest ? await readVersionHashAt(id, blockNumber, c.reads) : null;
      effects.push((tx) => writeReview(tx, id, author, r, versionHash));
      break;
    }
    case "EscrowCreated":
    case "MilestonePaid":
    case "MilestoneRefunded":
    case "MilestoneUpdated":
    case "DisputeResolved":
    case "EscrowStatusChanged": {
      const e = await readEscrow(BigInt(a.escrowId as bigint), c.reads);
      if (!e) break;
      const created = name === "EscrowCreated";
      effects.push(async (tx) => void (await writeEscrow(tx, e, created ? { purchaseId: s(a.purchaseId), txHash } : {})));
      if (!ESCROW_EVENTS.has(name)) await money_(mirrorableAgentId(e.agentId), { creator: e.creator, escrow: { buyer: e.buyer, creator: e.creator, feeBps: e.feeBps } });
      break;
    }
    case "StakePulled":
    case "StakeToppedUp":
    case "StakeWithdrawn":
    case "SlashExecuted": {
      const ag = await agentEffect(s(a.agentId), c);
      push(ag.effect);
      await money_(ag.id, { creator: ag.creator });
      if (ADMIN_ALERT_EVENTS.has(name)) after.push(() => alert(`Solvers staking: ${name} for agent ${s(a.agentId)}: ${money(a.amount)} (tx ${txHash})`));
      break;
    }
    case "PayoutDeferred":
    case "PayoutClaimed": {
      if (!PAYOUT_CONTRACTS.has(ev.contract)) break;
      const to = s(a.to);
      const contract = s(ev.address);
      const amount = await readDeferred(contract, to);
      effects.push((tx) => writeDeferred(tx, contract, to, amount));
      if (name === "PayoutClaimed") await money_(null, {});
      else after.push(async () => notifyDeferred(ev.contract, to, a.amount, a.total, await c.blockTime(blockNumber)));
      break;
    }
    default:
      // Approval, ApprovalForAll, Initialized, ...: nothing to mirror (the event is still marked processed).
      break;
  }
  return { effects, once, after };
}
