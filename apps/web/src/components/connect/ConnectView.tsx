"use client";
// Connector consent (OAuth): Claude/ChatGPT opens /oauth/authorize, the server stores the request and redirects here.
// The person signs in (Privy e-mail or the dev wallet), the session wallet signs the request's SIWE message (EIP-4361,
// built by the server for this page's host) and the memory-key message (EIP-191), and we return to the assistant with
// the authorization code. Browser-extension wallets use the server's own consent page (`extensionUrl`, EIP-6963).
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Loading } from "@/components/ui/Spinner";
import { Notice } from "@/components/ui/Toast";
import { API_BASE } from "@/lib/api";
import { UserFacingError } from "@/lib/error-map";
import { useErrorText } from "@/lib/error-text";
import { short } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";

type Info = { clientName: string; redirectHost: string; verified: boolean; memoryMessage: string; extensionUrl: string };

/** Error of /oauth/authorize/*: keeps the RFC 6749 code and the server's English description, translated on screen. */
class OAuthFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { credentials: "include", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
  if (!res.ok) throw new OAuthFailure(body.error_description ?? body.error ?? fallback, body.error);
  return body;
}

export function ConnectView({ req }: { req: string | null }) {
  const { status, me, signIn, signOut, signingIn } = useSession();
  const wallet = useWallet();
  const errorText = useErrorText();
  const t = useTranslations("connect");
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(req ? null : t("invalidRequest"));
  const [step, setStep] = useState<string | null>(null);
  // Fallback text in a ref: `t` changes identity on every render and must not restart the loading effect.
  const genericError = useRef(t("genericError"));
  genericError.current = t("genericError");
  // Known server messages (English) become text in the page language; anything else goes through the app's error text.
  const localize = (e: Error) => {
    if (!(e instanceof OAuthFailure)) return errorText(e);
    if (e.code === "too_many_requests") return t("errTooMany");
    if (e.code === "access_denied") return t("errMemoryKey");
    if (e.code === "invalid_request") return /expired/i.test(e.message) ? t("errExpired") : t("errSignature");
    return e.message;
  };

  useEffect(() => {
    if (!req) return;
    let alive = true;
    getJson<Info>(`/oauth/authorize/info?req=${encodeURIComponent(req)}`, genericError.current)
      .then((i) => alive && setInfo(i))
      .catch((e: Error) => alive && setError(localize(e)));
    return () => {
      alive = false;
    };
  }, [req]);

  async function authorize() {
    if (!req || !info || !me) return;
    setError(null);
    try {
      const address = await wallet.connect(); // live state: resolves at once when already connected
      if (address.toLowerCase() !== me.wallet.toLowerCase()) throw new UserFacingError(t("walletMismatch"));
      setStep(t("stepConfirming"));
      const q = new URLSearchParams({ req, address, domain: window.location.host, uri: window.location.origin });
      const n = await getJson<{ message: string }>(`/oauth/authorize/nonce?${q}`, t("genericError"));
      const signature = await wallet.signMessage(n.message);
      setStep(t("stepMemories"));
      const memorySignature = await wallet.signMessage(info.memoryMessage);
      setStep(t("stepConnecting"));
      const done = await getJson<{ redirectTo: string }>("/oauth/authorize/complete", t("genericError"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ req, wallet: address, message: n.message, signature, memorySignature }),
      });
      setStep(t("stepDone", { client: info.clientName }));
      window.location.href = done.redirectTo;
    } catch (e) {
      setStep(null);
      setError(localize(e as Error) || t("somethingWrong"));
    }
  }

  const who = me ? (me.displayName ?? me.email ?? short(me.wallet)) : null;

  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 64, maxWidth: 560 }}>
      <Card pad="l">
        <div style={{ display: "grid", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Icon name="shield-check" size="l" />
            <h1 style={{ margin: 0, fontSize: 24 }}>{t("title")}</h1>
          </div>

          {!info && !error ? <Loading text={t("loadingRequest")} /> : null}

          {info ? (
            <>
              <p style={{ margin: 0 }}>{t.rich("intro", { client: info.clientName, b: (c) => <strong>{c}</strong> })}</p>
              <p style={{ margin: 0, fontSize: 14 }}>
                {t("returnsTo")} <code>{info.redirectHost}</code>{" "}
                {info.verified ? t("verified") : null}
              </p>
              {!info.verified ? (
                <Notice tone="warn" title={t("unverifiedTitle")}>
                  {t("unverifiedBody")}
                </Notice>
              ) : null}

              {status === "loading" ? <Loading /> : null}

              {status === "signed-out" ? (
                <>
                  <p style={{ margin: 0 }}>{t("signInPrompt")}</p>
                  <Button block loading={signingIn} onClick={() => signIn().catch((e: Error) => setError(localize(e)))}>
                    {t("signIn")}
                  </Button>
                </>
              ) : null}

              {status === "signed-in" && me ? (
                <>
                  <p style={{ margin: 0 }}>
                    {t("connectingAs")} <strong>{who}</strong>{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => signOut().catch(() => undefined)}
                      disabled={!!step}
                      style={{ background: "none", border: 0, padding: 0, color: "var(--brand)", cursor: "pointer" }}
                    >
                      {t("switchAccount")}
                    </button>
                  </p>
                  <Button block loading={!!step} onClick={authorize}>
                    {t("authorize", { client: info.clientName })}
                  </Button>
                </>
              ) : null}

              <div role="status" aria-live="polite" style={{ minHeight: 20, fontSize: 14 }}>
                {step}
              </div>
            </>
          ) : null}

          {error ? (
            <Notice tone="bad" title={t("failedTitle")} role="alert">
              {error}
            </Notice>
          ) : null}

          {info ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }}>
              {t.rich("walletHint", { link: (c) => <a href={info.extensionUrl}>{c}</a> })}
            </p>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
