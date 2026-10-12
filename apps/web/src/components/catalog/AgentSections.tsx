"use client";
// Interactive parts of the Solver page: scores + technical details, before and after, versions and reviews.
import type { AgentVersion, BeforeAfter, Review } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useState, type CSSProperties, type MouseEvent } from "react";
import { Ago } from "@/components/ui/Ago";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { api } from "@/lib/api";
import { hasEvalScore } from "@/lib/eval-label";
import { useMyAccess } from "@/lib/hooks";
import { initials, short, starPct, useFormat } from "@/lib/format";
import { gap } from "@/lib/style";
import { ReviewPhotos } from "./Gallery";
import { useEvalText } from "./eval-text";

/**
 * Technical details of the version: fingerprint, the Solver's id in the registry contract (AgentDetail.onchain.agentId),
 * the registry address and the network.
 */
export type TechInfo = { hash: string; network: string; agentId: string | null; registry: string | null; explorer: string | null };

/** The three scores (people, internal tests, uses) and the technical details of the version. */
export function Scores({
  rating,
  reviewsCount,
  distribution,
  evalScore,
  version,
  verifiedUses,
  tech,
}: {
  rating: number;
  reviewsCount: number;
  distribution: number[];
  evalScore: number;
  version: string;
  verifiedUses: number;
  tech: TechInfo;
}) {
  const t = useTranslations("catalog.scores");
  const f = useFormat();
  const ev = useEvalText();
  const [open, setOpen] = useState(false);
  const total = distribution.reduce((s, n) => s + n, 0);
  // With reviews, the whole card leads to the list (#avaliar, at the end of the page).
  const toReviews = (e: MouseEvent<HTMLElement>) => {
    const target = document.getElementById("avaliar");
    if (!target) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", "#avaliar");
  };
  const UsersCard = reviewsCount > 0 ? "a" : "div";
  return (
    <section className="wrap" style={{ paddingBottom: 64 }}>
      <div className="g3 gn3" style={gap("22px")}>
        <UsersCard
          className="score-card score-users col"
          style={gap("16px")}
          {...(reviewsCount > 0 ? { href: "#avaliar", onClick: toReviews, "aria-label": t("usersAria", { rating: f.dec1(rating), count: reviewsCount }) } : {})}
        >
          <div className="row" style={gap("8px")}>
            <span className="warn">
              <Icon name="users" />
            </span>
            <span className="eyebrow" style={{ color: "var(--amber)" }}>
              {t("usersTitle")}
            </span>
          </div>
          {reviewsCount > 0 ? (
            <>
              <div className="row" style={gap("16px", { alignItems: "flex-end" })}>
                <span className="display big num" style={{ lineHeight: 0.9 }}>
                  {f.dec1(rating)}
                </span>
                <div className="col" style={gap("4px", { paddingBottom: 6 })}>
                  <span className="stars" style={{ "--p": `${starPct(rating)}%` } as CSSProperties} role="img" aria-label={t("ratingAria", { rating: f.dec1(rating) })} />
                  <span className="small muted">{t("reviewsCount", { count: reviewsCount })}</span>
                </div>
              </div>
              <div className="col" style={gap("8px")}>
                {distribution.map((n, i) => {
                  const p = total ? Math.round((n / total) * 100) : 0;
                  return (
                    <div key={i} className="row" style={gap("10px")}>
                      <span className="small num" style={{ width: 26 }}>
                        {5 - i}★
                      </span>
                      <div className="bar amber grow" role="img" aria-label={t("starsAria", { n: 5 - i, p })}>
                        <i style={{ width: `${p}%` }} />
                      </div>
                      <span className="small faint num" style={{ width: 36, textAlign: "right" }}>
                        {p}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="muted">{t("noReviewsYet")}</p>
          )}
          <p className="tiny faint">{t("onlyBuyers")}</p>
          {reviewsCount > 0 ? <span className="score-more">{t("seeReviews")}</span> : null}
        </UsersCard>

        <div className="score-card score-verified col" style={gap("16px")}>
          <div className="row" style={gap("8px")}>
            <span className="ok">
              <Icon name="shield-check" />
            </span>
            <span className="eyebrow" style={{ color: "var(--mint)" }}>
              {t("testsTitle")}
            </span>
          </div>
          {hasEvalScore(evalScore) ? (
            <>
              <div className="row" style={gap("20px")}>
                <div className="ring" style={{ "--p": evalScore } as CSSProperties}>
                  <div>
                    <span className="display num" style={{ fontSize: 36 }}>
                      {Math.round(evalScore)}%
                    </span>
                  </div>
                </div>
                <div className="col" style={gap("4px")}>
                  <b style={{ fontSize: 17, lineHeight: 1.3 }}>{t("testsSolved")}</b>
                  <span className="small muted">{t("testsVersion", { note: ev.note, version })}</span>
                </div>
              </div>
              <div className="col" style={gap("4px")}>
                <div className="row between small">
                  <span className="muted">{t("withSolver")}</span>
                  <b className="num ok">{Math.round(evalScore)}%</b>
                </div>
                <div className="bar mint">
                  <i style={{ width: `${evalScore}%` }} />
                </div>
              </div>
            </>
          ) : (
            <div className="col" style={gap("4px")}>
              <b style={{ fontSize: 17, lineHeight: 1.3 }}>{t("noEvalTitle")}</b>
              <span className="small muted">{t("noEvalBody", { version })}</span>
            </div>
          )}
          <button type="button" className="link-btn small" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="tech" style={{ alignSelf: "flex-start" }}>
            {open ? t("hideTech") : t("showTech")}
          </button>
        </div>

        <div className="card pad col" style={gap("14px", { justifyContent: "space-between" })}>
          <span className="chip chip-brand" style={{ alignSelf: "flex-start" }}>
            <Icon name="bolt" size="s" />
            {t("provenUse")}
          </span>
          <div>
            <div className="display big num" style={{ lineHeight: 0.95 }}>
              {f.int(verifiedUses)}
            </div>
            <div className="bold" style={{ marginTop: 6 }}>
              {t("verifiedUses", { count: verifiedUses })}
            </div>
          </div>
          <p className="small muted">{t("verifiedUsesNote")}</p>
        </div>
      </div>
      {open ? (
        <dl className="tech" id="tech" style={{ marginTop: 16 }}>
          <dt>{t("techHash")}</dt>
          <dd className="mono">{tech.hash}</dd>
          {tech.agentId ? (
            <>
              <dt>{t("techRecord")}</dt>
              <dd className="mono">{tech.agentId}</dd>
            </>
          ) : null}
          {tech.registry ? (
            <>
              <dt>{t("techContract")}</dt>
              <dd className="mono">{tech.registry}</dd>
            </>
          ) : null}
          <dt>{t("techNetwork")}</dt>
          <dd>{tech.network}</dd>
          {tech.explorer ? (
            <a className="link small" href={tech.explorer} target="_blank" rel="noopener noreferrer">
              {t("openExplorer")} <Icon name="external" size="s" />
            </a>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

/** "Before and after": the same request without and with the Solver. With more than one example, tabs to switch. */
export function BeforeAfterBlock({ items, name }: { items: BeforeAfter[]; name: string }) {
  const t = useTranslations("catalog.beforeAfter");
  const [i, setI] = useState("0");
  const cur = items[Number(i)] ?? items[0];
  if (!cur) return null;
  return (
    <section className="wrap" style={{ paddingBottom: 64 }}>
      <div className="col" style={gap("8px", { marginBottom: 26 })}>
        <h2 className="display h2s">{t("title")}</h2>
        <p className="muted" style={{ maxWidth: 620 }}>
          {t("sub", { name })}
        </p>
      </div>
      {items.length > 1 ? (
        <Tabs
          aria-label={t("tabsAria")}
          value={i}
          onChange={setI}
          tabs={items.map((_, k) => ({ id: String(k), label: t("example", { n: k + 1 }) }))}
          className="ba-tabs"
        />
      ) : null}
      <div className="card pad-s row start" style={gap("12px", { margin: items.length > 1 ? "18px 0 22px" : "0 0 22px" })} role="tabpanel">
        <span className="av av-s">{t("me")}</span>
        <p className="bubble me grow" style={{ borderRadius: 16 }}>
          {cur.prompt}
        </p>
      </div>
      <div className="g2" style={gap("22px")}>
        <div className="card-flat pad col" style={gap("18px")}>
          <div className="row between">
            <b>{t("alone")}</b>
            <span className="chip">{t("generic")}</span>
          </div>
          <p className="muted">“{cur.withoutSolver}”</p>
        </div>
        <div className="card pad col" style={gap("18px", { borderColor: "color-mix(in oklab,var(--mint) 40%,var(--line))" })}>
          <div className="row between">
            <b>{t("withSolver")}</b>
            <span className="chip chip-ok">
              <Icon name="check" size="s" />
              {t("ready")}
            </span>
          </div>
          <p>“{cur.withSolver}”</p>
        </div>
      </div>
    </section>
  );
}

/** Version history: the current one and, when expanded, all of them. */
export function Versions({ versions }: { versions: AgentVersion[] }) {
  const t = useTranslations("catalog.versions");
  const f = useFormat();
  const ev = useEvalText();
  const [all, setAll] = useState(false);
  const shown = all ? versions : versions.slice(0, 1);
  return (
    <div className="card pad-s" style={{ padding: "6px 24px" }}>
      {shown.map((v, i) => (
        <div key={v.version} className="rowline start">
          <span className={`chip${i === 0 ? " chip-ok" : ""}`} style={{ minWidth: 74, justifyContent: "center" }}>
            {v.version}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="bold">{v.notes || t("noNotes")}</div>
            <div className="small muted">
              {f.date(v.releasedAt)}
              {hasEvalScore(v.evalScore) ? ` · ${ev.short(v.evalScore)}` : ""}
              {v.versionHash ? (
                <>
                  {" · "}
                  <span className="mono" title={v.versionHash}>
                    {v.versionHash.slice(0, 15)}…
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ))}
      {versions.length > 1 ? (
        <div className="rowline">
          <button type="button" className="link-btn" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? t("showCurrent") : t("showAll", { count: versions.length })}
            <Icon name="chevron-down" size="s" style={all ? { transform: "rotate(180deg)" } : undefined} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

const FIRST = 6;

/**
 * License holders review from their library (the review is a wallet-signed transaction); this page only displays the
 * reviews and points there.
 */
function MyReviewPrompt({ slug }: { slug: string }) {
  const t = useTranslations("catalog.reviews");
  const access = useMyAccess(slug);
  if (!access?.license) return null;
  return (
    <div className="card-flat pad-s row between wrapx" style={gap("12px")}>
      <span className="small">{t("reviewInLibrary")}</span>
      <Button href="/library" size="sm" variant="secondary" iconRight="arrow-right">
        {t("goLibrary")}
      </Button>
    </div>
  );
}

/** Reviews: the first ones and, on "see all", the full list from getReviews(). */
export function Reviews({ slug, initial, total }: { slug: string; initial: Review[]; total: number }) {
  const t = useTranslations("catalog.reviews");
  const f = useFormat();
  const [list, setList] = useState(initial.slice(0, FIRST));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const more = total > list.length;

  const loadAll = () => {
    setLoading(true);
    setFailed(false);
    api.getReviews(slug).then(
      (r) => {
        setList(r);
        setLoading(false);
      },
      () => {
        setFailed(true);
        setLoading(false);
      },
    );
  };

  const mineBox = <MyReviewPrompt slug={slug} />;

  if (list.length === 0)
    return (
      <div className="col" style={gap("18px")}>
        {mineBox}
        <div className="card-flat pad center muted">{t("empty")}</div>
      </div>
    );

  return (
    <>
      <div style={{ marginBottom: 18 }}>{mineBox}</div>
      <div className="g2" style={gap("18px")}>
        {list.map((r) => {
          // Reviewer profile name; without it, the shortened wallet.
          const who = r.authorName?.trim() || t("buyer", { wallet: short(r.authorWallet) });
          return (
            <article key={r.id} className="card pad-s col" style={gap("12px")}>
              <div className="row" style={gap("12px")}>
                <span className="av" aria-hidden>
                  {r.authorName?.trim() ? initials(r.authorName) : r.authorWallet.slice(0, 2).toUpperCase()}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b className="trunc" style={{ display: "block" }}>
                    {who}
                  </b>
                  <Ago className="tiny faint" iso={r.createdAt} />
                </div>
                <span className="chip chip-ok">
                  <Icon name="shield-check" size="s" />
                  {t("verifiedPurchase")}
                </span>
              </div>
              <span className="stars" style={{ "--p": `${starPct(r.rating)}%` } as CSSProperties} role="img" aria-label={t("ratingAria", { rating: r.rating })} />
              <p className="muted">{r.text}</p>
              <ReviewPhotos images={r.images} who={who} />
            </article>
          );
        })}
      </div>
      {failed ? (
        <p className="small muted center" role="alert" style={{ marginTop: 16 }}>
          {t("loadFailed")}
        </p>
      ) : null}
      {more ? (
        <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
          <Button variant="secondary" loading={loading} onClick={loadAll}>
            {t("seeAll", { count: f.int(total) })}
          </Button>
        </div>
      ) : null}
    </>
  );
}
