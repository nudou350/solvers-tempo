"use client";
// Glue between the creator/admin screens and the app foundation (wallet, transactions, config, error text, explorer).
// Every foundation call the creator area makes goes through this file, so an interface change is fixed in one place.
import { ApiError } from "@solvers/api-client";
import type { PublicConfig, TxResponse } from "@solvers/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { usePublicConfig } from "@/lib/config";
import { useErrorText } from "@/lib/error-text";
import { txUrl } from "@/lib/explorer";
import { useSession } from "@/lib/session";
import { ensureSigner, runTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { formatUnits } from "./creator-rules";

export type Hash = `0x${string}`;

/** Intl locale of the page ("en-US", "pt-BR"). */
export function useIntlLocale(): string {
  return INTL_LOCALE[useLocale() as Locale];
}

/** Public config (chain, contracts, payment token, royalty, explorer). null while it loads. */
export function useCreatorConfig(): PublicConfig | null {
  return usePublicConfig() ?? null;
}

/** Payment token (symbol + decimals) or null while the config loads. */
export function useToken(): { symbol: string; decimals: number } | null {
  const config = useCreatorConfig();
  return config ? { symbol: config.paymentToken.symbol, decimals: config.paymentToken.decimals } : null;
}

/** Base units of the payment token -> "12.50 USD" (exact, no float math). "" until the config loads. */
export function useMoney(): (units: bigint | string) => string {
  const token = useToken();
  const locale = useIntlLocale();
  return useCallback((units: bigint | string) => (token ? `${formatUnits(units, token.decimals, locale, 2)} ${token.symbol}` : ""), [token, locale]);
}

/**
 * Amount the server already converted to token units as a number (the dashboard's numeric fields): formatted only,
 * no arithmetic.
 */
export function useAmount(): (n: number) => string {
  const token = useToken();
  const locale = useIntlLocale();
  return useCallback(
    (n: number) => {
      const text = n.toLocaleString(locale, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
      return token ? `${text} ${token.symbol}` : text;
    },
    [token, locale],
  );
}

/** Explorer link of a transaction, or null when it cannot be built. */
export function useTxLink(): (hash: string) => string | null {
  const config = useCreatorConfig();
  return useCallback(
    (hash: string) => {
      return config ? txUrl(hash, config) : txUrl(hash);
    },
    [config],
  );
}

/** Error text in the page language: creator-specific codes first (creator.txErrors.<code>), then the app's text. */
export function useCreatorErrorText(): (e: unknown) => string {
  const appText = useErrorText();
  const tc = useTranslations("creator.txErrors");
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code && tc.has(e.code)) return tc(e.code);
      return appText(e);
    },
    [appText, tc],
  );
}

/**
 * Builds a call batch on the server, sends it from the creator's wallet (fee paid by the platform) and waits for the
 * server to confirm it. `pending` names the action in flight; `error` is already translated.
 */
export function useCreatorTx() {
  const wallet = useWallet();
  const session = useSession();
  const text = useCreatorErrorText();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ action: string; e: unknown } | null>(null);

  const run = useCallback(
    async (action: string, build: () => Promise<TxResponse>): Promise<Hash | null> => {
      setPending(action);
      setFailure(null);
      try {
        await ensureSigner(session, wallet);
        const tx = await build();
        const r = await runTx(tx, wallet);
        return r.hash;
      } catch (e) {
        setFailure({ action, e });
        return null;
      } finally {
        setPending(null);
      }
    },
    [session, wallet],
  );

  const reset = useCallback(() => setFailure(null), []);
  return { run, pending, failedAction: failure?.action ?? null, error: failure ? text(failure.e) : null, reset };
}

/** Makes sure the session wallet is the connected signer (signs in when needed). */
export function useEnsureSigner(): () => Promise<void> {
  const wallet = useWallet();
  const session = useSession();
  return useCallback(() => ensureSigner(session, wallet), [session, wallet]);
}

/** Sends an already-built batch (the publication), waits for the server to confirm it and returns the hash. */
export function useSendBuilt(): (tx: TxResponse) => Promise<Hash> {
  const wallet = useWallet();
  return useCallback(async (tx: TxResponse) => (await runTx(tx, wallet)).hash, [wallet]);
}
