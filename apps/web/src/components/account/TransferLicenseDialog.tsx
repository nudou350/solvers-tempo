"use client";
// Sends a license to another wallet. The owner pays the transfer royalty (creator and platform shares of the original
// price, decisions.md D15), quoted by the server from the contract. One batched transaction: token approval +
// `transferWithRoyalty(to, tokenId, maxRoyalty)`, with `maxRoyalty` = the quote the owner accepted.
import { ApiError } from "@solvers/api-client";
import { RoyaltyQuote, type Agent, type License, type TokenBalance } from "@solvers/shared";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Loading } from "@/components/ui/Spinner";
import { Notice } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { gap } from "@/lib/style";
import { txUrl } from "@/lib/explorer";
import { checkRecipient, hasEnough, royaltyDisclosure, type RecipientProblem } from "./account-rules";
import { useAccountConfig, useAccountTx, useBlockedRecipients, useIntlLocale, useMoney, useOwnerAddress } from "./account-tx";

type Step = "form" | "confirm" | "done";

const PROBLEM_KEY: Record<RecipientProblem, string> = {
  empty: "recipientEmpty",
  format: "recipientFormat",
  checksum: "recipientChecksum",
  zero: "recipientZero",
  self: "recipientSelf",
  contract: "recipientContract",
};

