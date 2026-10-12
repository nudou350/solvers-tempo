"use client";
import { useLocale } from "next-intl";
import { unitsToNumber } from "@solvers/shared";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { usePublicConfig } from "@/lib/config";
import { formatToken, formatUnits, toBigUnits } from "@/lib/format-money";

export type PriceProps = {
  /** Amount in token base units (source of truth), e.g. "19000000" for 19 with 6 decimals. */
  units: bigint | string;
  /** Payment token; defaults to the public config's token (nothing is shown until it loads). */
  token?: { symbol: string; decimals: number } | null;
  /** BRL per USD (config.brlPerUsd). In Portuguese the main line is the BRL estimate; without it, the token amount. */
  rate?: number | null;
  /** Amount already in BRL (e.g. AgentDetail.priceBrl); wins over `rate`. */
  brl?: number | null;
  size?: "s" | "m" | "l" | "xl";
  /** BRL / USD without cents (cards). */
  round?: boolean;
  /** Main and secondary amounts on the same line. */
  inline?: boolean;
  /** Text after the token amount, e.g. "per task". */
  suffix?: string;
  className?: string;
};

/**
 * Price: the local-currency estimate first (pt: R$ from the rate; en: $, the token is a USD stablecoin) and the exact
 * token amount as secondary text. Amounts come from base units; floats only appear in the display-only BRL estimate.
 */
export function Price({ units, token, rate, brl, size = "m", round, inline, suffix, className }: PriceProps) {
  const locale = useLocale() as Locale;
  const intl = INTL_LOCALE[locale];
  const config = usePublicConfig();
  const tk = token ?? config?.paymentToken ?? null;
  const v = toBigUnits(units);
  const cls = ["price", `price-${size}`, inline ? "inline" : "", className ?? ""].filter(Boolean).join(" ");
  if (!tk || v === null) return <span className={cls} aria-busy="true" />;
  const exact = formatToken(v, tk, intl)!;
  const digits = round ? 0 : 2;
  const money = (n: number, currency: "BRL" | "USD") =>
    new Intl.NumberFormat(intl, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const main =
    locale === "pt"
      ? brl != null
        ? money(brl, "BRL")
        : rate != null
          ? money(unitsToNumber(v, tk.decimals) * rate, "BRL")
          : null
      : `$${formatUnits(v, tk.decimals, intl)}`;
  const sub = `${exact}${suffix ? ` ${suffix}` : ""}`;
  return (
    <span className={cls}>
      <span className="price-main">{main ?? sub}</span>
      {main ? <span className="price-sub">{sub}</span> : null}
    </span>
  );
}
