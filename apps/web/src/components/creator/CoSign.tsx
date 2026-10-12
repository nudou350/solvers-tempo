"use client";
// The creator's signature after the review approved the package (PACKAGE_SPEC.md 15.2). The server says what is missing
// (GET /tx/publication/:id -> `step`) and builds ONE batched transaction from the approved record (registration or
// update, with price, royalty and license cap in the same batch); the creator signs it once, the platform pays the fee,
// then POST /tx/publication/confirm links the transaction hash to the submission. A new Solver then waits for the
// platform's on-chain approval, which the team signs with an offline key (`cli:approve`), never from the site.
import { CREATOR_SIGNING_STEPS, type CreatorSigningStep, type PublicationPlan, type SubmissionView } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Notice, useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { gap } from "@/lib/style";
import { loadErrorText } from "@/lib/submissions-ui";
import { useFaucet } from "@/lib/tx";
import { useMoney, useCreatorErrorText, useEnsureSigner, useSendBuilt, useTxLink, type Hash } from "./creator-glue";
import { PUBLISH_PHASES, publishPhases, type PhaseState } from "./creator-rules";
import s from "./creator.module.css";

const isSigning = (step: PublicationPlan["step"]): step is CreatorSigningStep => step !== null && (CREATOR_SIGNING_STEPS as readonly string[]).includes(step);

const build = (step: CreatorSigningStep, id: string) =>
  step === "register-agent" ? api.buildRegisterAgent(id) : step === "update-version" ? api.buildUpdateVersion(id) : api.buildUpdatePricing(id);

export function CoSign({ sub, onDone }: { sub: SubmissionView; onDone: () => Promise<void> }) {
  const t = useTranslations("creator.cosign");
  const tSub = useTranslations("submissions");
  const errorText = useCreatorErrorText();
  const money = useMoney();
  const txLink = useTxLink();
  const sendBuilt = useSendBuilt();
  const ensureSigner = useEnsureSigner();
  const faucet = useFaucet();
  const toast = useToast();
  // Translators kept in refs: they change every render and must not refetch the plan.
  const loadMsg = useRef((e: unknown) => String(e));
  loadMsg.current = (e) => loadErrorText(tSub, e, errorText);
  const [plan, setPlan] = useState<PublicationPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [local, setLocal] = useState<"idle" | "signing" | "confirming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);

  const loadPlan = useCallback(async () => {
    try {
      setPlan(await api.getPublicationPlan(sub.id));
      setPlanError(null);
    } catch (e) {
      setPlanError(loadMsg.current(e));
    }
  }, [sub.id]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan, sub.status]);

  async function sign() {
    if (!plan || !isSigning(plan.step) || local !== "idle") return;
    setError(null);
    try {
      setLocal("signing");
      await ensureSigner();
      let step: PublicationPlan["step"] = plan.step;
      // Normally one batch does everything; if the server still reports a signing step afterwards (the price changed in
      // between), the next batch follows. Bounded by the number of signing steps.
      for (let i = 0; i < CREATOR_SIGNING_STEPS.length && isSigning(step); i++) {
        const signed: CreatorSigningStep = step;
        setLocal("signing");
        const tx = await build(signed, sub.id);
        const h = await sendBuilt(tx);
        setHash(h);
        setLocal("confirming");
        await api.confirmPublication(sub.id, h, signed);
        const next = await api.getPublicationPlan(sub.id);
        setPlan(next);
        step = next.step;
      }
      toast({ tone: "ok", title: t("toast.title"), text: t("toast.text") });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLocal("idle");
      await onDone();
      await loadPlan();
    }
  }

  async function fund() {
    if (await faucet.receive()) await loadPlan();
  }

  if (planError) {
    return (
      <Notice tone="warn" title={t("planFailTitle")} role="status" actions={<Button size="sm" onClick={() => void loadPlan()}>{t("retry")}</Button>}>
        {planError}
      </Notice>
    );
  }
  if (!plan) return <div className="card pad small muted">{t("checking")}</div>;

  const step = plan.step;
  const phases = publishPhases(step, plan.isNewAgent, local === "confirming" ? "confirming" : "idle");
  const link = hash ? txLink(hash) : null;
  const progress = <Phases phases={phases} link={link} />;

  if (step === "blocked") {
    return (
      <div className="card pad col" style={gap(16)}>
        <Notice tone="bad" title={t("blockedTitle")} role="alert">
          {t("blockedText")}
        </Notice>
        {progress}
      </div>
    );
  }
  if (!isSigning(step) && local === "idle") {
    return (
      <div className="card pad col" style={gap(16)}>
        <div className="col" style={gap(6)}>
          <h2 className="h3">{step === "await-admin-approval" ? t("awaitTitle") : t("doneTitle")}</h2>
          <p className="muted">{step === "await-admin-approval" ? t("awaitText") : t("doneText")}</p>
        </div>
        {progress}
      </div>
    );
  }

  const signingStep: CreatorSigningStep = isSigning(step) ? step : "register-agent";
  const isRegister = signingStep === "register-agent";
  const register = plan.register;
  const needsDeposit = !!register && BigInt(register.stakeUnits) > 0n;
  const short = needsDeposit && BigInt(register.balanceUnits) < BigInt(register.stakeUnits);
  const busy = local !== "idle";

  return (
    <div className="card pad col" style={gap(16, { borderColor: "var(--amber)" })}>
      <div className="col" style={gap(4)}>
        <h2 className="h3">{isRegister ? t("title.register") : signingStep === "update-pricing" ? t("title.pricing") : t("title.version")}</h2>
        <p className="muted">{isRegister ? t("text.register") : signingStep === "update-pricing" ? t("text.pricing") : t("text.version")}</p>
      </div>
      <ul className="col small" style={gap(8)}>
        <Li>{t("li.oneSignature")}</Li>
        <Li>{t("li.fee")}</Li>
        <Li>
          {plan.approved
            ? t("li.approved", { name: plan.approved.name, version: plan.approved.version, price: money(plan.approved.priceUnits) })
            : t("li.approvedShort")}
        </Li>
        {needsDeposit ? <Li>{t("li.deposit", { stake: money(register.stakeUnits), balance: money(register.balanceUnits) })}</Li> : null}
        <Li>{isRegister ? t("li.afterRegister") : t("li.afterUpdate")}</Li>
      </ul>
      {short ? (
        <Notice
          tone="warn"
          title={t("lowTitle")}
          role="status"
          actions={
            register.faucetEnabled ? (
              <Button size="sm" loading={faucet.pending} onClick={() => void fund()}>
                {t("faucet")}
              </Button>
            ) : null
          }
        >
          {t("lowText", { stake: money(register.stakeUnits), balance: money(register.balanceUnits) })}
          {faucet.error ? ` ${faucet.error.text}` : ""}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="bad" role="alert" title={t("failTitle")}>
          {error}
        </Notice>
      ) : null}
      {progress}
      <div className="row wrapx" style={gap(12)}>
        <Button size="lg" loading={busy} disabled={short} onClick={() => void sign()}>
          {error ? t("retryBtn") : t(`button.${signingStep}`)}
        </Button>
        {busy ? (
          <span className="small muted" role="status" aria-live="polite">
            {local === "signing" ? t("signing") : t("confirming")}
          </span>
        ) : null}
      </div>
      <p className="tiny faint">{t("footnote")}</p>
    </div>
  );
}

