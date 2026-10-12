"use client";
// Checkout of a permanent license or a task with a guarantee (escrow with milestones).
// Sign in -> (guarantee: describe the task) -> payment method (wallet balance, Pix or USDC on Solana) -> review and pay.
//  - wallet: POST /api/purchases/intent returns the `[approve, purchase]` batch; the wallet sends it (network fee paid
//    by Solvers) and the done page re-checks the charge. The buyer pays exactly the price shown.
//  - Pix: POST /api/pix/charges creates a charge for this one purchase; once the Pix is paid, Solvers completes the
//    purchase and the license (or the guarantee) lands in the buyer's wallet.
//  - USDC on Solana: POST /api/solana-pay/charges creates a Solana Pay request (QR + wallet link) for this one purchase;
//    once the payment is found on Solana, Solvers completes the purchase the same way as for Pix.
import { ApiError, checksumAddress, type AgentDetail, type GuaranteeStatus, type PixCharge, type PublicConfig, type PurchaseIntentInput, type SolanaPayCharge } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Icon } from "@/components/ui/Icon";
import { Tile } from "@/components/ui/Tile";
import { Notice, useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { short, useFormat } from "@/lib/format";
import { gap } from "@/lib/style";
import { brlText, brlValueText, parseUnits, priceUnits, tokenText, usdText } from "../catalog/money";
import { useCheckoutSession, useErrInfo, useErrText, usePageLocale, useSendCalls } from "./glue";
import { PixPanel } from "./PixPanel";
import { SolanaPayPanel } from "./SolanaPayPanel";
import {
  DELIVERY_OPTIONS,
  TASK_LIMITS,
  defaultMethod,
  doneHref,
  guardOfError,
  purchaseGuard,
  taskValid,
  unconfirmedDoneHref,
  walletCovers,
  type CheckoutKind,
  type GuardCode,
  type PayMethod,
} from "./rules";
import s from "./checkout.module.css";

function StepDot({ n, done }: { n: number; done?: boolean }) {
  return <span className={`dot ${done ? "dot-ok" : "dot-now"}`}>{done ? "✓" : n}</span>;
}

type ErrorInfo = { title: string; text: string; action: "retry" | "login" | "faucet" | null };

/** Contract reverts (decoded by name) that mean the same as an API guard. */
const CONTRACT_GUARDS: Record<string, GuardCode> = {
  "contract:SoldOut": "sold_out",
  "contract:SelfPurchase": "creator",
  "contract:Paused": "paused",
  "contract:PriceTooLow": "below_min",
  "contract:AgentNotActive": "unavailable",
};

export function CheckoutView({ detail, config, kind }: { detail: AgentDetail; config: PublicConfig; kind: CheckoutKind }) {
  const router = useRouter();
  const toast = useToast();
  const t = useTranslations("checkout.view");
  const f = useFormat();
  const { locale, intl } = usePageLocale();
  const session = useCheckoutSession();
  const sendCalls = useSendCalls();
  const errText = useErrText();
  const errInfo = useErrInfo();
  // The price can move while the buyer is here (409 price_changed): keep the re-read Solver.
  const [fresh, setFresh] = useState<AgentDetail | null>(null);
  const cur = fresh ?? detail;
  const { agent, creator, guarantee } = cur;
  const token = config.paymentToken;
  const dec = token.decimals;
  const rate = config.brlPerUsd;
  const isG = kind === "guarantee";

  // ----- amounts (token base units) -----
  const [priceOverride, setPriceOverride] = useState<bigint | null>(null);
  const listedUnits = priceUnits(isG ? (guarantee?.priceUsdc ?? agent.priceUsdc) : agent.priceUsdc, dec);
  const totalUnits = priceOverride ?? listedUnits;
  const listedBrl = priceOverride == null ? (isG ? (guarantee?.priceBrl ?? null) : cur.priceBrl) : null;
  /** pt: reais (server value when it exists, else the rate); en: dollars 1:1 with the stablecoin. */
  const local = (u: bigint) => (locale === "en" ? usdText(u, dec, intl) : brlText(u, dec, rate, intl));
  const tokenAmt = (u: bigint) => tokenText(u, token, intl);
  /** Numeric amounts of older API fields (guarantee limits, milestones), formatted without arithmetic on money. */
  const tokenNum = (n: number) => {
    const u = priceUnits(n, dec);
    return u == null ? "—" : tokenAmt(u);
  };
  const localNum = (n: number) => {
    const u = priceUnits(n, dec);
    return u == null ? "—" : local(u);
  };
  const totalText = totalUnits == null ? "—" : locale === "pt" && listedBrl != null ? brlValueText(listedBrl, intl) : local(totalUnits);

  // ----- account data -----
  const [balance, setBalance] = useState<bigint | null>(null);
  const [limits, setLimits] = useState<GuaranteeStatus | null>(null);
  const [limitsFailed, setLimitsFailed] = useState(false);
  const [owned, setOwned] = useState(false);
  // Each load has a number: late answers (e.g. from before "switch account") are dropped.
  const loadSeq = useRef(0);
  const me = session.wallet;
  const loadAccount = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!me) return;
    const [b, g, acc] = await Promise.allSettled([api.getBalance(), isG ? api.getMyGuarantee() : Promise.resolve(null), api.getMyAccess(agent.slug)]);
    if (seq !== loadSeq.current) return;
    if (b.status === "fulfilled") setBalance(parseUnits(b.value.units));
    if (g.status === "fulfilled") setLimits(g.value);
    setLimitsFailed(isG && g.status === "rejected");
    if (acc.status === "fulfilled") setOwned(!!acc.value.license);
  }, [me, isG, agent.slug]);

  // ----- guards -----
  const [errGuard, setErrGuard] = useState<GuardCode | null>(null);

  useEffect(() => {
    setBalance(null);
    setLimits(null);
    setLimitsFailed(false);
    setOwned(false);
    // A guard the server reported (e.g. "creator") belonged to the previous account.
    setErrGuard(null);
    void loadAccount();
  }, [loadAccount]);
  const minUnits = parseUnits(config.minPriceUnits);
  const guard =
    errGuard ??
    purchaseGuard({ kind, owned, sessionWallet: me, creatorWallet: cur.onchain.creatorWallet, supply: agent.supply, totalUnits, minPriceUnits: minUnits });

  // ----- payment method -----
  const pixOn = config.pix.enabled;
  // `?.`: a cached config from before Solana Pay existed has no `solanaPay`.
  const solanaOn = config.solanaPay?.enabled === true;
  const [method, setMethod] = useState<PayMethod | null>(null);
  const covers = walletCovers(balance, totalUnits);
  const effMethod: PayMethod = method ?? defaultMethod({ pixEnabled: pixOn, balanceUnits: balance, totalUnits });

  // ----- task (guarantee) -----
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [deliveryDays, setDeliveryDays] = useState<number>(14);
  const [touched, setTouched] = useState(false);
  const { titleOk, descOk } = taskValid(title, desc);
  const availUnits = limits ? priceUnits(Math.max(0, limits.availableUsdc), dec) : null;
  const singleMaxUnits = limits ? priceUnits(limits.singleMilestoneMaxUsdc, dec) : null;
  const overLimit = isG && totalUnits != null && availUnits != null && availUnits < totalUnits;
  // Same rule as the server: at the limited level, guarantees above singleMilestoneMaxUsdc need 2 milestones or more.
  const singleTooBig =
    isG && limits != null && limits.level === "limited" && (guarantee?.milestones.length ?? 0) < 2 && totalUnits != null && singleMaxUnits != null && totalUnits > singleMaxUnits;
  // A guarantee is paid (Pix included) only after the limit is checked, so Pix never charges a guarantee that would fail.
  const limitsOk = !isG || (limits != null && !overLimit && !singleTooBig);

  const [agree, setAgree] = useState(false);
  const [pending, setPending] = useState(false);
  // Charge whose payment the wallet already broadcast: Pay stays off for good (a second click would pay twice).
  const [sentCharge, setSentCharge] = useState<string | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [priceChange, setPriceChange] = useState<{ from: bigint; to: bigint } | null>(null);

  // ----- Pix -----
  const [charge, setCharge] = useState<PixCharge | null>(null);
  // ----- USDC on Solana (same ownership rule as the Pix charge) -----
  const [solCharge, setSolCharge] = useState<SolanaPayCharge | null>(null);
  // Wallet that created the charge: the Pix only counts for it; switching accounts closes the QR.
  const [chargeWallet, setChargeWallet] = useState<string | null>(null);
  const meRef = useRef(me);
  meRef.current = me;

  // Another account signed in: the open QR belonged to the previous one. Close it so nobody pays for the wrong wallet.
  useEffect(() => {
    if ((!charge && !solCharge) || !chargeWallet || !me || me.toLowerCase() === chargeWallet.toLowerCase()) return;
    setCharge(null);
    setSolCharge(null);
    setChargeWallet(null);
    toast({ tone: "info", title: t("toast.chargeClosed.title"), text: t("toast.chargeClosed.text") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, chargeWallet, charge, solCharge]);

  /** Re-reads the Solver (new price, sold out...). */
  const refreshAgent = useCallback(() => {
    api.getAgent(detail.agent.slug, locale).then(
      (d) => setFresh(d),
      () => {},
    );
  }, [detail.agent.slug, locale]);

  /** Turns an error into a guard, a price change or a message. */
  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      const g = guardOfError(e.code);
      if (g) {
        setErrGuard(g);
        if (g === "sold_out") refreshAgent();
        if (g === "owned") void loadAccount();
        return;
      }
      if (e.code === "price_changed") {
        const now = parseUnits(typeof e.body.priceUnits === "string" ? e.body.priceUnits : null);
        if (now != null && totalUnits != null) setPriceChange({ from: totalUnits, to: now });
        if (now != null) setPriceOverride(now);
        setAgree(false);
        refreshAgent();
        return;
      }
      if (e.status === 401) {
        setError({ title: t("errors.sessionTitle"), text: t("errors.sessionText"), action: "login" });
        return;
      }
    }
    const info = errInfo(e);
    const g = CONTRACT_GUARDS[info.code];
    if (g) {
      setErrGuard(g);
      if (g === "sold_out") refreshAgent();
      return;
    }
    if (info.code === "contract:PriceChanged") {
      // The on-chain price moved between the intent and the transaction: re-read it and ask for a new confirmation.
      setAgree(false);
      refreshAgent();
    }
    setError({ title: info.title || t("errors.payTitle"), text: info.text || errText(e), action: info.action });
  }

  const input = (): PurchaseIntentInput | null => {
    if (totalUnits == null) return null;
    if (isG) return { kind: "escrow", agentId: agent.id, task: { title: title.trim(), description: desc.trim(), deliveryDays } };
    return { kind: "license", agentId: agent.id, expectedPriceUnits: totalUnits.toString() };
  };

  async function payWithWallet() {
    const body = input();
    if (!body || totalUnits == null) return;
    setPending(true);
    setError(null);
    setPriceChange(null);
    let sentFor: { chargeId: string; kind: "escrow" | "license" } | null = null;
    try {
      const intent = await api.createPurchaseIntent(body);
      const amount = BigInt(intent.amountUnits);
      // The buyer pays exactly what the screen shows: any other amount stops here and asks for a new confirmation.
      if (amount !== totalUnits) {
        setPriceChange({ from: totalUnits, to: amount });
        setPriceOverride(amount);
        setAgree(false);
        return;
      }
      sentFor = { chargeId: intent.chargeId, kind: intent.kind === "escrow" ? "escrow" : "license" };
      const hash = await sendCalls(intent);
      setSentCharge(intent.chargeId);
      router.push(doneHref({ slug: agent.slug, kind: sentFor.kind, chargeId: intent.chargeId, txHash: hash }));
    } catch (e) {
      // Sent, but not confirmed in time: it may still land. Follow the charge on the done page; never offer to pay again.
      const done = sentFor ? unconfirmedDoneHref(e, { slug: agent.slug, ...sentFor }) : null;
      if (done && sentFor) {
        setSentCharge(sentFor.chargeId);
        router.push(done);
        return;
      }
      handleError(e);
      void loadAccount();
    } finally {
      setPending(false);
    }
  }

  async function payWithPix() {
    const body = input();
    if (!body || !me) return;
    const startedBy = me;
    setPending(true);
    setError(null);
    setPriceChange(null);
    try {
      const c = await api.createPixCharge(body);
      // The account changed while the charge was being created: never show another wallet's QR.
      if (!meRef.current || meRef.current.toLowerCase() !== startedBy.toLowerCase()) return;
      setChargeWallet(startedBy);
      setCharge(c);
    } catch (e) {
      handleError(e);
    } finally {
      setPending(false);
    }
  }

  async function payWithSolana() {
    const body = input();
    if (!body || !me) return;
    const startedBy = me;
    setPending(true);
    setError(null);
    setPriceChange(null);
    try {
      const c = await api.createSolanaPayCharge(body);
      // The account changed while the charge was being created: never show another wallet's QR.
      if (!meRef.current || meRef.current.toLowerCase() !== startedBy.toLowerCase()) return;
      setChargeWallet(startedBy);
      setSolCharge(c);
    } catch (e) {
      handleError(e);
    } finally {
      setPending(false);
    }
  }

  // Pix and USDC on Solana both end on the done page, which re-reads the charge (any provider).
  const onChargeDone = useCallback(
    (c: PixCharge | SolanaPayCharge) => {
      router.push(doneHref({ slug: agent.slug, kind: c.kind === "escrow" ? "escrow" : "license", chargeId: c.id, txHash: c.txHash }));
    },
    [router, agent.slug],
  );

  // ----- test funds (testnet only) -----
  const [faucetPending, setFaucetPending] = useState(false);
  async function getTestFunds() {
    setFaucetPending(true);
    try {
      const r = await api.faucet();
      const got = parseUnits(r.amountUnits);
      toast({ tone: "ok", title: got != null ? t("toast.faucetGot", { amount: tokenAmt(got) }) : t("toast.faucetGotAny") });
      await loadAccount();
    } catch (e) {
      toast({ tone: "bad", title: t("toast.faucetFailed"), text: errText(e) });
    } finally {
      setFaucetPending(false);
    }
  }

  const logged = session.status === "signed-in" && !!me;
  const busy = pending || session.signingIn;
  const showCharge = !!charge || !!solCharge;
  const methodReady = effMethod === "pix" ? pixOn : effMethod === "solana" ? solanaOn : balance == null || covers;
  const canPay = logged && agree && guard == null && totalUnits != null && limitsOk && (!isG || (titleOk && descOk)) && !busy && !showCharge && !sentCharge && methodReady;

  function pay() {
    setTouched(true);
    if (!canPay) return;
    if (effMethod === "pix") void payWithPix();
    else if (effMethod === "solana") void payWithSolana();
    else void payWithWallet();
  }

  const doLogin = () => session.signIn().catch((e: unknown) => toast({ tone: "bad", title: t("login.failed"), text: errText(e) }));
  const doSwitch = () => session.signOut().catch(() => {});
  const switchKind = (next: CheckoutKind) => router.replace(`/checkout?agent=${encodeURIComponent(agent.slug)}&type=${next}`, { scroll: false });

  const modes: { id: CheckoutKind; label: string }[] = [
    { id: "license", label: t("summary.license") },
    ...(guarantee ? [{ id: "guarantee" as const, label: t("summary.withGuarantee") }] : []),
  ];

  const reviewWin = guarantee ? f.durationText(guarantee.reviewWindowSecs) : "";
  const lineLabel = isG ? t("summary.guaranteeTask") : t("summary.permanent");
  const agreeText = isG ? t("review.agreeGuarantee", { window: reviewWin }) : t("review.agreeNew");

  let n = 1;
  const stepLogin = n++;
  const stepTask = isG ? n++ : 0;
  const stepPay = n++;
  const stepReview = n++;
  const restartCharge = () => {
    setCharge(null);
    setSolCharge(null);
    setChargeWallet(null);
  };

  // Payment options. In Portuguese Pix comes first; in English the wallet balance comes first.
  const pixOption = pixOn ? (
    <button
      type="button"
      key="pix"
      className={`opt ${effMethod === "pix" ? "on" : ""}`}
      onClick={() => setMethod("pix")}
      aria-pressed={effMethod === "pix"}
      disabled={busy || showCharge}
    >
      <span className="dot-r" />
      <span className="col grow" style={gap(2)}>
        <span className="row wrapx" style={gap(8)}>
          <b>{t("pay.pixName")}</b>
          {config.pix.simulate ? <Chip tone="warn">{t("pay.test")}</Chip> : null}
        </span>
        <span className="small muted">{t("pay.pixText")}</span>
      </span>
    </button>
  ) : locale === "pt" ? (
    <div className="opt" key="pix" aria-disabled style={{ opacity: 0.6 }}>
      <span className="dot-r" />
      <span className="col" style={gap(2)}>
        <b>{t("pay.pixSoonName")}</b>
        <span className="small muted">{t("pay.pixSoonText")}</span>
      </span>
    </div>
  ) : null;
  const walletOption = (
    <button
      type="button"
      key="wallet"
      className={`opt ${effMethod === "wallet" ? "on" : ""}`}
      onClick={() => setMethod("wallet")}
      aria-pressed={effMethod === "wallet"}
      disabled={busy || showCharge}
    >
      <span className="dot-r" />
      <span className="col grow" style={gap(2)}>
        <b>{t("pay.walletName", { symbol: token.symbol })}</b>
        <span className="small muted">{t("pay.walletText")}</span>
        {logged && balance != null ? (
          <span className="small num" style={{ marginTop: 4 }}>
            {t("pay.balance")}
            <b>{tokenAmt(balance)}</b>
          </span>
        ) : null}
      </span>
    </button>
  );
  const solanaOption = solanaOn ? (
    <button
      type="button"
      key="solana"
      className={`opt ${effMethod === "solana" ? "on" : ""}`}
      onClick={() => setMethod("solana")}
      aria-pressed={effMethod === "solana"}
      disabled={busy || showCharge}
    >
      <span className="dot-r" />
      <span className="col grow" style={gap(2)}>
        <span className="row wrapx" style={gap(8)}>
          <b>{t("pay.solanaName")}</b>
          {config.solanaPay.cluster === "devnet" ? <Chip tone="warn">{t("pay.testNetwork")}</Chip> : null}
        </span>
        <span className="small muted">{t("pay.solanaText")}</span>
      </span>
    </button>
  ) : null;
  // USDC on Solana always comes right after the wallet balance.
  const payOptions = locale === "en" ? [walletOption, solanaOption, pixOption] : [pixOption, walletOption, solanaOption];

  return (
    <>
      <div className="wrap" style={{ paddingTop: 28 }}>
        <Link className="link-btn" href={`/solvers/${encodeURIComponent(agent.slug)}`}>
          <Icon name="arrow-left" size="s" />
          {t("back")}
        </Link>
      </div>
      <section className="wrap" style={{ paddingTop: 8, paddingBottom: 56 }}>
        <h1 className="display h2" style={{ marginBottom: 28 }}>
          {t("title")}
        </h1>
        <div className="split">
          <div className="col" style={gap(22)}>
            {/* 1. Sign in */}
            <div className="card pad col" style={gap(18)}>
              <div className="row" style={gap(14)}>
                <StepDot n={stepLogin} done={logged} />
                <h2 className="h3">{t("login.title")}</h2>
              </div>
              {session.status === "loading" ? (
                <div className="skel-box" style={{ height: 72 }} aria-hidden />
              ) : logged && me ? (
                <div className="row wrapx card-flat pad-s" style={gap(14)}>
                  <span className="av">{me.slice(2, 4).toUpperCase()}</span>
                  <div className={`grow ${s.idLine}`}>
                    <b>{t("login.wallet", { wallet: short(checksumAddress(me)) })}</b>
                    <div className="small muted">{t("login.connected")}</div>
                  </div>
                  <div className="col" style={gap(4, { alignItems: "flex-end" })}>
                    <button type="button" className="link-btn" onClick={doSwitch} disabled={busy || showCharge}>
                      {t("login.switch")}
                    </button>
                    {showCharge ? <span className="tiny faint">{t("login.cancelToSwitch")}</span> : null}
                  </div>
                </div>
              ) : session.walletKind === "privy" ? (
                <div className="col" style={gap(14)}>
                  <div>
                    <Button size="lg" icon="mail" loading={session.signingIn} onClick={doLogin}>
                      {t("login.privyButton")}
                    </Button>
                  </div>
                  <p className="small muted">{t("login.privyText")}</p>
                </div>
              ) : (
                <div className="col" style={gap(14)}>
                  <p className="muted">{t("login.devText")}</p>
                  <div>
                    <Button size="lg" icon="wallet" loading={session.signingIn} onClick={doLogin}>
                      {t("login.devButton")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <GuardNotice guard={guard} slug={agent.slug} minText={minUnits != null ? tokenAmt(minUnits) : ""} />

            {/* 2. Guarantee: task and criteria */}
            {isG && guarantee ? (
              <>
                <div className="card pad col" style={gap(20)}>
                  <div className="row" style={gap(14)}>
                    <StepDot n={stepTask} done={titleOk && descOk} />
                    <h2 className="h3">{t("task.title")}</h2>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="task-title">
                      {t("task.titleLabel")}
                    </label>
                    <input
                      id="task-title"
                      className="input"
                      value={title}
                      maxLength={TASK_LIMITS.titleMax}
                      placeholder={t("task.titlePlaceholder")}
                      onChange={(e) => setTitle(e.target.value)}
                      aria-invalid={touched && !titleOk}
                      aria-describedby="task-title-help"
                      disabled={busy || showCharge}
                    />
                    <span id="task-title-help" className={`tiny ${touched && !titleOk ? "warn" : "faint"}`}>
                      {t("task.titleHelp", { min: TASK_LIMITS.titleMin, max: TASK_LIMITS.titleMax })}
                    </span>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="task-desc">
                      {t("task.descLabel")}
                    </label>
                    <textarea
                      id="task-desc"
                      className="textarea"
                      value={desc}
                      maxLength={TASK_LIMITS.descMax}
                      placeholder={t("task.descPlaceholder")}
                      onChange={(e) => setDesc(e.target.value)}
                      aria-invalid={touched && !descOk}
                      aria-describedby="task-desc-help"
                      disabled={busy || showCharge}
                    />
                    <span id="task-desc-help" className={`tiny num ${s.counter} ${touched && !descOk ? "warn" : "faint"}`}>
                      {desc.trim().length < TASK_LIMITS.descMin ? t("task.descMin", { min: TASK_LIMITS.descMin }) : ""}
                      {desc.length}/{TASK_LIMITS.descMax}
                    </span>
                  </div>
                  <div className="field">
                    <span className="label" id="task-deadline">
                      {t("task.deliveryLabel")}
                    </span>
                    <div className="seg" role="radiogroup" aria-labelledby="task-deadline" style={{ alignSelf: "flex-start" }}>
                      {DELIVERY_OPTIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={deliveryDays === d}
                          className={deliveryDays === d ? "on" : undefined}
                          onClick={() => setDeliveryDays(d)}
                          disabled={busy || showCharge}
                        >
                          {t("task.deliveryDays", { n: d })}
                        </button>
                      ))}
                    </div>
                    <span className="tiny faint">{t("task.deliveryHelp")}</span>
                  </div>
                  <div className="col" style={gap(12)}>
                    <span className="label">{t("task.criteriaLabel")}</span>
                    {guarantee.milestones.map((ms, i) => (
                      <div key={ms.title} className="row start card-flat pad-s" style={gap(12)}>
                        <span className="dot" style={{ width: 28, height: 28 }}>
                          {i + 1}
                        </span>
                        <div className="grow col" style={{ ...gap(6), minWidth: 0 }}>
                          <div className="row between start wrapx" style={gap(8)}>
                            <div className="row wrapx" style={gap(8)}>
                              <b>{ms.title}</b>
                              {ms.verify === "manual" ? (
                                <Chip tone="brand" icon="eye">
                                  {t("task.manual")}
                                </Chip>
                              ) : (
                                <Chip tone="ok" icon="check-circle">
                                  {t("task.tested")}
                                </Chip>
                              )}
                            </div>
                            <span className={s.msAmount}>
                              <b className="num">{localNum(ms.amountUsdc)}</b> <span className="tiny faint num">· {tokenNum(ms.amountUsdc)}</span>
                            </span>
                          </div>
                          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                            {ms.criteria.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ))}
                    <p className="tiny faint">{t("task.criteriaNote")}</p>
                  </div>
                </div>

                <div className="card pad col" style={{ ...gap(20), borderColor: "color-mix(in oklab,var(--mint) 35%,var(--line))" }}>
                  <div className="row" style={gap(12)}>
                    <span className="ok">
                      <Icon name="shield-check" size="l" />
                    </span>
                    <h2 className="h3">{t("how.title")}</h2>
                  </div>
                  <p className="muted" style={{ maxWidth: 640 }}>
                    {t("how.intro")}
                  </p>
                  <div className="steps">
                    <GStep icon="lock" title={t("how.s1.title")}>
                      {t("how.s1.text")}
                    </GStep>
                    <GStep icon="layers" title={t("how.s2.title")}>
                      {t("how.s2.text")}
                    </GStep>
                    <GStep icon="eye" title={t("how.s3.title")}>
                      {t("how.s3.text")}
                    </GStep>
                    <GStep icon="check" title={t("how.s4.title")}>
                      {t("how.s4.text", { window: reviewWin })}
                    </GStep>
                  </div>
                  <GuaranteeLevelInfo config={config} limits={limits} logged={logged} totalUnits={totalUnits} tokenNum={tokenNum} tokenAmt={tokenAmt} />
                  {singleTooBig && limits && totalUnits != null ? (
                    <Notice tone="warn" title={t("singleTooBig.title")}>
                      {t("singleTooBig.text", { max: tokenNum(limits.singleMilestoneMaxUsdc), total: tokenAmt(totalUnits) })}
                    </Notice>
                  ) : null}
                  {logged && limitsFailed ? (
                    <Notice
                      tone="bad"
                      role="alert"
                      title={t("limitsFailed.title")}
                      actions={
                        <Button size="sm" variant="secondary" icon="refresh" onClick={() => void loadAccount()}>
                          {t("limitsFailed.retry")}
                        </Button>
                      }
                    >
                      {t("limitsFailed.text")}
                    </Notice>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* Payment method */}
            <div className="card pad col" style={gap(18)}>
              <div className="row" style={gap(14)}>
                <StepDot n={stepPay} />
                <h2 className="h3">{t("pay.title")}</h2>
              </div>
              {payOptions}
              {logged && effMethod === "wallet" && balance != null && totalUnits != null && !covers ? (
                <Notice
                  tone="warn"
                  title={t("pay.lowTitle", { symbol: token.symbol })}
                  actions={
                    <>
                      {config.faucetEnabled ? (
                        <Button size="sm" icon="coin" loading={faucetPending} onClick={() => void getTestFunds()}>
                          {t("pay.faucet")}
                        </Button>
                      ) : null}
                      {pixOn ? (
                        <Button size="sm" variant="secondary" onClick={() => setMethod("pix")}>
                          {t("pay.payWithPix")}
                        </Button>
                      ) : null}
                      {solanaOn ? (
                        <Button size="sm" variant="secondary" onClick={() => setMethod("solana")}>
                          {t("pay.payWithSolana")}
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  {t("pay.lowText", { balance: tokenAmt(balance), total: tokenAmt(totalUnits) })}
                </Notice>
              ) : null}
            </div>

            {/* Review and pay */}
            <div className="card pad col" style={gap(16)}>
              <div className="row" style={gap(14)}>
                <StepDot n={stepReview} />
                <h2 className="h3">{solCharge ? t("review.titleSolana") : showCharge ? t("review.titlePix") : t("review.title")}</h2>
              </div>
              {showCharge && charge ? (
                <PixPanel
                  charge={charge}
                  ownerWallet={chargeWallet ?? ""}
                  simulate={config.pix.simulate}
                  token={token}
                  onUpdate={setCharge}
                  onDone={onChargeDone}
                  onRestart={restartCharge}
                />
              ) : solCharge ? (
                <SolanaPayPanel charge={solCharge} ownerWallet={chargeWallet ?? ""} token={token} onUpdate={setSolCharge} onDone={onChargeDone} onRestart={restartCharge} />
              ) : (
                <>
                  <button
                    type="button"
                    className="row start"
                    onClick={() => setAgree((v) => !v)}
                    style={{ ...gap(12), background: "none", border: 0, textAlign: "left", padding: 0, minHeight: 44, color: "inherit" }}
                    role="checkbox"
                    aria-checked={agree}
                    disabled={busy}
                  >
                    <span className={`check ${agree ? "on" : ""}`}>
                      <Icon name="check" size="s" />
                    </span>
                    <span className="small grow">{agreeText}</span>
                  </button>
                  {touched && isG && (!titleOk || !descOk) ? (
                    <p className="small warn" role="alert">
                      {t("review.needTask", { min: TASK_LIMITS.descMin })}
                    </p>
                  ) : null}
                  <Button size="lg" block iconRight="arrow-right" loading={pending} disabled={!canPay} className={canPay ? "" : "off"} onClick={pay}>
                    {effMethod === "pix"
                      ? t("review.payPix", { price: totalText })
                      : effMethod === "solana" && totalUnits != null
                        ? t("review.paySolana", { amount: tokenText(totalUnits, { symbol: config.solanaPay.tokenSymbol, decimals: dec }, intl) })
                        : t("review.pay", { price: totalText })}
                  </Button>
                  <p className="tiny faint center">
                    <Icon name="lock" size="s" /> {t("review.protected")} {isG ? t("review.protectedGuarantee") : t("review.protectedLicense")}
                  </p>
                </>
              )}
              {priceChange ? (
                <Notice tone="warn" role="alert" title={t("review.priceTitle")}>
                  {t("review.priceChanged", { from: local(priceChange.from), to: local(priceChange.to) })}
                </Notice>
              ) : null}
              <p className={pending && effMethod === "wallet" ? "small muted center" : "sr-only"} role="status" aria-live="polite">
                {pending && effMethod === "wallet" ? t("review.signing") : ""}
              </p>
              {error ? (
                <Notice
                  tone="bad"
                  role="alert"
                  title={error.title}
                  actions={
                    error.action === "login" ? (
                      <Button size="sm" onClick={doLogin}>
                        {t("review.loginAgain")}
                      </Button>
                    ) : error.action === "faucet" && config.faucetEnabled ? (
                      <Button size="sm" icon="coin" loading={faucetPending} onClick={() => void getTestFunds()}>
                        {t("pay.faucet")}
                      </Button>
                    ) : error.action === "retry" ? (
                      <Button size="sm" icon="refresh" onClick={() => setError(null)}>
                        {t("review.retry")}
                      </Button>
                    ) : null
                  }
                >
                  {error.text}
                </Notice>
              ) : null}
            </div>
          </div>

          {/* Summary */}
          <aside className="sticky">
            <div className="card pad col" style={gap(18)}>
              {modes.length > 1 ? (
                <div className="seg" role="tablist" aria-label={t("summary.typeLabel")} style={{ alignSelf: "stretch", display: "flex" }}>
                  {modes.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="tab"
                      aria-selected={m.id === kind}
                      className={m.id === kind ? "on" : undefined}
                      style={{ flex: 1, justifyContent: "center", whiteSpace: "nowrap", paddingInline: 10 }}
                      onClick={() => switchKind(m.id)}
                      disabled={busy || showCharge}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="row" style={gap(14)}>
                <Tile category={agent.category} />
                <div className="grow">
                  <b style={{ fontSize: 17 }}>{agent.name}</b>
                  <div className="small muted trunc">{t("summary.by", { creator: creator.name })}</div>
                </div>
              </div>
              <div className="divider" />
              <div className="col small" style={gap(10)}>
                <div className="row between" style={gap(12)}>
                  <span className="muted grow">{lineLabel}</span>
                  <b className="num flex-none">{totalText}</b>
                </div>
                <div className="row between">
                  <span className="muted">{t("summary.networkFee")}</span>
                  <b className="num ok">{t("summary.networkFeeValue")}</b>
                </div>
              </div>
              <div className="divider" />
              <div className="col" style={gap(2)}>
                <div className="row between" style={{ alignItems: "baseline" }}>
                  <span className="bold">{t("summary.total")}</span>
                  <span className="display num" style={{ fontSize: 44 }}>
                    {totalText}
                  </span>
                </div>
                {totalUnits != null ? (
                  <div className="row between small">
                    <span className="muted">{t("summary.tokenPrice", { symbol: token.symbol })}</span>
                    <b className="num">{tokenAmt(totalUnits)}</b>
                  </div>
                ) : null}
                <div className="tiny faint" style={{ marginTop: 6 }}>
                  {locale === "en" ? t("summary.rateNoteUsd", { symbol: token.symbol }) : t("summary.rateNoteBrl", { rate: f.num(rate, 2), symbol: token.symbol })}
                </div>
              </div>
              <div>
                {isG ? (
                  <Chip tone="ok" icon="lock">
                    {t("summary.chipGuarantee")}
                  </Chip>
                ) : (
                  <Chip tone="ok" icon="shield-check">
                    {t("summary.chipLicense")}
                  </Chip>
                )}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}

/** Friendly explanation of why this purchase cannot go ahead (the server refuses it too). */
function GuardNotice({ guard, slug, minText }: { guard: GuardCode | null; slug: string; minText: string }) {
  const t = useTranslations("checkout.view.guard");
  if (!guard) return null;
  switch (guard) {
    case "owned":
      return (
        <Notice
          tone="ok"
          title={t("owned.title")}
          actions={
            <>
              <Button size="sm" href={`/install?agent=${encodeURIComponent(slug)}`}>
                {t("owned.connect")}
              </Button>
              <Button size="sm" variant="secondary" href="/library">
                {t("owned.library")}
              </Button>
            </>
          }
        >
          {t("owned.text")}
        </Notice>
      );
    case "creator":
      return (
        <Notice
          tone="brand"
          title={t("creator.title")}
          actions={
            <Button size="sm" variant="secondary" href="/creator">
              {t("creator.panel")}
            </Button>
          }
        >
          {t("creator.text")}
        </Notice>
      );
    case "sold_out":
      return (
        <Notice
          tone="warn"
          role="alert"
          title={t("soldOut.title")}
          actions={
            <Button size="sm" variant="secondary" href="/">
              {t("soldOut.viewOthers")}
            </Button>
          }
        >
          {t("soldOut.text")}
        </Notice>
      );
    case "below_min":
      return (
        <Notice tone="warn" role="alert" title={t("belowMin.title")}>
          {t("belowMin.text", { min: minText })}
        </Notice>
      );
    case "paused":
      return (
        <Notice tone="warn" role="alert" title={t("paused.title")}>
          {t("paused.text")}
        </Notice>
      );
    default:
      return (
        <Notice tone="warn" role="alert" title={t("unavailable.title")}>
          {t("unavailable.text")}
        </Notice>
      );
  }
}

function GStep({ icon, title, children }: { icon: "lock" | "layers" | "eye" | "check"; title: string; children: ReactNode }) {
  return (
    <div className="step">
      <span className="dot dot-ok">
        <Icon name={icon} />
      </span>
      <div>
        <b>{title}</b>
        <p className="small muted">{children}</p>
      </div>
    </div>
  );
}

function GuaranteeLevelInfo({
  config,
  limits,
  logged,
  totalUnits,
  tokenNum,
  tokenAmt,
}: {
  config: PublicConfig;
  limits: GuaranteeStatus | null;
  logged: boolean;
  totalUnits: bigint | null;
  tokenNum: (n: number) => string;
  tokenAmt: (u: bigint) => string;
}) {
  const t = useTranslations("checkout.view.level");
  const f = useFormat();
  const bold = (c: ReactNode) => <b>{c}</b>;
  const L = config.guaranteeLimitsUsdc;
  if (!logged || !limits)
    return (
      <div className="row card-flat pad-s" style={gap(12)}>
        <Icon name="info" />
        <span className="small grow">{t.rich("newAccounts", { limited: tokenNum(L.limited), full: tokenNum(L.full), b: bold })}</span>
      </div>
    );
  const level = f.guaranteeLevel(limits.level).toLowerCase();
  const avail = priceUnits(Math.max(0, limits.availableUsdc), config.paymentToken.decimals);
  if (totalUnits != null && avail != null && avail < totalUnits)
    return (
      <Notice tone="warn" title={t("overTitle")}>
        {t.rich("overText", {
          level,
          limit: tokenNum(limits.limitUsdc),
          open: tokenNum(limits.openUsdc),
          available: tokenNum(Math.max(0, limits.availableUsdc)),
          total: tokenAmt(totalUnits),
          b: bold,
        })}
        {limits.purchasesToFull > 0 ? t("toFullMax", { n: limits.purchasesToFull, full: tokenNum(L.full) }) : limits.disputesLost > limits.maxDisputesLost ? t("reduced") : t("wait")}
      </Notice>
    );
  return (
    <div className="row card-flat pad-s" style={gap(12)}>
      <Icon name="info" />
      <span className="small grow">
        {t.rich("info", { level, limit: tokenNum(limits.limitUsdc), available: tokenNum(limits.availableUsdc), b: bold })}
        {limits.purchasesToFull > 0 ? t("toFull", { n: limits.purchasesToFull }) : ""}
      </span>
    </div>
  );
}
