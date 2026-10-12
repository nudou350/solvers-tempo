import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { starPct, useFormat } from "@/lib/format";

export type StarsProps = {
  /** Rating from 0 to 5. */
  rating: number;
  /** Shows the rating next to it ("4.8"). */
  showValue?: boolean;
  /** Total reviews, shown as "(120)". */
  count?: number;
  className?: string;
};

/** Proportionally filled stars (the design's SVG mask). */
export function Stars({ rating, showValue, count, className }: StarsProps) {
  const f = useFormat();
  const t = useTranslations("common.ui");
  const label = count != null ? t("ratingLabelWithCount", { rating: f.dec1(rating), count }) : t("ratingLabel", { rating: f.dec1(rating) });
  const stars = <span className="stars" style={{ "--p": `${starPct(rating)}%` } as CSSProperties} role="img" aria-label={label} />;
  if (!showValue && count == null) return <span className={className}>{stars}</span>;
  return (
    <span className={["stars-row", className ?? ""].filter(Boolean).join(" ")}>
      {stars}
      {showValue ? (
        <span className="bold num" aria-hidden>
          {f.dec1(rating)}
        </span>
      ) : null}
      {count != null ? (
        <span className="small faint num" aria-hidden>
          ({f.int(count)})
        </span>
      ) : null}
    </span>
  );
}
