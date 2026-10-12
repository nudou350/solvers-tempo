"use client";
// USDC-on-Solana (Solana Pay) charge for ONE purchase: amount, QR, "open in wallet" deep link and a check every 3 s
// until Solvers finds the payment on Solana and completes the purchase (status `fulfilled`). There is no address to
// copy on purpose: a plain transfer without the charge's reference key cannot be matched to the purchase. The server
// status decides; the local clock only warns.
import { ApiError, sameAddress, type SolanaPayCharge } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { Notice } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { gap } from "@/lib/style";
import { parseUnits, tokenText, type TokenInfo } from "../catalog/money";
import { useCheckoutSession, usePageLocale } from "./glue";
import { mmss } from "./PixPanel";
import { SOLANA_GRACE_MS, pixPhase, safeExplorerUrl, safeSolanaPayUrl, solanaTxUrl } from "./rules";
import s from "./checkout.module.css";

const POLL_MS = 3000;
/** Paid for longer than this and the purchase is still being recorded: a calm message and slower checks. */
const SLOW_MS = 2 * 60_000;
const SLOW_POLL_MS = 15_000;
/** Statuses after which the charge never changes again: stop checking. */
const FINAL = new Set(["fulfilled", "refunded", "expired", "failed"]);
const FAUCET_URL = "https://faucet.circle.com";

