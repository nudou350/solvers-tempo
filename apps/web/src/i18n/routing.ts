import { defineRouting } from "next-intl/routing";

// English is the default and has no prefix (/solvers); Portuguese uses /pt (/pt/solvers).
// The first visit picks by Accept-Language; after that the NEXT_LOCALE cookie applies (changed by the header switcher).
export const routing = defineRouting({
  locales: ["en", "pt"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];

/** BCP 47 locale for Intl (numbers, dates). */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-US", pt: "pt-BR" };
