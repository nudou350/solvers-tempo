"use client";
// Transaction error (already translated by lib/error-text), with the action that makes sense: get test funds, sign in
// again or try again.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Notice, useToast } from "@/components/ui/Toast";
import { useErrorText } from "@/lib/error-text";
import { useSession } from "@/lib/session";
import { useFaucet, type TxErrorInfo } from "@/lib/tx";

export function TxErrorNotice({ error, onRetry, extraActions }: { error: TxErrorInfo; onRetry?: () => void; extraActions?: ReactNode }) {
  const { signIn } = useSession();
  const faucet = useFaucet();
  const toast = useToast();
  const errorText = useErrorText();
  const t = useTranslations("common.txError");
  const doSignIn = () => signIn().catch((e: unknown) => toast({ tone: "bad", title: t("signInFailed"), text: errorText(e) }));
  const getFunds = async () => {
    const r = await faucet.receive();
    if (r) toast({ tone: "ok", title: t("fundsSent") });
    else if (faucet.error) toast({ tone: "bad", title: faucet.error.title, text: faucet.error.text });
  };
  const actions =
    error.action === "login" ? (
      <Button size="sm" onClick={doSignIn}>
        {t("signIn")}
      </Button>
    ) : error.action === "faucet" && faucet.enabled ? (
      <Button size="sm" variant="secondary" icon="gift" loading={faucet.pending} onClick={() => void getFunds()}>
        {t("getTestFunds")}
      </Button>
    ) : error.action === "retry" && onRetry ? (
      <Button size="sm" icon="refresh" onClick={onRetry}>
        {t("retry")}
      </Button>
    ) : null;
  return (
    <Notice
      tone="bad"
      role="alert"
      title={error.title}
      actions={
        actions || extraActions ? (
          <>
            {actions}
            {extraActions}
          </>
        ) : undefined
      }
    >
      {error.text}
    </Notice>
  );
}
