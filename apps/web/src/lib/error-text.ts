"use client";
// Error text in the page language. The mapping itself is pure and lives in lib/error-map.ts (`errorText(e, t)`,
// `errorInfo(e, t)`); these hooks bind it to the page's "errors" translator, locale and payment token.
import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { usePublicConfig } from "./config";
import { errorInfo, errorText, type ErrorContext, type ErrorsT, type TxErrorInfo } from "./error-map";

export { ClientError, contractErrorName, errorInfo, errorText, isUserRejection, type ErrorAction, type ErrorsT, type TxErrorInfo } from "./error-map";

function useErrorContext(): { t: ErrorsT; ctx: ErrorContext } {
  const t = useTranslations("errors") as unknown as ErrorsT;
  const locale = useLocale() as Locale;
  const config = usePublicConfig();
  return { t, ctx: { intlLocale: INTL_LOCALE[locale], token: config?.paymentToken ?? null, faucetEnabled: !!config?.faucetEnabled } };
}

/** `const errorText = useErrorText(); toast({ text: errorText(e) })`: one line in the page language. */
export function useErrorText(): (e: unknown) => string {
  const { t, ctx } = useErrorContext();
  return useCallback((e: unknown) => errorText(e, t, ctx), [t, ctx.intlLocale, ctx.token, ctx.faucetEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** `const info = useErrorInfo(); info(e)` -> title, text and the suggested action (faucet, login, retry). */
export function useErrorInfo(): (e: unknown) => TxErrorInfo {
  const { t, ctx } = useErrorContext();
  return useCallback((e: unknown) => errorInfo(e, t, ctx), [t, ctx.intlLocale, ctx.token, ctx.faucetEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
