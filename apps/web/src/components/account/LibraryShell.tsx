"use client";
// Library header and tabs (/library and /library/memories): license list, memory count, wallet balance and held
// payouts shared by the tabs.
import type { License } from "@solvers/shared";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AuthGate } from "@/components/ui/AuthGate";
import { Chip } from "@/components/ui/Chip";
import { Tabs } from "@/components/ui/Tabs";
import { usePathname } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { gap } from "@/lib/style";
import { PageHead } from "./shared";
import { BalanceChip, HeldPayouts } from "./WalletSummary";

export type LibraryCtx = {
  /** null while loading; "error" when it failed. */
  licenses: License[] | null | "error";
  reloadLicenses: () => void;
  /** Reloads the balance and held payouts in the header (after a transfer or a claim). */
  reloadWallet: () => void;
  setMemCount: (n: number) => void;
};

const Ctx = createContext<LibraryCtx | null>(null);

/** Library data shared by the tabs (the layout loads it once). */
export function useLibrary(): LibraryCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLibrary must be used inside <LibraryShell>");
  return c;
}

function Inner({ tab, children }: { tab: "lic" | "mem"; children: ReactNode }) {
  const t = useTranslations("account.library");
  const [licenses, setLicenses] = useState<LibraryCtx["licenses"]>(null);
  const [memCount, setMemCount] = useState<number | null>(null);
  const [walletKey, setWalletKey] = useState(0);

  const reloadLicenses = useCallback(() => {
    setLicenses(null);
    api.getMyLicenses().then(
      (l) => setLicenses([...l].sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))),
      () => setLicenses("error"),
    );
  }, []);
  const reloadWallet = useCallback(() => setWalletKey((k) => k + 1), []);

  useEffect(() => {
    reloadLicenses();
    // The count comes without unlocking the memories.
    api.getMemoriesCount().then((r) => setMemCount(r.count), () => setMemCount(null));
  }, [reloadLicenses]);

  const list = Array.isArray(licenses) ? licenses : [];
  return (
    <>
      <PageHead
        title={t("title")}
        lead={t("lead")}
        aside={
          <div className="row wrapx" style={gap(10)}>
            {Array.isArray(licenses) ? <Chip>{t("count", { n: list.length })}</Chip> : null}
            <BalanceChip refreshKey={walletKey} />
          </div>
        }
      />
      <div style={{ marginBottom: 20 }}>
        <HeldPayouts refreshKey={walletKey} onClaimed={reloadWallet} />
      </div>
      <Tabs
        aria-label={t("tabsLabel")}
        value={tab}
        tabs={[
          { id: "lic", label: t("tabSolvers"), href: "/library" },
          { id: "mem", label: t("tabMemories"), href: "/library/memories", count: memCount ?? undefined },
        ]}
      />
      <div style={{ marginTop: 28 }}>
        <Ctx.Provider value={{ licenses, reloadLicenses, reloadWallet, setMemCount }}>{children}</Ctx.Provider>
      </div>
    </>
  );
}

/** /library layout: header, tabs and the context with licenses, wallet refresh and the memory count. */
export function LibraryShell({ children }: { children: ReactNode }) {
  const t = useTranslations("account.library");
  const tab = (usePathname() ?? "").startsWith("/library/memories") ? "mem" : "lic";
  return (
    <section className="wrap" style={{ paddingTop: 44, paddingBottom: 56 }}>
      <AuthGate icon="library" title={t("gateTitle")} text={tab === "lic" ? t("gateSolvers") : t("gateMemories")}>
        <Inner tab={tab}>{children}</Inner>
      </AuthGate>
    </section>
  );
}
