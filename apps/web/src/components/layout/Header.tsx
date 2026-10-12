"use client";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";
import { usePublicConfig } from "@/lib/config";
import { useErrorText } from "@/lib/error-text";
import { networkKind } from "@/lib/explorer";
import { initials, short } from "@/lib/format";
import { formatToken } from "@/lib/format-money";
import { useSession } from "@/lib/session";
import { useFaucet } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { ThemeToggle } from "./ThemeToggle";

// `key` points to common.json -> nav.<key> (label) and nav.<key>Short (short label of the bottom bar).
type NavItem = { href: string; key: "explore" | "library" | "guarantees" | "creators"; icon: IconName };

export const NAV: NavItem[] = [
  { href: "/", key: "explore", icon: "home" },
  { href: "/library", key: "library", icon: "library" },
  { href: "/guarantees", key: "guarantees", icon: "shield-check" },
  { href: "/creator", key: "creators", icon: "pen" },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/solvers") || pathname.startsWith("/creators");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Logo() {
  const t = useTranslations("common.header");
  return (
    <Link className="logo" href="/" aria-label={t("logoLabel")}>
      <span className="logo-mark">
        <Icon name="diamond" size="s" />
      </span>
      <span>Solvers</span>
    </Link>
  );
}

/** "Tempo test network" chip, shown only off mainnet so nobody mistakes test funds for real ones. */
function NetworkChip() {
  const config = usePublicConfig();
  const t = useTranslations("common.network");
  if (!config) return null;
  const kind = networkKind(config.chainId);
  if (kind === "mainnet") return null;
  return (
    <span title={t("testHint")} data-testid="network-label">
      <Chip tone="warn">{t(kind)}</Chip>
    </span>
  );
}

function Account() {
  const { status, me, signIn, signingIn, signOut, api } = useSession();
  const wallet = useWallet();
  const config = usePublicConfig();
  const faucet = useFaucet();
  const toast = useToast();
  const t = useTranslations("common.header");
  const errorText = useErrorText();
  const intl = INTL_LOCALE[useLocale() as Locale];
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  // "Use another test wallet" deletes this browser's test key: it asks first (anything bought with it stops showing up).
  const [confirmForget, setConfirmForget] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Closes on navigation, outside click and Esc.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) setConfirmForget(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Balance of the payment token, read when the menu opens.
  const loadBalance = () =>
    api.getBalance().then(
      (b) => setBalance(formatToken(b.units, b, intl)),
      () => setBalance(null),
    );
  useEffect(() => {
    if (open && me) void loadBalance();
  }, [open, me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === "loading") return <span className="me-pill" aria-hidden style={{ width: 44, padding: 4 }} />;
  if (!me)
    return (
      <Button variant="primary" loading={signingIn} onClick={() => signIn().catch((e: unknown) => toast({ tone: "bad", title: t("signInFailed"), text: errorText(e) }))}>
        {t("signIn")}
      </Button>
    );
  const name = me.displayName ?? short(me.wallet);
  const first = me.displayName ? me.displayName.split(" ")[0] : short(me.wallet);

  const act = (fn: () => Promise<unknown>, fail: string) => async () => {
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      toast({ tone: "bad", title: fail, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const getFunds = async () => {
    const r = await faucet.receive();
    if (r) {
      const amount = r.amountUnits && config ? formatToken(r.amountUnits, config.paymentToken, intl) : null;
      toast({ tone: "ok", title: amount ? t("fundsReceived", { amount }) : t("fundsRequested") });
      await loadBalance();
    } else if (faucet.error) toast({ tone: "bad", title: faucet.error.title, text: faucet.error.text });
  };

  return (
    <div className="acct" ref={box}>
      <button type="button" className="me-pill" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)} aria-label={t("myAccount", { name })}>
        <span className="av av-s">{me.displayName ? initials(name) : me.wallet.slice(2, 4).toUpperCase()}</span>
        <span className="me-name">{first}</span>
      </button>
      {open ? (
        <div className="acct-menu card" id="account-menu">
          <div className="acct-who">
            <b className="trunc" style={{ display: "block" }}>
              {me.displayName ?? (wallet.kind === "dev" ? t("testWallet") : t("yourAccount"))}
            </b>
            <span className="tiny faint">
              {me.email ? `${me.email} · ` : ""}
              <span className="mono">{short(me.wallet)}</span>
            </span>
            {balance ? (
              <span className="tiny" data-testid="balance">
                {t("balance", { amount: balance })}
              </span>
            ) : null}
          </div>
          <div className="only-m">
            <div className="acct-extras">
              <NetworkChip />
              <ThemeToggle />
            </div>
          </div>
          <Link href="/profile">
            <Icon name="user" size="s" />
            {t("myProfile")}
          </Link>
          <Link href="/library">
            <Icon name="library" size="s" />
            {t("myLibrary")}
          </Link>
          {faucet.enabled ? (
            <button type="button" disabled={busy || faucet.pending} onClick={() => void getFunds()} data-testid="faucet">
              <Icon name="gift" size="s" />
              {faucet.pending ? t("fundsSending") : t("getTestFunds")}
            </button>
          ) : null}
          {wallet.kind === "dev" && !confirmForget ? (
            <button type="button" disabled={busy} onClick={() => setConfirmForget(true)} aria-expanded={false}>
              <Icon name="wallet" size="s" />
              {t("useOtherTestWallet")}
            </button>
          ) : null}
          {wallet.kind === "dev" && confirmForget ? (
            <div role="group" aria-label={t("useOtherTestWallet")} className="acct-confirm">
              <span className="tiny">{t("forgetWalletConfirm", { wallet: short(me.wallet) })}</span>
              <button
                type="button"
                disabled={busy}
                onClick={act(async () => {
                  await signOut();
                  wallet.forgetDevWallet();
                  await signIn("dev");
                }, t("switchWalletFailed"))}
              >
                <Icon name="wallet" size="s" />
                {t("forgetWalletYes")}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmForget(false)}>
                {t("forgetWalletNo")}
              </button>
            </div>
          ) : null}
          <button type="button" disabled={busy} onClick={act(signOut, t("signOutFailed"))}>
            <Icon name="arrow-right" size="s" />
            {t("signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Header() {
  const pathname = usePathname() ?? "/";
  const t = useTranslations("common");
  return (
    <header className="nav">
      <div className="wrap">
        <Logo />
        <nav className="nav-links" aria-label={t("header.mainNav")}>
          {NAV.map((n) => {
            const on = isActive(pathname, n.href);
            return (
              <Link key={n.href} href={n.href} className={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
                {t(`nav.${n.key}`)}
              </Link>
            );
          })}
        </nav>
        <div className="nav-actions">
          {/* On phones the header only fits the language switch and the account button: the network label and the theme
              toggle move into the account menu (`only-m` block there). */}
          <span className="hide-m">
            <NetworkChip />
          </span>
          <LocaleSwitcher />
          <span className="hide-m">
            <ThemeToggle />
          </span>
          <Account />
        </div>
      </div>
    </header>
  );
}

/** Bottom navigation bar (mobile only, by the design's CSS). */
export function TabBar() {
  const pathname = usePathname() ?? "/";
  const t = useTranslations("common");
  return (
    <nav className="tabbar" aria-label={t("header.tabbar")}>
      {NAV.map((n) => {
        const on = isActive(pathname, n.href);
        return (
          <Link key={n.href} href={n.href} className={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
            <Icon name={n.icon} size="l" />
            <span>{t(`nav.${n.key}Short`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