export function TransferLicenseDialog({
  license,
  agent,
  onClose,
  onTransferred,
}: {
  license: License;
  agent: Agent | undefined;
  onClose: () => void;
  /** The license left the wallet: the library reloads it (and the balance). */
  onTransferred: () => void;
}) {
  const t = useTranslations("account.transfer");
  const config = useAccountConfig();
  const locale = useIntlLocale();
  const money = useMoney();
  const owner = useOwnerAddress();
  const blocked = useBlockedRecipients();
  const tx = useAccountTx();
  const inputId = useId();
  const hintId = useId();
  const [quote, setQuote] = useState<RoyaltyQuote | null | "error">(null);
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [quoteChanged, setQuoteChanged] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const name = agent?.name ?? t("thisSolver");

  const loadQuote = () => {
    setQuote(null);
    api.getTransferQuote(license.id).then(setQuote, () => setQuote("error"));
  };
  useEffect(() => {
    loadQuote();
    api.getBalance().then(setBalance, () => setBalance(null));
  }, [license.id]);

  const check = checkRecipient(input, { owner, blocked });
  const symbol = config?.paymentToken.symbol ?? "";
  const d = quote && quote !== "error" ? royaltyDisclosure(quote, symbol, locale) : null;
  const free = d ? d.totalUnits === 0n : false;
  // Unknown balance (still loading or unreadable): let it through, the server checks the balance before building.
  const enough = d ? free || balance === null || hasEnough(balance.units, d.totalUnits) : false;
  const canContinue = check.ok && !!d && enough;

  const send = async () => {
    if (!check.ok || !d || quote === null || quote === "error") return;
    setQuoteChanged(false);
    const r = await tx.run(() => api.buildTransfer(license.id, check.address, d.totalUnits));
    if (r) {
      setHash(r.hash);
      setStep("done");
    }
  };

  // The library reloads only when the dialog closes: reloading earlier would unmount it before the person reads the result.
  const close = () => {
    if (step === "done") onTransferred();
    onClose();
  };

  // The royalty went up between the quote and the transaction: show the new amount and ask again.
  useEffect(() => {
    const e = tx.raw;
    if (!(e instanceof ApiError) || e.code !== "royalty_changed") return;
    const fresh = RoyaltyQuote.safeParse(e.body.quote);
    if (fresh.success) setQuote(fresh.data);
    else loadQuote();
    setQuoteChanged(true);
    tx.reset();
  }, [tx.raw]);

  const disclosure = d ? (
    <div className="card-flat pad-s col" style={gap(8, { background: "var(--surface-2)" })}>
      <b>{t("royaltyTitle")}</b>
      {free ? (
        <span className="small">{t("royaltyNone")}</span>
      ) : (
        <>
          <span className="small">
            {t("royaltyText", { pct: d.totalPct, original: d.original, creatorPct: d.creatorPct, platformPct: d.platformPct })}
          </span>
          <dl className="tech" style={{ width: "100%" }}>
            <dt>{t("toCreator", { pct: d.creatorPct })}</dt>
            <dd className="num">{d.creator}</dd>
            <dt>{t("toPlatform", { pct: d.platformPct })}</dt>
            <dd className="num">{d.platform}</dd>
            <dt>
              <b>{t("youPay")}</b>
            </dt>
            <dd className="num">
              <b>{d.total}</b>
            </dd>
          </dl>
        </>
      )}
      {balance ? <span className="tiny faint">{t("yourBalance", { amount: money(balance.units) })}</span> : null}
      {!enough && balance ? (
        <span className="small warn" role="status">
          {t("notEnough", { amount: d.total })}
        </span>
      ) : null}
    </div>
  ) : quote === "error" ? (
    <Notice
      tone="bad"
      role="alert"
      title={t("quoteFailed")}
      actions={
        <Button size="sm" variant="secondary" icon="refresh" onClick={loadQuote}>
          {t("retry")}
        </Button>
      }
    />
  ) : (
    <Loading text={t("quoteLoading")} />
  );

  return (
    <Dialog title={step === "done" ? t("doneTitle") : t("title", { name })} onClose={close} locked={tx.pending} width={560}>
      {step === "form" ? (
        <form
          className="col"
          style={gap(16)}
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (canContinue) setStep("confirm");
          }}
        >
          <p className="small muted">{t("intro", { name })}</p>
          <ul className="small col" style={gap(6, { margin: 0, paddingLeft: 18 })}>
            <li>{t("pointOwner")}</li>
            <li>{t("pointAccess")}</li>
            <li>{t("pointCap")}</li>
          </ul>
          <div className="field">
            <label className="label" htmlFor={inputId}>
              {t("recipientLabel")}
            </label>
            <input
              id={inputId}
              className="input mono"
              data-autofocus
              value={input}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={touched && !check.ok}
              aria-describedby={hintId}
              onChange={(e) => setInput(e.target.value)}
              onBlur={() => setTouched(true)}
            />
            <span id={hintId} className={`hint${touched && !check.ok ? " bad" : ""}`} aria-live="polite">
              {check.ok ? (
                <>
                  {t("recipientOk")} <span className="mono" style={{ overflowWrap: "anywhere" }}>{check.address}</span>
                </>
              ) : touched ? (
                t(PROBLEM_KEY[check.reason])
              ) : (
                t("recipientHint")
              )}
            </span>
          </div>
          {disclosure}
          <div className="row wrapx" style={gap(10)}>
            <Button type="submit" variant="primary" disabled={!d || (touched && !canContinue)}>
              {t("continue")}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : step === "confirm" && check.ok && d ? (
        <div className="col" style={gap(16)}>
          {quoteChanged ? (
            <Notice tone="warn" role="alert" title={t("quoteChangedTitle")}>
              {t("quoteChangedText")}
            </Notice>
          ) : null}
          <p>{t("confirmText", { name })}</p>
          <div className="card-flat pad-s col" style={gap(4, { background: "var(--surface-2)" })}>
            <span className="small muted">{t("recipientLabel")}</span>
            <b className="mono" style={{ overflowWrap: "anywhere" }}>
              {check.address}
            </b>
          </div>
          <div className="row between wrapx" style={gap(12)}>
            <span>{t("youPay")}</span>
            <b className="num">{free ? t("nothing") : d.total}</b>
          </div>
          {!free ? <span className="small muted">{t("confirmSplit", { creator: d.creator, platform: d.platform })}</span> : null}
          <span className="small muted">{t("confirmFinal")}</span>
          {!enough && balance ? (
            <span className="small warn" role="status">
              {t("notEnough", { amount: d.total })}
            </span>
          ) : null}
          {tx.error ? (
            <Notice tone="bad" role="alert" title={t("failedTitle")}>
              {tx.error}
            </Notice>
          ) : null}
          <div className="row wrapx" style={gap(10)}>
            <Button variant="primary" icon="arrow-up-right" loading={tx.pending} disabled={!enough} onClick={() => void send()}>
              {t("send")}
            </Button>
            <Button
              variant="ghost"
              disabled={tx.pending}
              onClick={() => {
                tx.reset();
                setStep("form");
              }}
            >
              {t("back")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="col" style={gap(14)}>
          <p>{t("doneText", { name })}</p>
          {hash && txUrl(hash, config) ? (
            <a className="link small row" style={gap(6)} href={txUrl(hash, config) ?? undefined} target="_blank" rel="noopener noreferrer">
              {t("viewTx")} <Icon name="external" size="s" />
            </a>
          ) : null}
          <div>
            <Button variant="primary" onClick={close}>
              {t("close")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
