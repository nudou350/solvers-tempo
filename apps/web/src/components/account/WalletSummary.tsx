"use client";
// Balance of the signed-in wallet and, when a payment to it could not be delivered directly, the held amount with a
// "Claim" action (decisions.md D5: the contract keeps it until the wallet claims it).
import type { DeferredPayouts, TokenBalance } from "@solvers/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Notice, useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { gap } from "@/lib/style";
import { heldTotal } from "./account-rules";
import { useAccountTx, useMoney } from "./account-tx";

/** Balance chip for page headers. `refreshKey` reloads it (e.g. after a transfer). */
export function BalanceChip({ refreshKey = 0 }: { refreshKey?: number }) {
  const t = useTranslations("account.wallet");
  const money = useMoney();
  const [balance, setBalance] = useState<TokenBalance | null | "error">(null);
  useEffect(() => {
    let live = true;
    api.getBalance().then(
      (b) => live && setBalance(b),
      () => live && setBalance("error"),
    );
    return () => {
      live = false;
    };
  }, [refreshKey]);
  if (balance === null || balance === "error") return null;
  return (
    <span className="chip" title={t("balanceHint")}>
      <Icon name="coin" size="s" />
      {t("balance", { amount: money(balance.units) })}
    </span>
  );
}

/**
 * Held payouts with the "Claim" button; renders nothing when nothing is held. `onClaimed` lets the page reload what
 * depends on the balance.
 */
export function HeldPayouts({ refreshKey = 0, onClaimed }: { refreshKey?: number; onClaimed?: () => void }) {
  const t = useTranslations("account.wallet");
  const money = useMoney();
  const toast = useToast();
  const tx = useAccountTx();
  const [payouts, setPayouts] = useState<DeferredPayouts | null>(null);

  const load = useCallback(() => {
    api.getMyPayouts().then(setPayouts, () => setPayouts(null));
  }, []);
  useEffect(load, [load, refreshKey]);

  const held = heldTotal(payouts);
  if (held === 0n) return null;

  const claim = async () => {
    const r = await tx.run(() => api.buildClaim());
    if (!r) return;
    toast({ tone: "ok", title: t("claimedTitle"), text: t("claimedText", { amount: money(held) }) });
    load();
    onClaimed?.();
  };

  return (
    <Notice
      tone="warn"
      title={t("heldTitle", { amount: money(held) })}
      actions={
        <Button size="sm" icon="download" loading={tx.pending} onClick={() => void claim()}>
          {t("claim")}
        </Button>
      }
    >
      <span className="col" style={gap(6)}>
        <span>{t("heldText")}</span>
        {tx.error ? (
          <span className="bad" role="alert">
            {tx.error}
          </span>
        ) : null}
      </span>
    </Notice>
  );
}
