import { useFormat } from "@/lib/format";

/**
 * Relative time ("3 days ago") with the full date in the title. The text may change between SSR and hydration
 * (the clock moved on): the warning is suppressed on this node only.
 */
export function Ago({ iso, className }: { iso: string; className?: string }) {
  const f = useFormat();
  return (
    <time className={className} dateTime={iso} title={f.dateTime(iso)} suppressHydrationWarning>
      {f.ago(iso)}
    </time>
  );
}
