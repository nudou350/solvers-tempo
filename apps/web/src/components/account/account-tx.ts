"use client";
// Glue between the account screens and the app foundation (wallet, transactions, config, error text). Every foundation
// call the account area makes goes through this file, so an interface change is fixed in one place.
import { ApiError } from "@solvers/api-client";
import { MEMORY_KEY_MESSAGE, TxResponse, type PublicConfig } from "@solvers/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { usePublicConfig } from "@/lib/config";
import { useErrorText } from "@/lib/error-text";
import { networkKind } from "@/lib/explorer";
import { useSession } from "@/lib/session";
import { ensureSigner, useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { formatMoney } from "./account-rules";

/** Intl locale of the page ("en-US", "pt-BR"). */
export function useIntlLocale(): string {
  return INTL_LOCALE[useLocale() as Locale];
}

/** Public config (chain, contracts, payment token). null while it loads. */
export function useAccountConfig(): PublicConfig | null {
  return usePublicConfig() ?? null;
}

/** Address of the signed-in wallet (session first, then the connected wallet). */
export function useOwnerAddress(): string | null {
  const session = useSession();
  const wallet = useWallet();
  return session.wallet ?? session.me?.wallet ?? wallet.address ?? null;
}

/** Formats base units of the payment token ("12.50 USD"); returns "" until the config is loaded. */
export function useMoney(): (units: bigint | string) => string {
  const config = useAccountConfig();
  const locale = useIntlLocale();
  return useCallback(
    (units: bigint | string) => (config ? formatMoney(units, { decimals: config.paymentToken.decimals, symbol: config.paymentToken.symbol }, locale) : ""),
    [config, locale],
  );
}

/**
 * Amount already converted by the server to token units as a number (legacy numeric fields of the guarantee API, e.g.
 * `amountUsdc`): formatted only, no arithmetic.
 */
export function useAmount(): (n: number) => string {
  const config = useAccountConfig();
  const locale = useIntlLocale();
  return useCallback(
    (n: number) => {
      const text = n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: config?.paymentToken.decimals ?? 6 });
      return config ? `${text} ${config.paymentToken.symbol}` : text;
    },
    [config, locale],
  );
}

/** Name of the network the app runs on, for people ("Tempo", "Tempo test network", "Local test network"). */
export function useNetworkName(): string | null {
  const config = useAccountConfig();
  const t = useTranslations("account.network");
  if (!config) return null;
  return t(networkKind(config.chainId));
}

/** Error text in the page language: account-specific codes first (account.txErrors.<code>), then the app's text. */
export function useAccountErrorText(): (e: unknown) => string {
  const appText = useErrorText();
  const ta = useTranslations("account.txErrors");
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code && ta.has(e.code)) return ta(e.code);
      return appText(e);
    },
    [appText, ta],
  );
}

export type TxDone = { hash: `0x${string}` };

/**
 * Builds a call batch on the server, sends it from the wallet (fee paid by the platform) and waits for the server to
 * confirm it (the app's `useTx`, signing in first when needed). `error` is already translated, account codes first;
 * `raw` keeps the original error (e.g. to read an ApiError body).
 */
export function useAccountTx() {
  const tx = useTx();
  const text = useAccountErrorText();
  const run = useCallback(async (build: () => Promise<TxResponse>): Promise<TxDone | null> => {
    const r = await tx.run(build);
    return r ? { hash: r.hash } : null;
  }, [tx.run]); // eslint-disable-line react-hooks/exhaustive-deps
  const raw = tx.rawError;
  return { run, pending: tx.pending, raw, error: raw ? text(raw) : null, reset: tx.reset };
}

/**
 * Signs the memory-key message (EIP-191, decisions.md D8) with the session wallet and opens the memories for this
 * session. Only plain wallets (EOAs) produce a usable key; the server refuses smart-contract wallet signatures.
 */
export function useUnlockMemories(): () => Promise<void> {
  const session = useSession();
  const wallet = useWallet();
  return useCallback(async () => {
    await ensureSigner(session, wallet);
    const address = (session.wallet ?? wallet.address) as `0x${string}`;
    await api.unlockMemories({ address, signMessage: (m: string) => wallet.signMessage(m), sendCalls: (calls) => wallet.sendCalls(calls) }, MEMORY_KEY_MESSAGE);
  }, [session, wallet]);
}

/** Stale dispute (never delivered, deadline over, no ruling in time): the buyer triggers the refund. */
export function buildResolveStaleDispute(escrowId: string, index: number): Promise<TxResponse> {
  return api.buildResolveStaleDispute(escrowId, index);
}

/** Contract and token addresses a license must never be sent to. */
export function useBlockedRecipients(): string[] {
  const config = useAccountConfig();
  return useMemo(() => (config ? [...Object.values(config.contracts), config.paymentToken.address] : []), [config]);
}
