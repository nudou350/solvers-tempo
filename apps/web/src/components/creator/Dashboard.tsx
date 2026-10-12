"use client";
import { ApiError, type CreatorDashboard } from "@solvers/api-client";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { AuthGate } from "@/components/ui/AuthGate";
import { Chip, RepBadge } from "@/components/ui/Chip";
import { Empty } from "@/components/ui/Empty";
import { Icon } from "@/components/ui/Icon";
import { Loading } from "@/components/ui/Spinner";
import { Tile } from "@/components/ui/Tile";
import { api } from "@/lib/api";
import { evalMethodNote, hasEvalScore } from "@/lib/eval-label";
import { useFormat } from "@/lib/format";
import { useSession } from "@/lib/session";
import { gap } from "@/lib/style";
import { unitsToNumber } from "@solvers/shared";
import { useCreatorConfig, useIntlLocale, useMoney, useToken, useTxLink } from "./creator-glue";
import { kpiHeadline } from "./creator-rules";
import { CreatorHead } from "./CreatorHead";
import { DailyChart } from "./DailyChart";
import { ManageSolver } from "./ManageSolver";
import { OpenSubmissions } from "./OpenSubmissions";

type Dash = CreatorDashboard;
type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; data: Dash };

const RESULT: Record<Dash["disputes"][number]["result"], { chip: "warn" | "red" | "ok"; tone: string }> = {
  open: { chip: "warn", tone: "warn" },
  buyer: { chip: "red", tone: "bad" },
  creator: { chip: "ok", tone: "ok" },
};

/** Creator dashboard (/creator): requires sign-in; without published Solvers it shows how to start. */
export function CreatorDashboardView() {
  const t = useTranslations("creator.dashboard");
  const { status, me } = useSession();
  const lang = useLocale() as Locale;
  const [state, setState] = useState<State>({ kind: "loading" });
  // Translator kept in a ref: it must not refetch the dashboard on every render.
  const expired = useRef(t("sessionExpired"));
  expired.current = t("sessionExpired");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setState({ kind: "loading" });
      try {
        const data = await api.getCreatorDashboard(lang);
        setState({ kind: "ok", data });
      } catch (e) {
        if (!silent) setState({ kind: "error", message: e instanceof ApiError && e.status === 401 ? expired.current : (e as Error).message });
      }
    },
    [lang],
  );

  useEffect(() => {
    if (status === "signed-in") void load();
  }, [status, me?.wallet, load]);

  if (status !== "signed-in")
    return (
      <Section>
        <CreatorHead tab="overview" />
        <AuthGate
          icon="pen"
          title={t("gate.title")}
          text={t("gate.text")}
          actions={
            <Button variant="secondary" href="/creator/publish">
              {t("gate.howTo")}
            </Button>
          }
        />
      </Section>
    );

  if (state.kind === "loading") return <Section><CreatorHead tab="overview" /><Loading text={t("loading")} /></Section>;
  if (state.kind === "error")
    return (
      <Section>
        <CreatorHead tab="overview" />
        <Empty icon="warning" title={t("loadFailTitle")} action={<Button onClick={() => void load()}>{t("retry")}</Button>}>
          {state.message}
        </Empty>
      </Section>
    );

  const { data } = state;
  if (!data.creator)
    return (
      <Section>
        <CreatorHead tab="overview" />
        <OpenSubmissions />
        <NotCreator sharePct={data.creatorSharePct} />
      </Section>
    );
  return (
    <Section>
      <CreatorHead tab="overview" reputation={data.creator.reputationScore} name={data.creator.name} />
      <OpenSubmissions />
      <Overview data={data} creator={data.creator} reload={() => load(true)} />
    </Section>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="wrap" style={{ paddingTop: 44, paddingBottom: 56 }}>
      {children}
    </section>
  );
}

