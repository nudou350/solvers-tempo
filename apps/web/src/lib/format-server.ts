import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import { type Format, makeFormat, type T } from "./format";

/** Formatters in the page language (async server component). */
export async function getFormat(): Promise<Format> {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("format");
  return makeFormat(locale, t as unknown as T);
}
