"use client";
// Transactions: the server returns the calls of ONE Tempo batch (`TxResponse`), the wallet sends them with the network
// fee paid by the platform relay, then the server confirms the receipt and indexes it (`api.confirm(hash)`).
import type { ConfirmResponse, TxResponse } from "@solvers/api-client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import type { Hex } from "viem";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { api as defaultApi, type SolversApi } from "./api";
import { usePublicConfig } from "./config";
import { loadPublicConfig } from "./config-cache";
import { ClientError, errorInfo, type ErrorsT, type TxErrorInfo } from "./error-map";
import { useSession } from "./session";
import { txUrl } from "./explorer";
import { useWallet, type Wallet } from "./wallet";

export type { TxErrorInfo } from "./error-map";

/** Confirm response plus the extra fields the server adds (block number, decoded events, explorer link). */
export type TxOutcome = ConfirmResponse & { blockNumber?: string; events?: unknown[]; explorerUrl?: string | null; [k: string]: unknown };

/** The transaction reached the chain but reverted (nothing was charged except the sponsored fee). */
export class TxFailedError extends ClientError {
  constructor(
    readonly hash: Hex,
    message?: string,
  ) {
    super("transaction_failed", message);
  }
}

/** Sent, but the server could not see the receipt yet after the retries (it may still land: do not resend at once). */
export class TxUnconfirmedError extends ClientError {
  constructor(readonly hash: Hex) {
    super("unconfirmed");
  }
}

export type RunTxOptions = {
  api?: SolversApi;
  /** `/api/tx/confirm` attempts while the receipt is not visible yet (each waits up to ~20 s on the server). */
  confirmAttempts?: number;
  /** Pause between attempts, ms. */
  retryDelayMs?: number;
};

/**
 * Sends a built transaction and waits for the server to confirm it: checks `tx.chainId` against the public config,
 * sends the calls through `wallet.sendCalls` (sponsored by the relay), then calls `api.confirm(hash)` with a short retry
 * while the server does not have the receipt yet. Throws `TxFailedError` when it reverted on-chain.
 */
export async function runTx(tx: TxResponse, wallet: Wallet, opts: RunTxOptions = {}): Promise<{ hash: Hex; outcome: TxOutcome }> {
  const client = opts.api ?? defaultApi;
  const config = await loadPublicConfig();
  if (tx.chainId !== config.chainId) throw new ClientError("wrong_network", undefined, { expected: config.chainId, got: tx.chainId });
  const hash = await wallet.sendCalls(tx.calls);
  const attempts = Math.max(1, opts.confirmAttempts ?? 4);
  for (let i = 0; i < attempts; i++) {
    let outcome: TxOutcome | null = null;
    try {
      outcome = (await client.confirm(hash)) as TxOutcome;
    } catch (e) {
      // Network blip or a 5xx: the transaction is already sent, so keep asking instead of failing the screen.
      const status = (e as { status?: number }).status;
      if (status !== undefined && status > 0 && status < 500 && status !== 429) throw e;
    }
    if (outcome?.status === "confirmed") return { hash, outcome };
    if (outcome?.status === "failed" && outcome.code !== "pending") throw new TxFailedError(hash, outcome.error);
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1500));
  }
  throw new TxUnconfirmedError(hash);
}

export type TxResult = { hash: Hex; outcome: TxOutcome; explorerUrl: string | null };

/**
 * Hook for screens: `const { run, pending, error, result } = useTx();`
 * `await run(() => api.buildPurchase(agent.id))` signs in if needed (Privy or dev wallet + SIWE), sends, confirms and
 * returns `{ hash, outcome, explorerUrl }`, or null on error, which is kept in `error` already translated.
 */
export function useTx() {
  const wallet = useWallet();
  const session = useSession();
  const errorInfoOf = useTxErrorInfo();
  const [pending, setPending] = useState(false);
  // Keeps the raw error: the text is rebuilt on every render, in the page's current language.
  const [raw, setRaw] = useState<{ e: unknown } | null>(null);
  const [result, setResult] = useState<TxResult | null>(null);

  const run = useCallback(
    async (build: TxResponse | (() => Promise<TxResponse>)) => {
      setPending(true);
      setRaw(null);
      try {
        await ensureSigner(session, wallet);
        const tx = typeof build === "function" ? await build() : build;
        const { hash, outcome } = await runTx(tx, wallet);
        const r: TxResult = { hash, outcome, explorerUrl: (typeof outcome.explorerUrl === "string" ? outcome.explorerUrl : null) ?? txUrl(hash) };
        setResult(r);
        return r;
      } catch (e) {
        setRaw({ e });
        return null;
      } finally {
        setPending(false);
      }
    },
    [session, wallet],
  );

  const error: TxErrorInfo | null = raw ? errorInfoOf(raw.e) : null;
  return { run, pending, error, rawError: raw?.e ?? null, result, explorerUrl: result?.explorerUrl ?? null, reset: () => setRaw(null) };
}

/**
 * Makes sure the session is signed in and the connected wallet is the session wallet (the relay only sponsors the
 * session wallet). Signs in when needed; a different connected wallet means "sign in again".
 */
export async function ensureSigner(session: ReturnType<typeof useSession>, wallet: Wallet): Promise<void> {
  if (session.status !== "signed-in") {
    await session.signIn();
    return;
  }
  // connect() reads the live wallet state (resolves at once when connected); this render's snapshot may be stale.
  const address = await wallet.connect();
  if (session.wallet && address.toLowerCase() !== session.wallet.toLowerCase()) throw new ClientError("wallet_changed");
}

/** `const info = useTxErrorInfo(); info(e)` -> title/text/action in the page language (amounts with the token symbol). */
export function useTxErrorInfo(): (e: unknown) => TxErrorInfo {
  const t = useTranslations("errors") as unknown as ErrorsT;
  const locale = useLocale() as Locale;
  const config = usePublicConfig();
  return useCallback(
    (e: unknown) => errorInfo(e, t, { intlLocale: INTL_LOCALE[locale], token: config?.paymentToken ?? null, faucetEnabled: !!config?.faucetEnabled }),
    [t, locale, config],
  );
}

/**
 * Test funds (testnets only, `PublicConfig.faucetEnabled`): `receive()` signs in if needed and asks `/api/faucet` to
 * fund the session wallet; returns the amount in base units (null when unknown or on error, kept in `error`).
 */
export function useFaucet() {
  const wallet = useWallet();
  const session = useSession();
  const config = usePublicConfig();
  const errorInfoOf = useTxErrorInfo();
  const [pending, setPending] = useState(false);
  const [raw, setRaw] = useState<{ e: unknown } | null>(null);

  const receive = useCallback(async (): Promise<{ amountUnits: string | null; txHash: Hex | null } | null> => {
    setPending(true);
    setRaw(null);
    try {
      await ensureSigner(session, wallet);
      const r = await session.api.faucet();
      return { amountUnits: r.amountUnits, txHash: r.txHash };
    } catch (e) {
      setRaw({ e });
      return null;
    } finally {
      setPending(false);
    }
  }, [session, wallet]);

  const error: TxErrorInfo | null = raw ? errorInfoOf(raw.e) : null;
  return { enabled: !!config?.faucetEnabled, receive, pending, error };
}
