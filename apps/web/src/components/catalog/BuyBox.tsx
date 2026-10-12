"use client";
// Buy box of a Solver page: permanent license (price in the payment token), license limit, transfer fee, free trial
// and the signed-in user's access. Platform Solvers are free and only show how to install them.
import type { AgentSupply, TrialInfo } from "@solvers/api-client";
import { sameAddress } from "@solvers/api-client";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Toast";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { useMyAccess } from "@/lib/hooks";
import { useCheckoutSession } from "@/components/checkout/glue";
import { gap } from "@/lib/style";
import { bpsText, brlText, brlValueText, parseUnits, royaltyInfo, tokenText, usdText, type TokenInfo } from "./money";

export type BuyBoxProps = {
  slug: string;
  name: string;
  /** License price in token base units (decimal string); null when it cannot be represented. */
  priceUnits: string | null;
  /** Price in BRL fixed by the server (pt), or null to estimate it with `rate`. */
  priceBrl: number | null;
  token: TokenInfo;
  /** BRL per USD (PublicConfig.brlPerUsd). */
  rate: number;
  /** Free trial configured by the creator; null = no trial. */
  trial: TrialInfo | null;
  hasGuarantee: boolean;
  /** License limit (sold / max). Missing or `max: null` = unlimited. */
  supply?: AgentSupply;
  /** Creator share of the transfer fee (Agent.royaltyBps) and the platform share (PublicConfig.royalty.platformBps). */
  royalty: { creatorBps: number; platformBps: number | null };
  /** Creator wallet on-chain (AgentDetail.onchain.creatorWallet): a creator cannot buy their own license (D12). */
  creatorWallet: string | null;
  /** Platform Solver: free, no license and no purchase. Hides the price and the buy button. */
  platform?: boolean;
};

/** Box of a platform Solver: no price or purchase, only how to install it. */
function PlatformBox({ slug }: { slug: string }) {
  const t = useTranslations("catalog.buy");
  const install = `/install?agent=${encodeURIComponent(slug)}`;
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="sol-line" style={{ borderRadius: 0, height: 4 }} />
      <div className="pad col" style={gap("18px")}>
        <div className="col" style={gap("4px")}>
          <span className="eyebrow">{t("platformTitle")}</span>
          <span className="display big num" style={{ fontSize: 56, whiteSpace: "nowrap" }}>
            {t("free")}
          </span>
          <span className="small faint">{t("noPurchase")}</span>
        </div>
        <Button href={install} size="lg" block iconRight="arrow-right">
          {t("install")}
        </Button>
        <ol className="col small" style={gap("10px")}>
          <Step n={1}>{t("step1")}</Step>
          <Step n={2}>{t("step2")}</Step>
          <Step n={3}>{t("step3")}</Step>
        </ol>
        <ul className="col small" style={gap("10px")}>
          <Check>{t("check1")}</Check>
          <Check>{t("check2")}</Check>
        </ul>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="row start" style={gap("10px")}>
      <span className="dot dot-now" aria-hidden style={{ width: 24, height: 24, fontSize: 12, borderWidth: 1.5 }}>
        {n}
      </span>
      <span className="grow">{children}</span>
    </li>
  );
}

export function BuyBox(p: BuyBoxProps) {
  if (p.platform) return <PlatformBox slug={p.slug} />;
  return <PaidBox {...p} />;
}

