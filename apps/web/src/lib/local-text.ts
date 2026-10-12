// Translated text outside React components (thrown errors, plain labels), from messages/<locale>/errors.json.
// Without an explicit `locale`, the language of the page open in the browser applies (<html lang>, set by the
// layout); on the server (no browser) it falls back to English. Server renderers must pass the page `locale`.
import { createTranslator } from "next-intl";
import type { Locale } from "@/i18n/routing";
import en from "../../messages/en/errors.json";
import pt from "../../messages/pt/errors.json";

const MESSAGES: Record<Locale, unknown> = { en, pt };

type Values = Record<string, string | number>;
export type ErrorsTranslator = ((key: string, values?: Values) => string) & { has: (key: string) => boolean };

const cache = new Map<Locale, ErrorsTranslator>();

/** Page language in the browser (<html lang="pt-BR"> or the /pt prefix); on the server, English. */
export function detectLocale(): Locale {
  if (typeof document === "undefined") return "en";
  const lang = document.documentElement.lang?.toLowerCase() ?? "";
  if (lang.startsWith("pt")) return "pt";
  if (lang.startsWith("en")) return "en";
  return /^\/pt(\/|$)/.test(window.location.pathname) ? "pt" : "en";
}

/** Translator of the "errors" namespace outside React. */
export function errorsTranslator(locale: Locale = detectLocale()): ErrorsTranslator {
  let t = cache.get(locale);
  if (!t) {
    const tr = createTranslator({ locale, messages: { errors: MESSAGES[locale] } as never, namespace: "errors" } as never) as unknown as ErrorsTranslator;
    t = Object.assign((key: string, values?: Values) => tr(key, values), { has: (key: string) => tr.has(key) });
    cache.set(locale, t);
  }
  return t;
}

/** Text of errors.<key> in the page language (or the given `locale`). */
export function localText(key: string, values?: Values, locale?: Locale): string {
  return errorsTranslator(locale)(key, values);
}
