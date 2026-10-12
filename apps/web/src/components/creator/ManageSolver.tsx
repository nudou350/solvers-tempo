"use client";
// Settings of one registered Solver in the creator dashboard: price per use, transfer royalty share, license cap,
// on-chain public details, deposit (stake) and contesting a deposit penalty. Each change is ONE sponsored transaction
// built by the server (POST /api/tx/creator/:id/...) and signed by the creator; the screen checks the same rules first so
// the creator gets a clear message before the wallet opens. License price and version only change through a reviewed
// submission. The current values come from the dashboard (indexer mirror + live Staking reads).
import type { CreatorDashboard } from "@solvers/api-client";
import { MAX_TOTAL_ROYALTY_BPS, type TxResponse } from "@solvers/shared";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Notice, useToast } from "@/components/ui/Toast";
import { useFormat } from "@/lib/format";
import { gap } from "@/lib/style";
import { useCreatorTx, useIntlLocale, useMoney, useToken, useTxLink, type Hash } from "./creator-glue";
import {
  canContest,
  CONTEST_MAX,
  CONTEST_MIN,
  maxCreatorRoyaltyBps,
  parseAmount,
  parsePercentToBps,
  royaltyCheck,
  stakeActions,
  supplyCheck,
  withdrawBlock,
  type AmountParse,
} from "./creator-rules";
import { creatorTx } from "./creator-tx";

type Row = CreatorDashboard["agents"][number];

export function ManageSolver({ agent, platformBps, onChanged }: { agent: Row; platformBps: number | null; onChanged: () => Promise<void> }) {
  const t = useTranslations("creator.manage");
  const toast = useToast();
  const txLink = useTxLink();
  const tx = useCreatorTx();
  const [done, setDone] = useState<{ action: string; hash: Hash } | null>(null);
  const id = agent.agentId;

  async function run(action: string, build: () => Promise<TxResponse>): Promise<boolean> {
    setDone(null);
    const hash = await tx.run(action, build);
    if (!hash) return false;
    setDone({ action, hash });
    const link = txLink(hash);
    toast({
      tone: "ok",
      title: t("done"),
      text: t(`doneText.${action}`),
      ...(link ? { action: { label: t("viewTx"), onClick: () => window.open(link, "_blank", "noopener,noreferrer") } } : {}),
    });
    await onChanged();
    return true;
  }

  const err = (action: string) => (tx.failedAction === action && tx.error ? tx.error : null);
  const doneLink = done ? txLink(done.hash) : null;

  return (
    <div className="col" style={gap(16, { padding: "4px 0 20px" })}>
      <p className="small muted">{t("intro")}</p>
      {done ? (
        <Notice tone="ok" role="status" title={t("done")}>
          {t(`doneText.${done.action}`)}{" "}
          {doneLink ? (
            <a className="link" href={doneLink} target="_blank" rel="noopener noreferrer">
              {t("viewTx")}
            </a>
          ) : null}
        </Notice>
      ) : null}
      <div className="g2 m1" style={gap(16)}>
        <PricingForm agent={agent} pending={tx.pending === "pricing"} disabled={!!tx.pending} error={err("pricing")} onSubmit={(units) => run("pricing", () => creatorTx.pricing(id, units))} />
        <RoyaltyForm current={agent.royaltyBps} sales={agent.sales} platformBps={platformBps} pending={tx.pending === "royalty"} disabled={!!tx.pending} error={err("royalty")} onSubmit={(bps) => run("royalty", () => creatorTx.royalty(id, bps))} />
        <SupplyForm agent={agent} pending={tx.pending === "supply"} disabled={!!tx.pending} error={err("supply")} onSubmit={(max) => run("supply", () => creatorTx.supplyCap(id, max))} />
        <Section title={t("metadata.title")} text={t("metadata.text")} error={err("metadata")}>
          <p className="small" style={{ overflowWrap: "anywhere" }}>
            {agent.metadataUri ? t("metadata.current", { uri: agent.metadataUri }) : agent.chainRead ? t("metadata.none") : t("metadata.unknown")}
          </p>
          <div>
            <Button variant="secondary" loading={tx.pending === "metadata"} disabled={!!tx.pending} onClick={() => void run("metadata", () => creatorTx.metadata(id))}>
              {t("metadata.submit")}
            </Button>
          </div>
        </Section>
      </div>
      <StakePanel agent={agent} pending={tx.pending} error={(a) => err(a)} run={run} />
      <ContestForm agent={agent} pending={tx.pending === "contest"} disabled={!!tx.pending} error={err("contest")} onSubmit={(reason) => run("contest", () => creatorTx.slashContest(id, reason))} />
    </div>
  );
}

