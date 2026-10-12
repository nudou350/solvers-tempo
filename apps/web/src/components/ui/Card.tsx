import { Link } from "@/i18n/navigation";
import type { CSSProperties, ElementType, ReactNode } from "react";

export type CardProps = {
  /** Inner padding: s = 20px, m = 28px (default), l = 36px, none = no padding. */
  pad?: "none" | "s" | "m" | "l";
  /** Flat variant (.card-flat: surface-2 background, no border). */
  flat?: boolean;
  /** Becomes a link, with the design's hover effect. */
  href?: string;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  "aria-label"?: string;
};

export function Card({ pad = "m", flat, href, as, className, style, children, ...aria }: CardProps) {
  const cls = [flat ? "card-flat" : "card", pad === "none" ? "" : pad === "m" ? "pad" : `pad-${pad}`, className ?? ""].filter(Boolean).join(" ");
  if (href)
    return (
      <Link href={href} className={cls} style={style} aria-label={aria["aria-label"]}>
        {children}
      </Link>
    );
  const Tag: ElementType = as ?? "div";
  return (
    <Tag className={cls} style={style} aria-label={aria["aria-label"]}>
      {children}
    </Tag>
  );
}
