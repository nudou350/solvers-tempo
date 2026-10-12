import type { CSSProperties } from "react";
import { ICONS, type IconName } from "./icons";

export type { IconName };

export type IconProps = {
  name: IconName;
  /** s = 16px, m (default) = 20px, l = 24px, xl = 32px. */
  size?: "s" | "m" | "l" | "xl";
  /** Text for screen readers; without it the icon is decorative (aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

/** Design icon (stroke, 24x24, color = currentColor). */
export function Icon({ name, size = "m", label, className, style }: IconProps) {
  const cls = ["ic", size !== "m" ? `ic-${size}` : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg
      className={cls}
      style={style}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
