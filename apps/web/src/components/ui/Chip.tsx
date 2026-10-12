import { useTranslations } from "next-intl";
import type { CSSProperties, ReactNode } from "react";
import { repCls, useFormat } from "@/lib/format";
import { Icon, type IconName } from "./Icon";

export type ChipTone = "default" | "ok" | "brand" | "warn" | "red" | "plain";

/** Design chip/badge (.chip). For clickable filters use <button className="chip on">. */
export function Chip({ tone = "default", icon, children, className }: { tone?: ChipTone; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={["chip", tone !== "default" ? `chip-${tone}` : "", className ?? ""].filter(Boolean).join(" ")}>
      {icon ? <Icon name={icon} size="s" /> : null}
      {children}
    </span>
  );
}

/**
 * Reputation badge (0..100) with the design's level: Reference, Trusted, Growing...
 * `children` replaces the text (e.g. "Trusted creator"); the tone and icon follow the level.
 */
export function RepBadge({ score, showScore = false, children, style }: { score: number; showScore?: boolean; children?: ReactNode; style?: CSSProperties }) {
  const f = useFormat();
  const t = useTranslations("common.ui");
  const lv = f.repLevel(score);
  return (
    <span className={repCls(score)} title={t("reputationTitle", { score: Math.round(score) })} style={style}>
      <Icon name={lv.tone === "warn" ? "warning" : "shield-check"} size="s" />
      {children ?? <span>{lv.label}</span>}
      {showScore ? <span className="num">· {Math.round(score)}</span> : null}
    </span>
  );
}

/** "Verified purchase" (or another text) in green. */
export function Verified({ children }: { children?: ReactNode }) {
  const t = useTranslations("common.ui");
  return (
    <span className="verified">
      <Icon name="check-circle" size="s" />
      {children ?? t("verifiedPurchase")}
    </span>
  );
}