function PaidBox(p: BuyBoxProps) {
  const t = useTranslations("catalog.buy");
  const tTrial = useTranslations("catalog.trial");
  const locale = useLocale() as Locale;
  const intl = INTL_LOCALE[locale];
  const access = useMyAccess(p.slug);
  const { wallet } = useCheckoutSession();
  const units = parseUnits(p.priceUnits);
  // pt: reais (the creator's fixed value, if any, else the rate); en: dollars, 1:1 with the stablecoin.
  const price =
    units == null ? null : locale === "pt" ? (p.priceBrl != null ? brlValueText(p.priceBrl, intl) : brlText(units, p.token.decimals, p.rate, intl)) : usdText(units, p.token.decimals, intl);
  const checkout = `/checkout?agent=${encodeURIComponent(p.slug)}&type=license`;
  const install = `/install?agent=${encodeURIComponent(p.slug)}`;
  const owned = !!access?.license;
  const isCreator = sameAddress(wallet, p.creatorWallet);
  const trialLeft = p.trial && access ? access.trialUsesLeft : null;
  const soldOut = !owned && p.supply?.left === 0;
  const limited = p.supply?.max != null && p.supply.left != null && p.supply.left > 0;
  const royalty = royaltyInfo(units, p.royalty.creatorBps, p.royalty.platformBps);

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="sol-line" style={{ borderRadius: 0, height: 4 }} />
      <div className="pad col" style={gap("18px")}>
        {owned ? (
          <div className="note note-ok" role="status">
            <Icon name="check-circle" />
            <div className="note-body">
              <span className="note-title">{t("ownedTitle")}</span>
              <span className="small">{t("ownedBody")}</span>
              <div className="note-actions">
                <Button href={install} size="sm" iconRight="arrow-right">
                  {t("goInstall")}
                </Button>
                <Button href="/library" size="sm" variant="secondary">
                  {t("library")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {owned ? null : (
          <>
            <div className="col" style={gap("2px")}>
              <span className="eyebrow">{t("permanent")}</span>
              <div className="row price-row" style={gap("10px", { alignItems: "baseline" })}>
                <span className="display big num price-big" style={{ fontSize: 60, whiteSpace: "nowrap" }}>
                  {price ?? "—"}
                </span>
                <span className="muted">{t("oneTime")}</span>
              </div>
              {units != null ? <span className="small faint">{t("rate", { amount: tokenText(units, p.token, intl), symbol: p.token.symbol })}</span> : null}
            </div>
            {limited && p.supply ? (
              <span className="small" role="status">
                <Icon name="tag" size="s" /> {t.rich("supplyLeft", { left: p.supply.left ?? 0, max: p.supply.max ?? 0, b: (chunks) => <b>{chunks}</b> })}
              </span>
            ) : null}
            {isCreator ? (
              <Notice
                tone="brand"
                title={t("creatorTitle")}
                actions={
                  <Button href="/creator" size="sm" variant="secondary">
                    {t("creatorPanel")}
                  </Button>
                }
              >
                {t("creatorBody")}
              </Notice>
            ) : soldOut ? (
              <div className="col" style={gap("8px")}>
                <Button size="lg" block disabled>
                  {t("soldOut")}
                </Button>
                <p className="small muted" role="status">
                  {t("soldOutText")}
                </p>
              </div>
            ) : units == null ? (
              <Button size="lg" block disabled>
                {t("buy")}
              </Button>
            ) : (
              <Button href={checkout} size="lg" block iconRight="arrow-right">
                {t("buy")}
              </Button>
            )}
            {p.trial ? (
              <div className="col" style={gap("8px")}>
                <Button href={install} variant="secondary" block icon="play">
                  {t("tryFree")}
                </Button>
                <p className="small muted center" role="status">
                  {trialLeft == null
                    ? t("trialTry", { uses: tTrial("uses", { n: p.trial.uses }) })
                    : trialLeft > 0
                      ? t("trialLeft", { left: trialLeft, uses: tTrial("uses", { n: p.trial.uses }) })
                      : t("trialOver")}{" "}
                  <a className="link" href="#teste-gratis">
                    {t("seeTrial")}
                  </a>
                </p>
              </div>
            ) : null}
          </>
        )}
        <ul className="col small" style={gap("10px")}>
          <Check>{t("onChain")}</Check>
          {royalty ? (
            <Check>
              {t("transfer", {
                pct: bpsText(royalty.totalBps, intl),
                amount: tokenText(royalty.totalUnits, p.token, intl),
                creator: bpsText(royalty.creatorBps, intl),
                platform: bpsText(royalty.platformBps, intl),
              })}
            </Check>
          ) : null}
          {p.trial ? <Check>{t("trialInAi")}</Check> : null}
          <Check>{p.hasGuarantee ? t("withGuarantee") : t("noGuarantee")}</Check>
        </ul>
        {p.hasGuarantee ? (
          <>
            <div className="divider" />
            <a className="row between" href="#garantia" style={gap("12px")}>
              <span className="col" style={gap("2px")}>
                <span className="small faint">{t("guaranteeAsk")}</span>
                <b>{t("guaranteeTask")}</b>
              </span>
              <Icon name="arrow-right" />
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="row start" style={gap("10px")}>
      <span className="ok">
        <Icon name="check-circle" size="s" />
      </span>
      <span className="grow">{children}</span>
    </li>
  );
}
