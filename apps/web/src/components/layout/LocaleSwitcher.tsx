"use client";
// Language switcher (EN | PT): goes to the same path in the other language, keeping the query.
// The query is read from the browser only on click (useSearchParams would require <Suspense> around the whole layout).
// Full navigation (not router.replace): the root layout lives in [locale], so switching language recreates the <html>
// and the theme script only runs on a page load. The NEXT_LOCALE cookie is written first, otherwise the proxy would send
// the visitor back to the old language when opening an unprefixed (English) route.
import { useLocale, useTranslations } from "next-intl";
import { useState, type CSSProperties } from "react";
import { getPathname, usePathname } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

const box: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: 3,
  gap: 2,
  borderRadius: 999,
  border: "1px solid var(--line)",
  background: "var(--surface)",
};

function seg(on: boolean): CSSProperties {
  return {
    minWidth: 38,
    minHeight: 36,
    padding: "0 8px",
    borderRadius: 999,
    border: 0,
    font: "inherit",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: ".03em",
    cursor: on ? "default" : "pointer",
    background: on ? "var(--surface-2)" : "transparent",
    color: on ? "var(--ink)" : "var(--ink-2)",
  };
}

export function LocaleSwitcher() {
  const t = useTranslations("common.localeSwitcher");
  const current = useLocale() as Locale;
  const pathname = usePathname();
  const [pending, setPending] = useState(false);

  const change = (locale: Locale) => {
    if (locale === current) return;
    setPending(true);
    const query = Object.fromEntries(new URLSearchParams(window.location.search));
    document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; samesite=lax`;
    window.location.assign(getPathname({ href: { pathname, query }, locale }) + window.location.hash);
  };

  return (
    <div role="group" aria-label={t("label")} style={box}>
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          style={seg(l === current)}
          aria-pressed={l === current}
          aria-label={t(l)}
          title={t(l)}
          disabled={pending}
          onClick={() => change(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
