import { useTranslations } from "next-intl";

export type SpinnerProps = { size?: "s" | "m" | "l"; label?: string; className?: string };

/** Loading indicator. With `label`, it announces the text to screen readers. */
export function Spinner({ size = "m", label, className }: SpinnerProps) {
  return (
    <span
      className={["spin", size !== "m" ? `spin-${size}` : "", className ?? ""].filter(Boolean).join(" ")}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Loading block for a whole section: spinner + text. */
export function Loading({ text }: { text?: string }) {
  const t = useTranslations("common.ui");
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <Spinner />
      <span className="small">{text ?? t("loading")}</span>
    </div>
  );
}
