"use client";
// Purchase complete: a license or a task with a guarantee. The URL only says what was bought; the page confirms it by
// re-reading the charge (GET /api/purchases/:chargeId) until the server reports it `fulfilled`.
import type { AgentDetail, ChargeView, PublicConfig } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Tile } from "@/components/ui/Tile";
import { Notice, useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/format";
import { gap } from "@/lib/style";
import { brlText, parseUnits, tokenText, usdText } from "../catalog/money";
import { networkKey } from "../catalog/network";
import { txLink, useCheckoutSession, useErrText, usePageLocale } from "./glue";
import { donePhase, type DoneKind } from "./rules";

const CONFETTI: [number, number, number][] = [
  [6, 12, 30], [12, 58, -40], [18, 22, 70], [24, 80, 15], [30, 8, -25], [36, 46, 55], [42, 90, -60], [50, 6, 20], [58, 70, -35], [64, 14, 45],
  [72, 86, -15], [78, 30, 60], [84, 10, -50], [90, 62, 25], [95, 24, -30], [4, 38, 80], [46, 36, -70], [70, 50, 10], [88, 84, -45], [16, 92, 35],
];

export type DoneProps = {
  detail: AgentDetail;
  /** Public config (payment token, network); null when the API did not answer on the server. */
  config: PublicConfig | null;
  kind: DoneKind;
  /** Charge id of the purchase (direct wallet or Pix). */
  chargeId: string | null;
  /** Transaction hash the wallet sent (direct wallet); the charge's own hash wins once known. */
  txHash: `0x${string}` | null;
};

/** "unknown" = no session to check with: the page claims nothing. */
type Check = "checking" | "ok" | "failed" | "missing" | "unknown";

/** Waits between checks (~30 s in total): the purchase may take a moment to be recorded. */
const RETRY_DELAYS_MS = [0, 2000, 3000, 5000, 5000, 5000, 10_000];

export function DoneView({ detail, config, kind, chargeId, txHash }: DoneProps) {
  const session = useCheckoutSession();
  const toast = useToast();
  const t = useTranslations("install");
  const tc = useTranslations("catalog");
  const f = useFormat();
  const { locale, intl } = usePageLocale();
  const errText = useErrText();
  const [check, setCheck] = useState<Check>("checking");
  const [charge, setCharge] = useState<ChargeView | null>(null);
  const [recheck, setRecheck] = useState(0);
  const { agent } = detail;
  const signedIn = session.status === "signed-in";

  useEffect(() => {
    if (session.status === "loading") return;
    if (!signedIn) return setCheck("unknown");
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const once = async (): Promise<"ok" | "waiting" | "failed"> => {
      if (chargeId) {
        const c = await api.getCharge(chargeId);
        // The charge must be for this Solver, not only for this account.
        if (c.agentId !== agent.id) return "waiting";
        if (alive) setCharge(c);
        return donePhase(c.status);
      }
      // Older links without a charge id: a license is confirmed by the account's access.
      if (kind === "license") return (await api.getMyAccess(agent.slug)).license ? "ok" : "waiting";
      return "waiting";
    };
    const attempt = async (i: number) => {
      const r = await once().catch(() => "waiting" as const);
      if (!alive) return;
      if (r === "ok") setCheck("ok");
      else if (r === "failed") setCheck("failed");
      else if (i + 1 < RETRY_DELAYS_MS.length) timer = setTimeout(() => void attempt(i + 1), RETRY_DELAYS_MS[i + 1]);
      else setCheck("missing");
    };
    setCheck("checking");
    void attempt(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session.status, signedIn, chargeId, kind, agent.id, agent.slug, recheck]);

  const [tech, setTech] = useState(false);
  // Today's date only in the browser (avoids a hydration mismatch across time zones).
  const [today, setToday] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setToday(f.date(new Date().toISOString())), [f.locale]);

  const confirmed = check === "ok";
  const isEscrow = kind === "escrow";
  const token = config?.paymentToken ?? null;
  const paidUnits = parseUnits(charge?.amountUnits);
  const paidText =
    paidUnits != null && token
      ? locale === "pt"
        ? `${brlText(paidUnits, token.decimals, config?.brlPerUsd ?? 0, intl)} · ${tokenText(paidUnits, token, intl)}`
        : `${usdText(paidUnits, token.decimals, intl)} · ${tokenText(paidUnits, token, intl)}`
      : null;
  const hash = charge?.txHash ?? txHash;
  const link = hash ? txLink(hash, config ?? undefined) : null;
  const viaPix = charge?.provider === "pix-intermediated";

  const heading = !confirmed
    ? t("done.heading.pending", { name: agent.name })
    : isEscrow
      ? t("done.heading.escrow", { name: agent.name })
      : t("done.heading.license", { name: agent.name });
  const lead =
    check === "unknown"
      ? t("done.lead.unknown")
      : check === "missing" || check === "failed"
        ? null
        : check === "checking"
          ? t("done.lead.checking")
          : isEscrow
            ? t("done.lead.escrow")
            : t("done.lead.license");

  return (
    <section className="wrap" style={{ position: "relative", paddingTop: 56, paddingBottom: 72 }}>
      {confirmed ? (
        <div className="confetti" aria-hidden>
          {CONFETTI.map(([l, top, r], i) => (
            <i key={i} style={{ left: `${l}%`, top: `${top}%`, "--r": `${r}deg` } as CSSProperties} />
          ))}
        </div>
      ) : null}
      <div className="col center" style={{ ...gap(22), alignItems: "center", position: "relative", maxWidth: 720, margin: "0 auto" }}>
        <span
          className="pop"
          style={{
            width: 96,
            height: 96,
            borderRadius: "50%",
            background: confirmed ? "var(--mint)" : "var(--brand)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            boxShadow: `0 18px 40px -12px color-mix(in oklab,var(${confirmed ? "--mint" : "--brand"}) 60%,transparent)`,
          }}
        >
          <Icon name={confirmed ? "check" : "info"} size="xl" />
        </span>
        {check === "missing" ? (
          <Notice
            tone="warn"
            title={t("done.missing.title")}
            actions={
              <>
                <Button size="sm" variant="secondary" icon="refresh" onClick={() => setRecheck((n) => n + 1)}>
                  {t("done.missing.recheck")}
                </Button>
                <Button size="sm" variant="ghost" href={isEscrow ? "/guarantees" : "/library"}>
                  {isEscrow ? t("done.missing.goGuarantees") : t("done.missing.goLibrary")}
                </Button>
              </>
            }
          >
            {t("done.missing.body")}
          </Notice>
        ) : check === "failed" ? (
          <Notice
            tone="bad"
            role="alert"
            title={t("done.failed.title")}
            actions={
              <Button size="sm" variant="secondary" href={`/checkout?agent=${encodeURIComponent(agent.slug)}&type=${isEscrow ? "guarantee" : "license"}`}>
                {t("done.failed.retry")}
              </Button>
            }
          >
            {charge?.status === "refunding" || charge?.status === "refunded" ? t("done.failed.refund") : t("done.failed.body")}
          </Notice>
        ) : check === "unknown" ? (
          <Notice
            tone="info"
            title={t("done.unknown.title")}
            actions={
              <Button
                size="sm"
                loading={session.signingIn}
                onClick={() => void session.signIn().catch((e: unknown) => toast({ tone: "bad", title: t("done.unknown.loginFailed"), text: errText(e) }))}
              >
                {t("done.unknown.login")}
              </Button>
            }
          >
            {t("done.unknown.body")}
          </Notice>
        ) : (
          <span className="chip chip-ok" aria-live="polite">
            {check === "checking" ? t("done.chip.checking") : isEscrow ? t("done.chip.escrow") : t("done.chip.license")}
          </span>
        )}
        <h1 className="display h1s" style={{ fontSize: 60 }}>
          {heading}
        </h1>
        {lead ? <p className="lead">{lead}</p> : null}

        {confirmed ? (
          <div className="ticket" style={{ width: "100%", maxWidth: 520, textAlign: "left", padding: 26 }}>
            <div className="sol-line" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 4, borderRadius: 0 }} />
            <div className="row between">
              <span className="eyebrow">{isEscrow ? t("done.ticket.eyebrowTask") : t("done.ticket.eyebrowLicense")}</span>
              <span className={`chip ${isEscrow ? "chip-brand" : "chip-ok"}`}>
                <Icon name={isEscrow ? "shield-check" : "check"} size="s" />
                {isEscrow ? t("done.ticket.statusTask") : t("done.ticket.statusActive")}
              </span>
            </div>
            <div className="row" style={{ ...gap(16), margin: "18px 0" }}>
              <Tile category={agent.category} size="l" />
              <div className="grow">
                <div className="display" style={{ fontSize: 30, lineHeight: 1.05 }}>
                  {agent.name}
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {isEscrow ? t("done.ticket.taskLine", { n: detail.guarantee?.milestones.length ?? 0 }) : t("done.ticket.licenseLine", { version: agent.version })}
                </div>
              </div>
            </div>
            <div className="cut" style={{ margin: "0 -26px 16px" }} />
            <div className="row between wrapx small" style={gap(8)}>
              <span className="muted">{today ? t(isEscrow ? "done.ticket.createdOn" : "done.ticket.issuedOn", { date: today }) : " "}</span>
              {paidText ? (
                <span className="muted">
                  {isEscrow ? t("done.ticket.held") : t("done.ticket.paid")}:{" "}
                  <b className="num" style={{ color: "var(--ink)" }}>
                    {paidText}
                  </b>
                </span>
              ) : null}
            </div>
            {viaPix ? <p className="tiny faint" style={{ marginTop: 10 }}>{t("done.ticket.viaPix")}</p> : null}
          </div>
        ) : null}

        {confirmed ? (
          <div className="row wrapx m-col" style={{ ...gap(12), justifyContent: "center", width: "100%" }}>
            <Button size="lg" href={`/install?agent=${encodeURIComponent(agent.slug)}`} iconRight="arrow-right">
              {t("done.actions.connect")}
            </Button>
            {isEscrow ? (
              <Button size="lg" variant="secondary" href="/guarantees" icon="shield-check">
                {t("done.actions.trackGuarantees")}
              </Button>
            ) : (
              <Button size="lg" variant="secondary" href="/library">
                {t("done.actions.library")}
              </Button>
            )}
          </div>
        ) : null}

        {confirmed && !isEscrow ? <p className="small muted">{t("done.review", { name: agent.name })}</p> : null}

        {confirmed && hash ? (
          <>
            <button type="button" className="link-btn small" onClick={() => setTech((v) => !v)} aria-expanded={tech} aria-controls="tech-details">
              {tech ? t("done.tech.hide") : isEscrow ? t("done.tech.showTask") : t("done.tech.showLicense")}
            </button>
            {tech ? (
              <dl id="tech-details" className="tech" style={{ marginTop: 14, textAlign: "left", width: "100%", maxWidth: 520 }}>
                <dt>{t("done.tech.receipt")}</dt>
                <dd className="mono">{hash}</dd>
                {config ? (
                  <>
                    <dt>{t("done.tech.network")}</dt>
                    <dd>{tc(`network.${networkKey(config.chainId)}`)}</dd>
                  </>
                ) : null}
                {link ? (
                  <a className="link small" href={link} target="_blank" rel="noopener noreferrer">
                    {t("done.tech.openExplorer")} <Icon name="external" size="s" />
                  </a>
                ) : null}
              </dl>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
