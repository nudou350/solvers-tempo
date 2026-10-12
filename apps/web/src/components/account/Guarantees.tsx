"use client";
// /guarantees: the buyer's guarantee limit, guarantees in progress and history.
import type { Escrow, EscrowDetail, GuaranteeStatus } from "@solvers/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/ui/AuthGate";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Empty } from "@/components/ui/Empty";
import { Icon } from "@/components/ui/Icon";
import { Loading } from "@/components/ui/Spinner";
import { Tile } from "@/components/ui/Tile";
import { Notice } from "@/components/ui/Toast";
import type { Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/format";
import { useAgentsIndex } from "@/lib/hooks";
import { useAmount } from "./account-tx";
import { Deliverable, ESCROW_CHIP, EscrowCard } from "./EscrowCard";
import { LoadError, PageHead } from "./shared";
import { HeldPayouts } from "./WalletSummary";

function LevelCard({ g }: { g: GuaranteeStatus | null }) {
  const t = useTranslations("account.guarantees");
  const f = useFormat();
  const money = useAmount();
  if (!g) return null;
  return (
    <div className="card pad-s row start" style={{ "--gap": "12px", padding: "14px 18px", maxWidth: 380 } as React.CSSProperties}>
      <span className="ok">
        <Icon name="shield-check" size="l" />
      </span>
      <div className="col grow" style={{ "--gap": "2px" } as React.CSSProperties}>
        <div className="small muted">{t("levelTitle")}</div>
        <b>{t("levelLine", { level: f.guaranteeLevel(g.level), limit: money(g.limitUsdc) })}</b>
        <span className="tiny faint">{t("levelDetail", { open: money(g.openUsdc), available: money(g.availableUsdc) })}</span>
        {g.purchasesToFull > 0 ? (
          <span className="tiny faint">
            {t("toFull", { n: g.purchasesToFull })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** `failed`: guarantees whose detail (criteria, deadlines, preview) did not load; each card offers "Try again". */
type Data = { escrows: Escrow[]; details: Map<string, EscrowDetail>; failed: Set<string> };

/** Refresh interval while a guarantee is in progress (the solver can deliver at any time). */
const REFRESH_MS = 30_000;
/** When the tab regains focus, refresh only if the last load is older than this. */
const RESUME_MIN_MS = 5_000;

function Inner() {
  const lang = useLocale() as Locale;
  const t = useTranslations("account.guarantees");
  const money = useAmount();
  const te = useTranslations("account.escrow");
  const [data, setData] = useState<Data | null | "error">(null);
  const [g, setG] = useState<GuaranteeStatus | null>(null);
  const escrows = data && data !== "error" ? data.escrows : [];
  const agents = useAgentsIndex(escrows.map((e) => e.agentId));

  // Each load has a number: only the latest one stores its result (concurrent loads arrive out of order).
  const loadSeq = useRef(0);
  const loadedAt = useRef(0);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      const seq = ++loadSeq.current;
      if (!quiet) setData(null);
      api.getMyGuarantee().then(
        (v) => seq === loadSeq.current && setG(v),
        () => {},
      );
      try {
        const list = await api.getMyEscrows();
        // Step details (criteria, preview, deadlines, downloads) of each guarantee.
        const det = await Promise.all(list.map((e) => api.getMyEscrow(e.id, lang).catch(() => null)));
        if (seq !== loadSeq.current) return;
        const details = new Map<string, EscrowDetail>();
        const failed = new Set<string>();
        det.forEach((d, i) => {
          if (d) details.set(d.escrow.id, d);
          else if (list[i]) failed.add(list[i].id);
        });
        // The detail carries the newest state of the guarantee.
        const fresh = list.map((e) => details.get(e.id)?.escrow ?? e);
        const created = (e: Escrow) => details.get(e.id)?.createdAt ?? "";
        loadedAt.current = Date.now();
        setRefreshFailed(false);
        setData({ escrows: [...fresh].sort((a, b) => created(b).localeCompare(created(a))), details, failed });
      } catch {
        if (seq !== loadSeq.current) return;
        if (!quiet) setData("error");
        else setRefreshFailed(true);
      }
    },
    [lang],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Retries only the detail of one guarantee (the card button).
  const retryDetail = useCallback(
    async (id: string) => {
      const d = await api.getMyEscrow(id, lang).catch(() => null);
      if (!d) return false;
      setData((cur) => {
        if (!cur || cur === "error") return cur;
        const details = new Map(cur.details).set(id, d);
        const failed = new Set(cur.failed);
        failed.delete(id);
        return { escrows: cur.escrows.map((e) => (e.id === id ? d.escrow : e)), details, failed };
      });
      return true;
    },
    [lang],
  );

  // Guarantee in progress: refresh every 30 s and when the tab regains focus (deliveries arrive while the person is in the AI chat).
  const hasActive = data !== null && data !== "error" && data.escrows.some((e) => e.status === "active" || e.status === "disputed");
  useEffect(() => {
    if (!hasActive) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    const resume = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > RESUME_MIN_MS) void load(true);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [hasActive, load]);

  const head = (
    <PageHead
      title={t("title")}
      lead={t("lead")}
      aside={<LevelCard g={g} />}
    />
  );

  if (data === "error")
    return (
      <>
        {head}
        <LoadError onRetry={() => void load()} text={t("loadError")} />
      </>
    );
  if (data === null)
    return (
      <>
        {head}
        <Loading text={t("loading")} />
      </>
    );

  const active = data.escrows.filter((e) => e.status === "active" || e.status === "disputed");
  const history = data.escrows.filter((e) => e.status === "approved" || e.status === "refunded");

  return (
    <>
      {head}
      <div className="col" style={{ "--gap": "22px" } as React.CSSProperties}>
        <HeldPayouts />
        {refreshFailed ? (
          <Notice
            tone="warn"
            title={t("refreshFailedTitle")}
            actions={
              <Button size="sm" variant="secondary" icon="refresh" onClick={() => void load(true)}>
                {t("refresh")}
              </Button>
            }
          >
            {t("refreshFailedText")}
          </Notice>
        ) : null}
        {active.map((e) => (
          <EscrowCard
            key={e.id}
            escrow={e}
            detail={data.details.get(e.id) ?? null}
            detailFailed={data.failed.has(e.id)}
            onRetryDetail={() => retryDetail(e.id)}
            agent={agents.get(e.agentId)}
            onChanged={() => void load(true)}
          />
        ))}
        {!active.length ? (
          <Empty icon="shield-check" title={t("emptyTitle")} action={<Button href="/">{t("explore")}</Button>}>
            {t("emptyText")}
          </Empty>
        ) : null}
      </div>

      {history.length ? (
        <div style={{ marginTop: 44 }}>
          <h2 className="display h2s" style={{ marginBottom: 18 }}>
            {t("history")}
          </h2>
          <div className="card pad-s" style={{ padding: "6px 24px" }}>
            {history.map((e) => {
              const a = agents.get(e.agentId);
              const d = data.details.get(e.id);
              const [chipKey, tone] = ESCROW_CHIP[e.status];
              const files = d?.milestones.filter((m) => m.downloadable) ?? [];
              return (
                <div key={e.id} className="rowline wrapx">
                  {a ? <Tile category={a.category} size="s" /> : <span className="tile tile-s" aria-hidden />}
                  <div className="grow" style={{ minWidth: 180 }}>
                    <b>{e.title}</b>
                    <div className="small muted">{d?.agent.name ?? a?.name ?? ""}</div>
                  </div>
                  {files.map((m) => (
                    <Deliverable key={m.index} escrowId={e.id} index={m.index} label={files.length > 1 ? t("downloadStep", { n: m.index + 1 }) : t("downloadDelivery")} />
                  ))}
                  <b className="num hide-m">{money(e.amountUsdc)}</b>
                  <Chip tone={tone}>{te(chipKey)}</Chip>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Guarantees() {
  const t = useTranslations("account.guarantees");
  return (
    <section className="wrap" style={{ paddingTop: 44, paddingBottom: 56 }}>
      <AuthGate icon="shield-check" title={t("gateTitle")} text={t("gateText")}>
        <Inner />
      </AuthGate>
    </section>
  );
}
