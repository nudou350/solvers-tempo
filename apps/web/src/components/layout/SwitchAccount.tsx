"use client";
// "Switch account". With Privy it is a plain sign-out. With the dev wallet, signing out and in again would come back to
// the same wallet, so it offers "use another test wallet" (forgets this browser's test key and creates another).
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useErrorText } from "@/lib/error-text";
import { short } from "@/lib/format";
import { useSession } from "@/lib/session";
import { gap } from "@/lib/style";
import { useWallet } from "@/lib/wallet";

export function SwitchAccount({ disabled, label }: { disabled?: boolean; label?: string }) {
  const t = useTranslations("common.switchAccount");
  const errorText = useErrorText();
  const text = label ?? t("label");
  const { me, signIn, signOut } = useSession();
  const wallet = useWallet();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (wallet.kind !== "dev")
    return (
      <button type="button" className="link-btn" onClick={() => void signOut()} disabled={disabled}>
        {text}
      </button>
    );

  async function switchWallet() {
    setBusy(true);
    try {
      await signOut();
      wallet.forgetDevWallet();
      await signIn("dev");
      setOpen(false);
      toast({ tone: "ok", title: t("newWallet") });
    } catch (e) {
      toast({ tone: "bad", title: t("switchFailed"), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={gap(10, { alignItems: "flex-end", flexBasis: open ? "100%" : undefined })}>
      <button type="button" className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open} disabled={disabled || busy}>
        {text}
      </button>
      {open ? (
        <div className="card-flat pad-s col" role="group" aria-label={t("group")} style={gap(10, { alignSelf: "stretch", background: "var(--surface)" })}>
          <span className="small">{t("explain", { wallet: me ? short(me.wallet) : "" })}</span>
          <div className="row wrapx" style={gap(8)}>
            <Button size="sm" icon="wallet" loading={busy} onClick={switchWallet}>
              {t("useOther")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void signOut()} disabled={busy}>
              {t("justSignOut")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
