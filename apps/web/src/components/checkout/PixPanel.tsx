"use client";
// Pix charge for ONE purchase: QR (a fake one in simulated mode), copy-and-paste code, amount, expiry, and a check
// every 3 s until Solvers completes the purchase on the network (status `fulfilled`). The server status decides; the
// local clock only warns.
import { ApiError, sameAddress, type PixCharge } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { Notice } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { copyText } from "@/lib/format";
import { gap } from "@/lib/style";
import { brlValueText, parseUnits, tokenText, type TokenInfo } from "../catalog/money";
import { FakeQr } from "./FakeQr";
import { useCheckoutSession, useErrText, usePageLocale } from "./glue";
import { pixPhase } from "./rules";
import s from "./checkout.module.css";

const POLL_MS = 3000;
/** Paid for longer than this and the purchase is still being recorded: a calm message and slower checks. */
const SLOW_MS = 2 * 60_000;
const SLOW_POLL_MS = 15_000;

/** "m:ss" of a countdown (never negative). */
export function mmss(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

export function PixPanel({
  charge,
  ownerWallet,
  simulate,
  token,
  onUpdate,
  onDone,
  onRestart,
}: {
  charge: PixCharge;
  /** Wallet that owns the charge: only that session follows and simulates this Pix. */
  ownerWallet: string;
  /** PublicConfig.pix.simulate: shows the "simulate payment" button (never on mainnet). */
  simulate: boolean;
  token: TokenInfo;
  onUpdate: (c: PixCharge) => void;
  /** The purchase is complete on the network (status `fulfilled`). */
  onDone: (c: PixCharge) => void;
  onRestart: () => void;
}) {
  const session = useCheckoutSession();
  const t = useTranslations("checkout.pix");
  const { intl } = usePageLocale();
  const errText = useErrText();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [offline, setOffline] = useState(false);
  const failures = useRef(0);
  const cb = useRef({ onUpdate, onDone });
  cb.current = { onUpdate, onDone };
  const walletNow = useRef(session.wallet);
  walletNow.current = session.wallet;
  const doneOnce = useRef<string | null>(null);

  const phase = pixPhase(charge.status, new Date(charge.expiresAt).getTime(), now);
  const sessionOk = sameAddress(session.wallet, ownerWallet);
  const paid = phase === "paid";
  // Paid but the purchase takes long to be recorded: after ~2 min, a calm message and slower checks.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!paid) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [paid]);
  const polling = (phase === "waiting" || phase === "due" || paid || phase === "refund") && charge.status !== "refunded" && sessionOk && !gone;

  const finish = (c: PixCharge) => {
    if (doneOnce.current === c.id) return;
    doneOnce.current = c.id;
    cb.current.onDone(c);
  };

  useEffect(() => {
    if (charge.status === "fulfilled" && sessionOk) finish(charge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charge.status, charge.id, sessionOk]);

  // Checks the charge every 3 s until the purchase is complete (or the server says it expired or failed).
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    const check = async () => {
      try {
        const c = await api.getPixCharge(charge.id);
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
    if (phase === "due") void check(); // the deadline just passed: one immediate check before calling the Pix overdue
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

  // Only plain base64 goes into the data: URL of the QR.
  const qrPng = charge.qrCodeBase64 && /^[A-Za-z0-9+/=]+$/.test(charge.qrCodeBase64) ? charge.qrCodeBase64 : null;
  const units = parseUnits(charge.amountUnits);

  async function simulatePayment() {
    setSimulating(true);
    setError(null);
    try {
      const c = await api.simulatePixPayment(charge.id);
      if (!sameAddress(walletNow.current, ownerWallet)) return; // the account changed meanwhile: drop it
      onUpdate(c);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSimulating(false);
    }
  }

  async function copy() {
    if (charge.qrCode && (await copyText(charge.qrCode))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }

  const restart = (
    <Button variant="secondary" size="sm" icon="refresh" onClick={onRestart}>
      {t("restart")}
    </Button>
  );

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

  if (!sessionOk && (phase === "waiting" || phase === "due" || paid))
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
      <Notice tone="warn" role="alert" title={t("refund.title")} actions={charge.status === "refunded" ? restart : undefined}>
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
          <Button variant="secondary" size="sm" href="/library">
            {t("slow.leave")}
          </Button>
        }
      >
        {t("slow.text")}
      </Notice>
    );
  if (paid)
    return (
      <div className={s.status} role="status" aria-live="polite">
        <Spinner size="s" />
        <span className="small">
          <b>{t("recording.title")}</b>
          <span className="muted">{t("recording.text")}</span>
          {offline ? <span className="muted"> {t("offline")}</span> : null}
        </span>
      </div>
    );

  if (phase === "expired" || phase === "failed")
    return (
      <Notice tone="warn" title={phase === "failed" ? t("failed") : t("expired")} actions={restart}>
        {t("nothingCharged")}
      </Notice>
    );

  // The clock says the time is up, but the server has not expired the Pix yet: do not claim nothing was charged.
  if (phase === "due" || phase === "lapsed")
    return (
      <Notice tone="warn" title={t("due.title")} actions={restart}>
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
            <img src={`data:image/png;base64,${qrPng}`} alt={t("qrAlt")} />
          ) : (
            <>
              <FakeQr text={charge.qrCode ?? charge.id} />
              <span className={s.stamp} aria-hidden>
                {t("stamp")}
              </span>
            </>
          )}
        </div>
        <div className="col" style={gap(14)}>
          <div className="col" style={gap(2)}>
            <span className="muted small">{t("amountLabel")}</span>
            <span className="display num" style={{ fontSize: 40, lineHeight: 1.05 }}>
              {brlValueText(charge.amountBrl, intl)}
            </span>
            {units != null ? <span className="small muted num">{t("covers", { amount: tokenText(units, token, intl) })}</span> : null}
          </div>
          <div className={s.status} role="status" aria-live="polite">
            <Spinner size="s" />
            <span className="small">
              {t("waiting")}
              <span className="muted">{t("expiresIn", { time: mmss(left) })}</span>
              {offline ? <span className="muted"> · {t("offline")}</span> : null}
            </span>
          </div>
        </div>
      </div>

      {charge.qrCode ? (
        <div className="field">
          <label className="label" htmlFor="pix-copy-paste">
            {t("copyLabel")}
          </label>
          <div className="row m-col" style={gap(10)}>
            <input id="pix-copy-paste" className="input mono" readOnly value={charge.qrCode} style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" icon={copied ? "check" : "copy"} onClick={copy}>
              {copied ? t("copied") : t("copy")}
            </Button>
          </div>
        </div>
      ) : null}

      {charge.simulated ? (
        <p className="tiny faint">
          <Icon name="info" size="s" /> {t("simulatedNote")}
        </p>
      ) : (
        <p className="tiny faint">{t("realNote")}</p>
      )}

      {error ? (
        <Notice tone="bad" role="alert" title={t("simulateFailed")}>
          {error}
        </Notice>
      ) : null}

      <div className="row wrapx" style={gap(10)}>
        {simulate && charge.simulated ? (
          <Button variant="primary" icon="bolt" loading={simulating} onClick={simulatePayment}>
            {t("simulate")}
          </Button>
        ) : null}
        {charge.ticketUrl ? (
          <Button variant="ghost" href={charge.ticketUrl} iconRight="external">
            {t("openMp")}
          </Button>
        ) : null}
        <button type="button" className="link-btn small" onClick={onRestart}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
