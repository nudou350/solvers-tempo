"use client";
// Glue between the storefront/checkout screens and the app foundation (session, wallet, transactions, error text,
// explorer links). Every foundation call of this area goes through here, so an interface change is fixed in one place.
import type { PublicConfig, TxResponse } from "@solvers/api-client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { errorText, type TxErrorInfo } from "@/lib/error-text";
import { addressUrl, txUrl } from "@/lib/explorer";
import { useSession } from "@/lib/session";
import { ensureSigner, runTx, useTxErrorInfo } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

/** Page locale and its Intl form ("en-US", "pt-BR"). */
export function usePageLocale(): { locale: Locale; intl: string } {
  const locale = useLocale() as Locale;
  return { locale, intl: INTL_LOCALE[locale] ?? "en-US" };
}

export type CheckoutSession = {
  /** "loading" until the session is known. */
  status: "loading" | "signed-out" | "signed-in";
  /** Session wallet (lowercase or checksummed, compare with `sameAddress`); null when signed out. */
  wallet: string | null;
  /** "privy" (email login with an embedded wallet) or "dev" (local test wallet); decides the sign-in texts. */
  walletKind: string | null;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

/** Session state for the storefront and checkout screens. */
export function useCheckoutSession(): CheckoutSession {
  const session = useSession();
  const wallet = useWallet();
  const [signingIn, setSigningIn] = useState(false);
  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      await session.signIn();
    } finally {
      setSigningIn(false);
    }
  }, [session]);
  const signOut = useCallback(async () => {
    await session.signOut();
  }, [session]);
  const status = session.status;
  return {
    status,
    wallet: status === "signed-in" ? (session.wallet ?? null) : null,
    walletKind: (wallet.kind as string | null | undefined) ?? null,
    signingIn: signingIn || !!session.signingIn,
    signIn,
    signOut,
  };
}

/**
 * Sends a call batch built by the server (purchase intent, review...) from the session wallet; the platform relay pays
 * the network fee and the server confirms it. Resolves with the transaction hash; throws when the wallet refuses, the
 * connected wallet is not the session wallet, or the transaction fails.
 */
export function useSendCalls(): (tx: TxResponse) => Promise<`0x${string}`> {
  const wallet = useWallet();
  const session = useSession();
  return useCallback(
    async (tx: TxResponse) => {
      await ensureSigner(session, wallet);
      const r = await runTx(tx, wallet);
      return r.hash as `0x${string}`;
    },
    [wallet, session],
  );
}

/** Title, text and suggested action (faucet, login, retry) of any error, in the page language. */
export function useErrInfo(): (e: unknown) => TxErrorInfo {
  return useTxErrorInfo();
}

/** Error text in the page language (API codes translated by the foundation's errors.json). */
export function useErrText(): (e: unknown) => string {
  const t = useTranslations("errors");
  return useCallback((e: unknown) => errorText(e, t as unknown as Parameters<typeof errorText>[1]), [t]);
}

/** Explorer link of a transaction; null without an explorer (local chain). */
export function txLink(hash: string, config?: PublicConfig | null): string | null {
  return config === undefined ? txUrl(hash) : txUrl(hash, config);
}

/** Explorer link of an address (wallet or contract); null without an explorer (local chain). */
export function addressLink(address: string, config?: PublicConfig | null): string | null {
  return config === undefined ? addressUrl(address) : addressUrl(address, config);
}
