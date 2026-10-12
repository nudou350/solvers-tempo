import { NONCE_LANES, type Call } from "@solvers/chain";
import { and, desc, eq, inArray } from "drizzle-orm";
import { keccak256, type Account, type Hex, type TransactionReceipt } from "viem";
import { Actions } from "viem/tempo";

import { db, pool, schema } from "../db/index.js";
import { chainContext } from "./index.js";

/**
 * Server-sent transactions (D3, D11). Every server key (PLATFORM float purchases and usage batches, VERIFIER marks and
 * evals, the dev-only admin) sends on its own 2D nonce lane, with the fee paid in-process by the RELAY key. The hash is
 * computed locally and written to `sent_txs` BEFORE broadcast, so a crash between broadcast and bookkeeping is
 * recoverable (reconcile by hash); `validBefore` makes a transaction that never lands expire instead of hanging.
 * Within one (account, lane) sends are serialized across processes (in-process queue + Postgres advisory lock) and the
 * lane stays held until the transaction landed or can no longer land (`validBefore`), so a nonce is never reused while
 * a transaction carrying it may still be included. Different lanes and keys run in parallel.
 */
export type ServerSigner = "platform" | "verifier" | "admin";
export type Lane = keyof typeof NONCE_LANES;

export type SendServerOptions = {
  signer: ServerSigner;
  lane: Lane;
  calls: readonly Call[];
  /** What the transaction does (pix-fulfil, agent-pay-fulfil, mark-passed, usage-batch, set-eval, admin-*). */
  kind: string;
  /** Business reference (chargeId, `${escrowId}:${index}`, batch id). */
  ref?: string;
  /** Explicit gas limit (skips estimation). */
  gas?: bigint;
  /** Seconds until the transaction expires if not included. Default 60. */
  validitySecs?: number;
  /** Minimum receipt wait in ms; the wait always covers the validity window (until `validBefore` + 5 s). */
  timeoutMs?: number;
  /**
   * Called with the locally computed hash after it is journaled and BEFORE broadcast (e.g. to store it on a ledger row).
   * If it throws, nothing is broadcast and the journal row is marked failed.
   */
  onSigned?: (hash: Hex) => Promise<void>;
};

export type SendServerResult = { hash: Hex; nonce: bigint; receipt: TransactionReceipt };

const locks = new Map<string, Promise<unknown>>();

/** In-process queue per (account, lane): avoids holding a database connection per waiting send. */
function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Cross-process lock per (account, lane): the API, the CLIs (approve, publish, seed, admin) and any other process using
 * the same key and lane take a Postgres session advisory lock on a dedicated connection, so two processes never read the
 * same chain nonce.
 */
function withLaneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withLocalLock(key, async () => {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [`lane:${key}`]);
      try {
        return await fn();
      } finally {
        await client.query("select pg_advisory_unlock(hashtext($1))", [`lane:${key}`]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  });
}

function signerAccount(signer: ServerSigner): { account: Account; wallet: ReturnType<typeof chainContext>["wallets"]["platform"] } {
  const c = chainContext();
  if (signer === "admin") {
    if (!c.accounts.admin || !c.wallets.admin) throw new Error("ADMIN_PRIVATE_KEY is not configured (dev/demo only)");
    return { account: c.accounts.admin, wallet: c.wallets.admin };
  }
  return { account: c.accounts[signer], wallet: c.wallets[signer] };
}

/** The error and its causes (viem wraps errors several levels deep). */
function causes(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let x: unknown = e, i = 0; x && i < 10; x = (x as { cause?: unknown }).cause, i++) out.push(x);
  return out;
}

const TRANSPORT_ERRORS = ["HttpRequestError", "TimeoutError", "WebSocketRequestError", "SocketClosedError"];

/**
 * True when the node answered the broadcast with a JSON-RPC error (a definitive rejection: the transaction is not in the
 * pool). Transport failures (HTTP errors, timeouts) are ambiguous: the node may have accepted the transaction.
 */
export function isDefinitiveRejection(e: unknown): boolean {
  const chain = causes(e);
  if (chain.some((x) => TRANSPORT_ERRORS.includes((x as Error)?.name))) return false;
  return chain.some((x) => typeof (x as { code?: unknown })?.code === "number");
}

/** True when the error says the node has no receipt for the hash (as opposed to an RPC failure). */
export function isReceiptNotFound(e: unknown): boolean {
  return causes(e).some((x) => (x as Error)?.name === "TransactionReceiptNotFoundError");
}

const POLL_MS = 500;
const MARGIN_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls for the receipt until `deadline`. Returns the receipt, "absent" when the node reports no receipt at the deadline,
 * or "unknown" when the RPC was failing (the caller must not assume the transaction is gone).
 */
