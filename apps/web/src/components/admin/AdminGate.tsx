"use client";
// Review area: admin wallets only (CreatorMe.isAdmin). Anyone else sees "not found", like an address that does not exist.
// The server checks the real permission on every route; this only avoids showing a useless screen.
import { useTranslations } from "next-intl";
import { notFound } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AuthGate } from "@/components/ui/AuthGate";
import { Loading } from "@/components/ui/Spinner";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";

export function AdminGate({ children }: { children: ReactNode }) {
  const t = useTranslations("admin.gate");
  const { status, me } = useSession();
  const [admin, setAdmin] = useState<"loading" | "yes" | "no">("loading");

  useEffect(() => {
    if (status !== "signed-in") return;
    let live = true;
    setAdmin("loading");
    api.getCreatorMe().then(
      (c) => live && setAdmin(c.isAdmin ? "yes" : "no"),
      () => live && setAdmin("no"),
    );
    return () => {
      live = false;
    };
  }, [api, status, me?.wallet]);

  if (status === "signed-in" && admin === "no") notFound();
  return (
    <section className="wrap" style={{ paddingTop: 44, paddingBottom: 56 }}>
      <AuthGate icon="lock" title={t("title")} text={t("text")}>
        {admin === "yes" ? children : <Loading />}
      </AuthGate>
    </section>
  );
}