export function SolanaPayPanel({
  charge,
  ownerWallet,
  token,
  onUpdate,
  onDone,
  onRestart,
}: {
  charge: SolanaPayCharge;
  /** Wallet that owns the charge: only that session follows it. */
  ownerWallet: string;
  /** Payment token of the platform (its decimals; the Solana mint has the same 6 decimals). */
  token: TokenInfo;
  onUpdate: (c: SolanaPayCharge) => void;
  /** The purchase is complete (status `fulfilled`). */
  onDone: (c: SolanaPayCharge) => void;
  onRestart: () => void;
}) {
  const session = useCheckoutSession();
  const t = useTranslations("checkout.solana");
  const { intl } = usePageLocale();
  const [now, setNow] = useState(() => Date.now());
  const [gone, setGone] = useState(false);
  const [offline, setOffline] = useState(false);
  const failures = useRef(0);
  const cb = useRef({ onUpdate, onDone });
  cb.current = { onUpdate, onDone };
  const doneOnce = useRef<string | null>(null);

  const phase = pixPhase(charge.status, new Date(charge.expiresAt).getTime(), now, SOLANA_GRACE_MS);
  const sessionOk = sameAddress(session.wallet, ownerWallet);
  const paid = phase === "paid";
  const devnet = charge.cluster === "devnet";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!paid) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [paid]);
  // Every non-final status is checked (also past the deadline: the server turns it into `expired` or finds a late payment).
  const polling = !FINAL.has(charge.status) && sessionOk && !gone;

  useEffect(() => {
    if (charge.status !== "fulfilled" || !sessionOk || doneOnce.current === charge.id) return;
    doneOnce.current = charge.id;
    cb.current.onDone(charge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charge.status, charge.id, sessionOk]);

  // Checks the charge every 3 s until it reaches a final status; stops on unmount.
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    const check = async () => {
      try {
        const c = await api.getSolanaPayCharge(charge.id);
        if (!alive) return;
        failures.current = 0;
        setOffline(false);
        cb.current.onUpdate(c);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setGone(true);
        // 401: the session renews itself; sessionOk turns false and the panel asks to sign in again.
        else if (!(e instanceof ApiError && e.status === 401) && ++failures.current >= 3) setOffline(true);
      }
    };
    const timer = setInterval(check, slow ? SLOW_POLL_MS : POLL_MS);
    if (phase === "due") void check(); // the deadline just passed: check once right away
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [charge.id, polling, phase, slow]);

  useEffect(() => {
    if (phase !== "waiting" && phase !== "due") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Only plain base64 goes into the data: URL of the QR; only a solana: transfer request becomes the wallet link.
  const qrPng = charge.qrCodeBase64 && /^[A-Za-z0-9+/=]+$/.test(charge.qrCodeBase64) ? charge.qrCodeBase64 : null;
  const payUrl = safeSolanaPayUrl(charge.url);
  const units = parseUnits(charge.amountUnits);
  const amountText = units != null ? tokenText(units, { symbol: charge.tokenSymbol, decimals: token.decimals }, intl) : `${charge.amount} ${charge.tokenSymbol}`;
  const paymentLink = safeExplorerUrl(charge.solanaExplorerUrl) ?? solanaTxUrl(charge.solanaSignature, charge.cluster);
  const refundLink = solanaTxUrl(charge.refundSignature, charge.cluster);

  const restart = (
    <Button variant="secondary" size="sm" icon="refresh" onClick={onRestart}>
      {t("restart")}
    </Button>
  );
  const explorer = (href: string | null, label: string): ReactNode =>
    href ? (
      <a className="link-btn small" href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <Icon name="external" size="s" />
      </a>
    ) : null;

  if (phase === "done")
    return (
      <div className={s.status} role="status" aria-live="polite">
        <Spinner size="s" />
        <span className="small">
          <b>{t("done.title")}</b> <span className="muted">{t("done.text")}</span>
        </span>
      </div>
    );

  if (gone)
    return (
      <Notice tone="warn" role="alert" title={t("gone.title")} actions={restart}>
        {t("gone.text")}
      </Notice>
    );

  if (!sessionOk && !FINAL.has(charge.status))
    return (
      <Notice
        tone="warn"
        role="alert"
        title={t("sessionEnded.title")}
        actions={
          <>
            <Button size="sm" loading={session.signingIn} onClick={() => void session.signIn().catch(() => {})}>
              {t("sessionEnded.login")}
            </Button>
            {restart}
          </>
        }
      >
        {t("sessionEnded.text")}
      </Notice>
    );

  if (phase === "refund")
    return (
      <Notice
        tone="warn"
        role="alert"
        title={t("refund.title")}
        actions={
          charge.status === "refunded" ? (
            <>
              {restart}
              {explorer(refundLink, t("refund.viewRefund"))}
            </>
          ) : undefined
        }
      >
        {charge.status === "refunded" ? t("refund.refunded") : t("refund.refunding")}
      </Notice>
    );

  // Paid: it does not go away because of the clock; it only ends when the purchase is recorded.
  if (paid && slow)
    return (
      <Notice
        tone="info"
        title={t("slow.title")}
        actions={
          <>
            <Button variant="secondary" size="sm" href="/library">
              {t("slow.leave")}
            </Button>
            {explorer(paymentLink, t("viewSolana"))}
          </>
        }
      >
        {t("slow.text")}
      </Notice>
    );
  if (paid)
    return (
      <div className="col" style={gap(10)}>
        <div className={s.status} role="status" aria-live="polite">
          <Spinner size="s" />
          <span className="small">
            {charge.status === "confirmed" ? (
              <>
                <b>{t("seen.title")}</b>
                <span className="muted">{t("seen.text")}</span>
              </>
            ) : (
              <>
                <b>{t("recording.title")}</b>
                <span className="muted">{t("recording.text")}</span>
              </>
            )}
            {offline ? <span className="muted"> {t("offline")}</span> : null}
          </span>
        </div>
        {explorer(paymentLink, t("viewSolana"))}
      </div>
    );

  if (phase === "expired")
    return (
      <Notice tone="warn" role="alert" title={t("expired.title")} actions={restart}>
        {t("expired.text")}
      </Notice>
    );
  if (phase === "failed")
    return (
      <Notice
        tone="bad"
        role="alert"
        title={t("failed.title")}
        actions={
          <>
            {restart}
            {explorer(paymentLink, t("viewSolana"))}
          </>
        }
      >
        {t("failed.text")}
      </Notice>
    );

  // The clock says the time is up, but the server still looks for a late payment: do not claim nothing was paid.
  if (phase === "due" || phase === "lapsed")
    return (
      <Notice tone="warn" role="status" title={t("due.title")} actions={restart}>
        {t("due.text")}
        {offline ? ` ${t("offline")}` : ""}
      </Notice>
    );

  const left = new Date(charge.expiresAt).getTime() - now;

  return (
    <div className="col" style={gap(16)}>
      <div className={s.pix}>
        <div className={s.qrBox}>
          {qrPng ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`data:image/png;base64,${qrPng}`} alt={t("qrAlt", { amount: amountText })} />
          ) : (
            <Spinner />
          )}
        </div>
        <div className="col" style={gap(14)}>
          <div className="col" style={gap(2)}>
            <span className="muted small">{t("amountLabel")}</span>
            <span className="display num" style={{ fontSize: 40, lineHeight: 1.05 }}>
              {amountText}
            </span>
            <span className="small muted">{devnet ? t("networkTest") : t("networkMain")}</span>
          </div>
          <div className={s.status} role="status" aria-live="polite">
            <Spinner size="s" />
            <span className="small">
              {t("waiting")}
              <span className="muted">{t("expiresIn", { time: mmss(left) })}</span>
              {offline ? <span className="muted"> · {t("offline")}</span> : null}
            </span>
          </div>
          {payUrl ? (
            <div>
              <a className={buttonClass({ variant: "primary" })} href={payUrl}>
                <Icon name="wallet" size="s" />
                {t("openWallet")}
              </a>
            </div>
          ) : null}
        </div>
      </div>

      <p className="small muted">{t("howTo")}</p>
      <p className="tiny faint">
        <Icon name="info" size="s" /> {t("onlyThis")}
      </p>
      {devnet ? (
        <p className="tiny faint">
          {t.rich("devnetHint", {
            link: (c) => (
              <a href={FAUCET_URL} target="_blank" rel="noopener noreferrer">
                {c}
              </a>
            ),
          })}
        </p>
      ) : null}

      <div className="row wrapx" style={gap(10)}>
        <button type="button" className="link-btn small" onClick={onRestart}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
