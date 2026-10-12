"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RepBadge } from "@/components/ui/Chip";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { useFormat } from "@/lib/format";
import { useSession } from "@/lib/session";
import { gap } from "@/lib/style";

/** Wallet shortened for display ("0x12ab…cdef"). */
const shortAddress = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

/**
 * First name of the signed-in person. Without a name in the profile, the creator's public name (`fallback`) and, last,
 * the shortened wallet.
 */
export function useFirstName(fallback?: string | null): string | null {
  const { me } = useSession();
  if (!me) return null;
  const name = me.displayName || fallback;
  return name ? (name.split(" ")[0] ?? name) : shortAddress(me.wallet);
}

/** Creator dashboard header: eyebrow, reputation badge, greeting and the tabs (overview / submissions / publish). */
export function CreatorHead({ tab, reputation, title, name }: { tab: "overview" | "publish" | "submissions"; reputation?: number | null; title?: ReactNode; name?: string | null }) {
  const t = useTranslations("creator.head");
  const f = useFormat();
  const first = useFirstName(name);
  const lv = reputation != null ? f.repLevel(reputation) : null;
  return (
    <div className="row between end wrapx" style={gap(24, { marginBottom: 28 })}>
      <div className="col" style={gap(12)}>
        <div className="row wrapx" style={gap(10)}>
          <span className="eyebrow">{t("eyebrow")}</span>
          {lv && reputation != null ? (
            <RepBadge score={reputation}>
              <span>{t("repBadge", { label: lv.label, score: Math.round(reputation) })}</span>
            </RepBadge>
          ) : null}
        </div>
        <h1 className="display h1s">{title ?? (first ? t("hello", { name: first }) : t("forCreators"))}</h1>
      </div>
      <Tabs
        aria-label={t("tabsLabel")}
        value={tab}
        tabs={[
          { id: "overview", label: t("tabs.overview"), href: "/creator" },
          { id: "submissions", label: t("tabs.submissions"), href: "/creator/submissions" },
          {
            id: "publish",
            label: (
              <>
                <Icon name="plus" size="s" />
                {t("tabs.publish")}
              </>
            ),
            href: "/creator/publish",
          },
        ]}
      />
    </div>
  );
}