function Section({ title, text, error, children }: { title: string; text: ReactNode; error?: string | null; children: ReactNode }) {
  const t = useTranslations("creator.manage");
  return (
    <section className="card-flat pad-s col" style={gap(10)}>
      <h3 className="h4">{title}</h3>
      <p className="small muted">{text}</p>
      {children}
      {error ? (
        <Notice tone="bad" role="alert" title={t("failTitle")}>
          {error}
        </Notice>
      ) : null}
    </section>
  );
}

/** Message for an amount the creator typed, in the page language. */
function useAmountProblem(): (p: Exclude<AmountParse, { ok: true }>, decimals: number) => string {
  const t = useTranslations("creator.manage.errors");
  return (p, decimals) => t(p.reason, { decimals });
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="hint" style={{ color: "var(--red)" }} role="alert" id={`${id}-err`}>
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function PricingForm({ agent, pending, disabled, error, onSubmit }: { agent: Row; pending: boolean; disabled: boolean; error: string | null; onSubmit: (units: string) => Promise<boolean> }) {
  const t = useTranslations("creator.manage.pricing");
  const token = useToken();
  const money = useMoney();
  const problem = useAmountProblem();
  const fid = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const parsed = token ? parseAmount(value, token.decimals, { allowZero: true }) : null;
  const invalid = touched && parsed && !parsed.ok ? problem(parsed, token?.decimals ?? 0) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!parsed?.ok || disabled) return;
    if (await onSubmit(parsed.units)) {
      setValue("");
      setTouched(false);
    }
  }

  return (
    <Section title={t("title")} text={t("text")} error={error}>
      {token ? (
        <p className="small">
          {BigInt(agent.pricePerUseUnits) > 0n
            ? t("current", { perUse: money(agent.pricePerUseUnits), price: money(agent.priceUnits) })
            : t("off", { price: money(agent.priceUnits) })}
        </p>
      ) : null}
      <form className="col" style={gap(10)} onSubmit={submit} noValidate>
        <Field id={fid} label={t("label", { symbol: token?.symbol ?? "" })} hint={t("hint")} error={invalid}>
          <input id={fid} className="input" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!invalid} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" loading={pending} disabled={disabled || !token}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function RoyaltyForm({ current, sales, platformBps, pending, disabled, error, onSubmit }: { current: number; sales: number; platformBps: number | null; pending: boolean; disabled: boolean; error: string | null; onSubmit: (bps: number) => Promise<boolean> }) {
  const t = useTranslations("creator.manage.royalty");
  const te = useTranslations("creator.manage.errors");
  const locale = useIntlLocale();
  const fid = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const pct = (bps: number) => `${(bps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
  const maxBps = maxCreatorRoyaltyBps(platformBps);
  const locked = sales > 0;
  const parsed = parsePercentToBps(value);
  const check = parsed.ok ? royaltyCheck(parsed.bps, platformBps, sales) : null;
  const invalid = !touched
    ? null
    : !parsed.ok
      ? parsed.reason === "too_precise"
        ? te("pctTooPrecise")
        : te("pctInvalid")
      : check && !check.ok && check.reason === "too_high"
        ? te("royaltyTooHigh", { max: pct(check.maxBps) })
        : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!parsed.ok || !check?.ok || disabled) return;
    if (await onSubmit(parsed.bps)) {
      setValue("");
      setTouched(false);
    }
  }

  const text = platformBps == null ? t("textNoPlatform", { max: pct(MAX_TOTAL_ROYALTY_BPS) }) : t("text", { platform: pct(platformBps), max: pct(MAX_TOTAL_ROYALTY_BPS) });
  return (
    <Section title={t("title")} text={text} error={error}>
      <p className="small">{t("current", { pct: pct(current) })}</p>
      {locked ? (
        <p className="small">
          <Icon name="lock" size="s" /> {t("locked")}
        </p>
      ) : (
        <form className="col" style={gap(10)} onSubmit={submit} noValidate>
          <Field id={fid} label={t("label")} hint={t("hint", { max: pct(maxBps) })} error={invalid}>
            <input id={fid} className="input" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!invalid} />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={pending} disabled={disabled}>
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function SupplyForm({ agent, pending, disabled, error, onSubmit }: { agent: Row; pending: boolean; disabled: boolean; error: string | null; onSubmit: (max: number) => Promise<boolean> }) {
  const t = useTranslations("creator.manage.supply");
  const te = useTranslations("creator.manage.errors");
  const fid = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const supply = agent.supply;
  const next = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const check = supplyCheck(supply, next);
  const invalid = !touched || check.ok
    ? null
    : check.reason === "too_high"
      ? te("supplyTooHigh")
      : check.reason === "invalid"
        ? te("supplyInvalid")
        : te("supplyBelow", { min: check.min });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!check.ok || disabled) return;
    if (await onSubmit(next)) {
      setValue("");
      setTouched(false);
    }
  }

  const minHint = supplyCheck(supply, 0);
  const min = minHint.ok ? 1 : minHint.min;
  return (
    <Section title={t("title")} text={t("text")} error={error}>
      <p className="small">{supply.max == null ? t("unlimited", { sold: supply.sold }) : t("current", { sold: supply.sold, max: supply.max })}</p>
      <form className="col" style={gap(10)} onSubmit={submit} noValidate>
        <Field id={fid} label={t("label")} hint={t("hint", { min })} error={invalid}>
          <input id={fid} className="input" inputMode="numeric" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!invalid} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" loading={pending} disabled={disabled}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

type Run = (action: string, build: () => Promise<TxResponse>) => Promise<boolean>;

function StakePanel({ agent, pending, error, run }: { agent: Row; pending: string | null; error: (action: string) => string | null; run: Run }) {
  const t = useTranslations("creator.manage.stake");
  const token = useToken();
  const money = useMoney();
  const f = useFormat();
  const problem = useAmountProblem();
  const fid = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const can = stakeActions(agent.status, agent);
  const blocked = withdrawBlock(agent.status, agent);
  const exit = agent.stakeExit;
  const slash = agent.slash;
  const id = agent.agentId;
  const parsed = token ? parseAmount(value, token.decimals) : null;
  const invalid = touched && parsed && !parsed.ok ? problem(parsed, token?.decimals ?? 0) : null;
  const errors = ["stakeTopUp", "stakeExit", "stakeCancelExit", "stakeWithdraw"].map(error).filter(Boolean);

  async function topUp(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!parsed?.ok || pending) return;
    const units = parsed.units;
    if (await run("stakeTopUp", () => creatorTx.stakeTopUp(id, units))) {
      setValue("");
      setTouched(false);
    }
  }

  return (
    <Section title={t("title")} text={agent.status === "retired" ? t("retiredText") : t("text")} error={errors[0] ?? null}>
      {token ? <p className="small bold">{t("current", { amount: money(agent.stakeUnits) })}</p> : null}
      {!agent.chainRead ? (
        <Notice tone="info" title={t("unknownTitle")}>
          {t("unknown")}
        </Notice>
      ) : null}
      {exit ? (
        <p className="small">
          {t("exitAt", { date: f.date(exit.exitAt) })}
          {exit.extensions > 0 ? ` ${t("extended", { n: exit.extensions })}` : ""}
        </p>
      ) : null}
      {slash ? (
        <Notice tone="warn" title={t("slashTitle")}>
          {t("slashPending", { amount: money(slash.amountUnits), from: f.date(slash.executableAt), until: f.date(slash.expiresAt) })}
          {slash.contested ? ` ${t("slashContested")}` : ""}
        </Notice>
      ) : null}
      {blocked?.reason === "no_exit" ? <p className="small muted">{t("noExit")}</p> : null}
      {can.topUp ? (
        <form className="row wrapx end" style={gap(10)} onSubmit={topUp} noValidate>
          <div style={{ flex: "1 1 220px" }}>
            <Field id={fid} label={t("amountLabel", { symbol: token?.symbol ?? "" })} error={invalid}>
              <input id={fid} className="input" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!invalid} />
            </Field>
          </div>
          <Button type="submit" variant="secondary" loading={pending === "stakeTopUp"} disabled={!!pending || !token}>
            {t("topUp")}
          </Button>
        </form>
      ) : null}
      <div className="row wrapx" style={gap(10)}>
        {can.exit ? (
          <Button variant="danger" disabled={!!pending} onClick={() => setConfirmExit(true)}>
            {t("exit")}
          </Button>
        ) : null}
        {can.cancelExit ? (
          <Button variant="secondary" loading={pending === "stakeCancelExit"} disabled={!!pending} onClick={() => void run("stakeCancelExit", () => creatorTx.stakeCancelExit(id))}>
            {t("cancelExit")}
          </Button>
        ) : null}
        {agent.status === "retired" && blocked?.reason !== "no_exit" ? (
          <Button
            loading={pending === "stakeWithdraw"}
            disabled={!!pending || !can.withdraw}
            onClick={() => void run("stakeWithdraw", () => creatorTx.stakeWithdraw(id))}
          >
            {t("withdraw")}
          </Button>
        ) : null}
      </div>
      {can.cancelExit ? <p className="tiny faint">{t("cancelNote")}</p> : null}
      {confirmExit ? (
        <Dialog title={t("confirm.title")} onClose={() => setConfirmExit(false)} locked={pending === "stakeExit"}>
          <div className="col" style={gap(16)}>
            <ul className="col small" style={gap(8, { paddingLeft: 18, listStyle: "disc" })}>
              <li>{t("confirm.p1")}</li>
              <li>{t("confirm.p2")}</li>
              <li>{t("confirm.p3")}</li>
            </ul>
            <div className="row wrapx" style={gap(10)}>
              <Button
                variant="danger"
                loading={pending === "stakeExit"}
                onClick={() => void run("stakeExit", () => creatorTx.stakeExit(id)).then(() => setConfirmExit(false))}
              >
                {t("confirm.label")}
              </Button>
              <Button variant="ghost" disabled={pending === "stakeExit"} onClick={() => setConfirmExit(false)}>
                {t("confirm.back")}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Section>
  );
}

function ContestForm({ agent, pending, disabled, error, onSubmit }: { agent: Row; pending: boolean; disabled: boolean; error: string | null; onSubmit: (reason: string) => Promise<boolean> }) {
  const t = useTranslations("creator.manage.contest");
  const te = useTranslations("creator.manage.errors");
  const fid = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const len = reason.trim().length;
  const invalid = touched && len < CONTEST_MIN ? te("contestShort", { min: CONTEST_MIN }) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (len < CONTEST_MIN || disabled) return;
    if (await onSubmit(reason.trim())) {
      setReason("");
      setTouched(false);
    }
  }

  // Only while a penalty is proposed and not contested yet (with an unknown state the server decides).
  if (!canContest(agent)) return null;
  return (
    <details className="card-flat pad-s" open={!!agent.slash}>
      <summary className="bold" style={{ cursor: "pointer", minHeight: 32, display: "flex", alignItems: "center" }}>
        {t("title")}
      </summary>
      <form className="col" style={gap(10, { marginTop: 10 })} onSubmit={submit} noValidate>
        <p className="small muted">{t("text")}</p>
        <Field id={fid} label={t("label")} hint={t("hint", { min: CONTEST_MIN, max: CONTEST_MAX, count: len })} error={invalid}>
          <textarea id={fid} className="textarea" value={reason} maxLength={CONTEST_MAX} onChange={(e) => setReason(e.target.value)} aria-invalid={!!invalid} />
        </Field>
        {error ? (
          <Notice tone="bad" role="alert" title={t("failTitle")}>
            {error}
          </Notice>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" loading={pending} disabled={disabled}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </details>
  );
}