function NotCreator({ sharePct }: { sharePct: number }) {
  const t = useTranslations("creator.dashboard.notCreator");
  const f = useFormat();
  const points = [
    { icon: "gift" as const, title: t("free.title"), text: t("free.text") },
    { icon: "coin" as const, title: t("share.title", { pct: f.num(sharePct, 0, 1) }), text: t("share.text") },
    { icon: "shield-check" as const, title: t("quality.title"), text: t("quality.text") },
  ];
  return (
    <div className="card pad-l col" style={gap(28)}>
      <div className="col" style={gap(10, { maxWidth: 680 })}>
        <span className="eyebrow">{t("eyebrow")}</span>
        <h2 className="display h2s">{t("title")}</h2>
        <p className="lead">{t("lead")}</p>
      </div>
      <div className="g3 m1" style={gap(16)}>
        {points.map((p) => (
          <div key={p.title} className="card-flat pad-s col" style={gap(10)}>
            <span className="brand">
              <Icon name={p.icon} />
            </span>
            <b>{p.title}</b>
            <span className="small muted">{p.text}</span>
          </div>
        ))}
      </div>
      <div className="row wrapx" style={gap(12)}>
        <Button href="/creator/publish" size="lg" iconRight="arrow-right">
          {t("publish")}
        </Button>
        <Button href="/creator/submissions" size="lg" variant="secondary">
          {t("mySubmissions")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Big money figure of a KPI from base units: the payment token is a US-dollar stablecoin, so English shows dollars 1:1
 * and Portuguese an estimate in reais at the configured rate. Display only (the float exists only here, at the edge);
 * the exact token amount is shown below it with `useMoney`.
 */
function useHeadline(): (units: string) => string {
  const config = useCreatorConfig();
  const token = useToken();
  const locale = useIntlLocale();
  const lang = useLocale() as Locale;
  return (units: string) => {
    if (!token) return "";
    return kpiHeadline(unitsToNumber(units, token.decimals), { lang, rate: config?.brlPerUsd ?? null, intlLocale: locale });
  };
}

function Overview({ data, creator, reload }: { data: Dash; creator: NonNullable<Dash["creator"]>; reload: () => Promise<void> }) {
  const t = useTranslations("creator.dashboard");
  const f = useFormat();
  const lang = useLocale() as Locale;
  const config = useCreatorConfig();
  const amount = useMoney();
  const headline = useHeadline();
  const txLink = useTxLink();
  const [open, setOpen] = useState<string | null>(null);
  const lostText = t("reputation.lost", { n: data.totals.disputesLost });
  const kpiN = { fontSize: 44, lineHeight: 1 } as CSSProperties;
  const kpiMoney = { fontSize: 40, lineHeight: 1, whiteSpace: "nowrap" } as CSSProperties;
  // All-time total, only when it differs from the last 30 days.
  const allTime = (total: number, last: number) => (total > last ? t("kpi.allTime", { n: f.int(total) }) : "");
  const nameOf = new Map(data.agents.map((a) => [a.agentId, a.name]));
  const platformBps = config?.royalty.platformBps ?? null;

  return (
    <>
      <div className="g5" style={gap(16, { marginBottom: 24 })}>
        <div className="card pad-s col" style={gap(6)}>
          <span className="small muted">{t("kpi.sales30")}</span>
          <span className="display num" style={kpiN}>{f.int(data.last30.sales)}</span>
          <span className="tiny ok">{t("kpi.newLicenses")}{allTime(data.totals.sales, data.last30.sales)}</span>
        </div>
        <div className="card pad-s col" style={gap(6)}>
          <span className="small muted">{t("kpi.uses")}</span>
          <span className="display num" style={kpiN}>{f.int(data.last30.uses)}</span>
          <span className="tiny faint">{t("kpi.usesSub")}{allTime(data.totals.uses, data.last30.uses)}</span>
        </div>
        <div className="card pad-s col" style={gap(6)}>
          <span className="small muted">{t("kpi.revenue")}</span>
          <span className="display num kpi-n" style={kpiMoney}>{headline(data.last30.revenueUnits)}</span>
          <span className="tiny faint">
            {amount(data.last30.revenueUnits)}
            {BigInt(data.totals.salesRevenueUnits) > BigInt(data.last30.revenueUnits) ? t("kpi.allTime", { n: amount(data.totals.salesRevenueUnits) }) : ""}
          </span>
        </div>
        <div className="card pad-s col" style={gap(6)}>
          <span className="small muted">{t("kpi.royalties")}</span>
          <span className="display num kpi-n" style={kpiMoney}>{headline(data.totals.royaltiesUnits)}</span>
          <span className="tiny faint">
            {amount(data.totals.royaltiesUnits)} · {t("kpi.royaltiesSub")}
          </span>
        </div>
        <div className="card pad-s col" style={gap(6)}>
          <span className="small muted">{t("kpi.disputes")}</span>
          <span className="display num" style={kpiN}>{f.int(data.totals.disputesOpened)}</span>
          <span className={data.totals.disputesOpen ? "tiny warn" : "tiny faint"}>{t("kpi.disputesOpen", { n: f.int(data.totals.disputesOpen) })}</span>
        </div>
      </div>

      <div className="g2 gs2" style={gap(24, { marginBottom: 24 })}>
        <div className="card pad">
          <DailyChart daily={data.daily} />
        </div>
        <div className="card pad col" style={gap(16, { alignItems: "flex-start" })}>
          <h2 className="h3">{t("reputation.title")}</h2>
          <div className="row" style={gap(20)}>
            <div className="ring" style={{ "--p": Math.round(creator.reputationScore) } as CSSProperties}>
              <div>
                <span className="display num" style={{ fontSize: 36 }}>{Math.round(creator.reputationScore)}</span>
              </div>
            </div>
            <div className="col grow" style={gap(4)}>
              <RepBadge score={creator.reputationScore} style={{ alignSelf: "flex-start" }} />
              <span className="small muted">{lostText}</span>
            </div>
          </div>
          <p className="small muted">{t("reputation.text")}</p>
          <Link className="link small" href={`/creators/${encodeURIComponent(creator.id)}`}>
            {t("reputation.profile")}
          </Link>
        </div>
      </div>

      <div className="card pad-s" style={{ padding: "8px 24px", marginBottom: 24 }}>
        <div className="row between wrapx" style={{ padding: "14px 0" }}>
          <h2 className="h3">{t("agents.title")}</h2>
          <Button variant="secondary" href="/creator/publish" icon="plus">
            {t("agents.publishNew")}
          </Button>
        </div>
        {data.agents.length === 0 ? (
          <div style={{ borderTop: "1px solid var(--line)" }}>
            <Empty bare icon="pen" title={t("agents.emptyTitle")}>
              {t("agents.emptyText")}
            </Empty>
          </div>
        ) : (
          <>
            <div className="cr-table cr-head hide-m" aria-hidden>
              <span>{t("agents.cols.agent")}</span>
              <span>{t("agents.cols.sold")}</span>
              <span>{t("agents.cols.uses")}</span>
              <span>{t("agents.cols.rating")}</span>
              <span>{t("agents.cols.performance")}</span>
              <span>{t("agents.cols.revenue")}</span>
            </div>
            {data.agents.map((a) => {
              const expanded = open === a.agentId;
              const panelId = `manage-${a.agentId}`;
              return (
                <div key={a.agentId}>
                  <div className="cr-table">
                    <span className="row" style={gap(12, { minWidth: 0 })}>
                      <Tile category={a.category} size="s" />
                      <span className="col" style={gap(4, { minWidth: 0 })}>
                        <Link className="trunc bold" href={`/solvers/${encodeURIComponent(a.slug)}`} style={{ fontWeight: 700 }}>
                          {a.name}
                        </Link>
                        <span className="tiny faint">
                          {t("agents.version", { version: a.version, status: t(`agents.status.${a.status}`) })}
                        </span>
                        {!a.listed ? (
                          <span>
                            <Chip tone="warn" icon="eye">{t("agents.hidden")}</Chip>
                          </span>
                        ) : null}
                        <span>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="sliders"
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            onClick={() => setOpen(expanded ? null : a.agentId)}
                          >
                            {expanded ? t("agents.closeManage") : t("agents.manage")}
                          </Button>
                        </span>
                      </span>
                    </span>
                    <span className="num">
                      <span className="only-m tiny faint">{t("agents.cols.sold")} </span>
                      {f.int(a.sales)}
                      {a.supply.max != null ? (
                        <span className={a.supply.left === 0 ? "warn" : "faint"}>
                          {" / "}
                          {f.int(a.supply.max)}
                          {a.supply.left === 0 ? t("agents.soldOut") : ""}
                        </span>
                      ) : (
                        <span className="faint" title={t("agents.unlimited")}>
                          {" / ∞"}
                        </span>
                      )}
                    </span>
                    <span className="num">
                      <span className="only-m tiny faint">{t("agents.cols.uses")} </span>
                      {f.int(a.uses)}
                    </span>
                    <span className="num">
                      <span className="only-m tiny faint">{t("agents.cols.rating")} </span>
                      {a.userRating > 0 ? f.dec1(a.userRating) : "—"}
                    </span>
                    <span className={["num", !hasEvalScore(a.evalScore) ? "faint" : a.evalScore >= 80 ? "ok" : "warn"].join(" ")} title={hasEvalScore(a.evalScore) ? evalMethodNote(lang) : undefined}>
                      <span className="only-m tiny faint">{t("agents.cols.performance")} </span>
                      {hasEvalScore(a.evalScore) ? `${Math.round(a.evalScore)}%` : t("agents.noEvals")}
                    </span>
                    <b className="num">
                      <span className="only-m tiny faint">{t("agents.cols.revenue")} </span>
                      {amount(a.revenueUnits)}
                    </b>
                  </div>
                  {expanded ? (
                    <div id={panelId} role="region" aria-label={t("agents.manageAria", { name: a.name })}>
                      <ManageSolver agent={a} platformBps={platformBps} onChanged={reload} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        )}
      </div>

      {data.guarantee ? (
        <div className="card pad-s" style={{ padding: "8px 24px", marginBottom: 24 }}>
          <div className="row between wrapx" style={{ padding: "14px 0" }}>
            <h2 className="h3">{t("guarantee.title")}</h2>
            <span className="small muted">{t("guarantee.subtitle")}</span>
          </div>
          <div className="g3 m1" style={gap(16, { padding: "4px 0 18px", borderTop: "1px solid var(--line)" })}>
            <div className="col" style={gap(4, { paddingTop: 14 })}>
              <span className="small muted">{t("guarantee.total")}</span>
              <span className="display num" style={{ fontSize: 34, lineHeight: 1, whiteSpace: "nowrap" }}>{headline(data.guarantee.earnedUnits)}</span>
              <span className="tiny faint">{amount(data.guarantee.earnedUnits)}</span>
            </div>
            <div className="col" style={gap(4, { paddingTop: 14 })}>
              <span className="small muted">{t("guarantee.last30")}</span>
              <span className="display num" style={{ fontSize: 34, lineHeight: 1, whiteSpace: "nowrap" }}>{headline(data.guarantee.last30Units)}</span>
              <span className="tiny faint">{amount(data.guarantee.last30Units)}</span>
            </div>
            <div className="col" style={gap(4, { paddingTop: 14 })}>
              <span className="small muted">{t("guarantee.releases")}</span>
              <span className="display num" style={{ fontSize: 34, lineHeight: 1 }}>{f.int(data.guarantee.releases)}</span>
              <span className="tiny faint">{t("guarantee.releasesSub")}</span>
            </div>
          </div>
          {data.guarantee.recent.length === 0 ? (
            <div style={{ borderTop: "1px solid var(--line)" }}>
              <Empty bare icon="shield-check" title={t("guarantee.emptyTitle")}>
                {t("guarantee.emptyText")}
              </Empty>
            </div>
          ) : (
            data.guarantee.recent.map((r) => {
              const link = txLink(r.txHash);
              return (
                <div key={r.txHash} className="rowline">
                  <span className="ok">
                    <Icon name="shield-check" size="s" />
                  </span>
                  <div className="grow col" style={gap(2, { minWidth: 0 })}>
                    <b className="trunc">{(r.agentId && nameOf.get(r.agentId)) || t("guarantee.fallbackTask")}</b>
                    <span className="tiny faint">
                      {f.date(r.at)}
                      {link ? (
                        <>
                          {" · "}
                          <a className="link" href={link} target="_blank" rel="noopener noreferrer">
                            {t("guarantee.viewTx")}
                          </a>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <b className="num">{amount(r.amountUnits)}</b>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      <div className="card pad-s" style={{ padding: "8px 24px" }}>
        <div className="row between wrapx" style={{ padding: "14px 0" }}>
          <h2 className="h3">{t("disputes.title")}</h2>
          <span className="small muted">{lostText}</span>
        </div>
        {data.disputes.length === 0 ? (
          <div style={{ borderTop: "1px solid var(--line)" }}>
            <Empty bare icon="flag" title={t("disputes.emptyTitle")}>
              {t("disputes.emptyText")}
            </Empty>
          </div>
        ) : (
          data.disputes.map((d) => {
            const r = RESULT[d.result];
            const resultLabel = t(`disputes.result.${d.result}`);
            return (
              <div key={`${d.escrowId}-${d.index}`} className="rowline start" style={{ alignItems: "flex-start" }}>
                <span className={r.tone} style={{ marginTop: 2 }}>
                  <Icon name="flag" size="s" />
                </span>
                <div className="grow col" style={gap(3, { minWidth: 0 })}>
                  <span className="only-m" style={{ marginBottom: 4 }}><Chip tone={r.chip}>{resultLabel}</Chip></span>
                  <b>{d.taskTitle}</b>
                  <div className="small muted">
                    {nameOf.get(d.agentId) ? `${nameOf.get(d.agentId)} · ` : ""}
                    {t("disputes.milestone", { n: d.index + 1, title: d.milestoneTitle })}
                  </div>
                  <div className="small muted">{t("disputes.criterion", { criterion: d.criterion ?? t("disputes.criterionNone") })}</div>
                  {d.reason ? <div className="small" style={{ color: "var(--ink-2)" }}>“{d.reason}”</div> : null}
                  <div className="tiny faint">
                    {d.openedAt ? f.date(d.openedAt) : t("disputes.dateNone")} · {amount(d.amountUnits)}
                  </div>
                </div>
                <span className="hide-m"><Chip tone={r.chip}>{resultLabel}</Chip></span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