const DOT: Record<PhaseState, string> = { done: "dot dot-ok", current: "dot dot-now", todo: "dot", skipped: "dot", blocked: "dot dot-bad" };

/** The four publication stages: sign, confirmed on the network, the platform's approval (new Solvers), live. */
function Phases({ phases, link }: { phases: ReturnType<typeof publishPhases>; link: string | null }) {
  const t = useTranslations("creator.cosign.phases");
  return (
    <ol className={s.timeline} aria-label={t("aria")}>
      {PUBLISH_PHASES.map((p, i) => {
        const state = phases[p];
        return (
          <li key={p} className={[s.tl, state === "done" ? s.tlDone : "", state === "skipped" ? s.tlSkipped : ""].filter(Boolean).join(" ")} aria-current={state === "current" ? "step" : undefined}>
            <span className={DOT[state]} aria-hidden>
              {state === "done" ? <Icon name="check" size="s" /> : state === "blocked" ? <Icon name="x" size="s" /> : i + 1}
            </span>
            <div className={s.tlBody}>
              <b>{t(`${p}.title`)}</b>
              <span className={s.srOnly}> ({t(`state.${state}`)})</span>
              <div className="small muted">{t(`${p}.text`)}</div>
              {p === "confirmed" && link && (state === "done" || state === "current") ? (
                <a className="link small" href={link} target="_blank" rel="noopener noreferrer">
                  {t("viewTx")} <Icon name="external" size="s" />
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Li({ children }: { children: ReactNode }) {
  return (
    <li className="row start" style={gap(10)}>
      <span className="ok">
        <Icon name="check-circle" size="s" />
      </span>
      <span className="grow">{children}</span>
    </li>
  );
}