async function receiptUntil(hash: Hex, deadline: number): Promise<TransactionReceipt | "absent" | "unknown"> {
  const pc = chainContext().publicClient;
  for (;;) {
    let notFound = false;
    try {
      return await pc.getTransactionReceipt({ hash });
    } catch (e) {
      notFound = isReceiptNotFound(e);
    }
    if (Date.now() >= deadline) return notFound ? "absent" : "unknown";
    await sleep(POLL_MS);
  }
}

/** Sends `calls` as one sponsored Tempo transaction from a server key and waits for it. Throws if it reverts. */
export async function sendServerCalls(o: SendServerOptions): Promise<SendServerResult> {
  const c = chainContext();
  const { account, wallet } = signerAccount(o.signer);
  const nonceKey = NONCE_LANES[o.lane];
  const key = `${account.address.toLowerCase()}:${nonceKey}`;
  return withLaneLock(key, async () => {
    const nonce = await Actions.nonce.getNonce(c.publicClient as never, { account: account.address, nonceKey });
    const validBefore = Math.floor(Date.now() / 1000) + (o.validitySecs ?? 60);
    const request = await wallet.prepareTransactionRequest({
      calls: o.calls.map((x) => ({ to: x.to, data: x.data })),
      feePayer: c.accounts.relay,
      nonceKey,
      nonce: Number(nonce),
      validBefore,
      ...(o.gas !== undefined ? { gas: o.gas } : {}),
    } as never);
    const serialized = (await wallet.signTransaction(request as never)) as Hex;
    const hash = keccak256(serialized);
    await db.insert(schema.sentTxs).values({
      account: account.address.toLowerCase(),
      lane: Number(nonceKey),
      nonce: BigInt(nonce),
      txHash: hash,
      kind: o.kind,
      ref: o.ref ?? null,
      status: "pending",
      validBefore: new Date(validBefore * 1000),
    });
    try {
      await o.onSigned?.(hash);
    } catch (e) {
      await markSent(hash, "failed", `onSigned: ${(e as Error).message}`);
      throw e;
    }
    try {
      await c.publicClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      if (isDefinitiveRejection(e)) {
        await markSent(hash, "failed", (e as Error).message);
        throw e;
      }
      // Ambiguous (transport error, timeout): the node may hold the transaction. Wait for it like a normal send.
      console.warn(`[lanes] broadcast of ${hash} (${o.kind}) is uncertain: ${(e as Error).message}`);
    }
    // Held for the whole validity window: the next send on this lane never reuses a nonce that may still be consumed.
    const deadline = Math.max(validBefore * 1000 + MARGIN_MS, Date.now() + (o.timeoutMs ?? 0));
    const r = await receiptUntil(hash, deadline);
    if (r === "absent") {
      await markSent(hash, "expired");
      throw new Error(`server transaction ${hash} (${o.kind}) was not included before validBefore`);
    }
    if (r === "unknown") {
      // RPC unavailable: leave it pending; reconcileSentTxs() settles it once the node answers. Past validBefore the
      // transaction can no longer be included, so releasing the lane is safe either way.
      throw new Error(`server transaction ${hash} (${o.kind}): receipt unavailable (RPC errors); left pending`);
    }
    await markSent(hash, r.status === "success" ? "confirmed" : "reverted");
    if (r.status !== "success") throw new Error(`server transaction ${hash} (${o.kind}) reverted`);
    return { hash, nonce: BigInt(nonce), receipt: r };
  });
}

async function markSent(hash: Hex, status: "confirmed" | "reverted" | "failed" | "expired", error?: string) {
  await db
    .update(schema.sentTxs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(schema.sentTxs.txHash, hash));
}

/**
 * Settles `pending` journal rows (job + boot): mined → confirmed/reverted; reported absent by the node and past
 * `validBefore` → expired (it can never be included; its nonce is reused). RPC errors leave the row pending.
 * Returns how many rows changed.
 */
export async function reconcileSentTxs(now = new Date()): Promise<number> {
  const c = chainContext();
  const rows = await db
    .select()
    .from(schema.sentTxs)
    .where(inArray(schema.sentTxs.status, ["pending"]));
  let changed = 0;
  for (const r of rows) {
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await c.publicClient.getTransactionReceipt({ hash: r.txHash as Hex });
    } catch (e) {
      if (!isReceiptNotFound(e)) continue; // RPC trouble: try again next tick
    }
    if (receipt) {
      await markSent(r.txHash as Hex, receipt.status === "success" ? "confirmed" : "reverted");
      changed++;
    } else if (r.validBefore && r.validBefore.getTime() < now.getTime() - MARGIN_MS) {
      await markSent(r.txHash as Hex, "expired");
      changed++;
    }
  }
  return changed;
}

/** Journal rows for a business reference (e.g. a Pix charge), newest first. */
export async function sentTxsFor(kind: string, ref: string) {
  return db
    .select()
    .from(schema.sentTxs)
    .where(and(eq(schema.sentTxs.kind, kind), eq(schema.sentTxs.ref, ref)))
    .orderBy(desc(schema.sentTxs.createdAt));
}
