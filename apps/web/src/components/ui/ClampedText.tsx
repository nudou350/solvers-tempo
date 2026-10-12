"use client";
// Long paragraph collapsed to a few lines, with "See more" only when the text actually exceeds the limit.
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

export function ClampedText({ text, style }: { text: string; style?: React.CSSProperties }) {
  const t = useTranslations("common.ui");
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measures only while collapsed: expanded, scrollHeight == clientHeight and the "See less" button would disappear.
    const measure = () => {
      if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, text]);

  return (
    <div className="col" style={{ gap: 6, maxWidth: 720 }}>
      <p id={id} ref={ref} className={expanded ? undefined : "clamp"} style={style}>
        {text}
      </p>
      {overflows || expanded ? (
        <button type="button" className="clamp-btn" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("seeLess") : t("seeMore")}
        </button>
      ) : null}
    </div>
  );
}
