// Formatting and presentation helpers, ported from design/solver-lib.js.
// The rate comes from getConfig().brlPerUsd: pass `rate` (or use useRate() from lib/config). Token amounts in base
// units are formatted by lib/format-money.ts (exact, no float math).
//
// i18n: use useFormat() (client or synchronous server component) or await getFormat() from lib/format-server (async server
// component). Both return the same formatters in the page language, with the texts in messages/<locale>/format.json.
import { useLocale, useTranslations } from "next-intl";
import type { IconName } from "@/components/ui/icons";
import { INTL_LOCALE, type Locale } from "@/i18n/routing";

export function initials(name: string): string {
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? (p[p.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** Shortened address: "0x976E…0aa9". */
export const short = (w?: string | null) => (w ? `${w.slice(0, w.startsWith("0x") ? 6 : 4)}…${w.slice(-4)}` : "");

export type Countdown = { text: string; clock: string; h: number; m: number; s: number; urgent: boolean; done: boolean };

/** Rating 0..5 → percentage for the star bar. */
export const starPct = (r: number) => Math.round((r / 5) * 100);

export type RepTone = "ok" | "brand" | "soft" | "warn";
export type RepLevel = { key: "ref" | "trust" | "grow" | "new" | "low"; label: string; tone: RepTone };

/** Class of the .rep badge (the "ok" tone is the default, no extra class). */
export const repCls = (score: number) => {
  const t = LEVEL_TONE[levelKey(score)];
  return t === "ok" ? "rep" : `rep ${t}`;
};

/** Reputation bands, from worst to best (the "Reputation levels" table); texts in format.json. */
const REP_LEVELS: { key: RepLevel["key"]; cls: string }[] = [
  { key: "low", cls: "warn" },
  { key: "new", cls: "soft" },
  { key: "grow", cls: "brand" },
  { key: "trust", cls: "" },
  { key: "ref", cls: "" },
];

/** Converts the text of a numeric field ("12,5") into a number (NaN if empty/invalid). */
export function parseNum(v: string): number {
  const t = v.trim().replace(",", ".");
  return t === "" ? Number.NaN : Number(t);
}

/** 7-day trend → design class (.trend.up/.down/.flat). */
export const trendCls = (t: number) => (t > 0.5 ? "up" : t < -0.5 ? "down" : "flat");

// Categories: the API only sends the name. Color (hue) and icon live here, with a stable fallback for new ones.
const CATEGORY_STYLE: Record<string, { hue: number; icon: IconName }> = {
  Desenvolvimento: { hue: 250, icon: "code" },
  "Front-end": { hue: 250, icon: "code" },
  "Back-end": { hue: 215, icon: "server" },
  Design: { hue: 300, icon: "pen" },
  Jurídico: { hue: 60, icon: "scale" },
  Viagens: { hue: 195, icon: "plane" },
  "Dia a dia": { hue: 25, icon: "list-check" },
  Finanças: { hue: 150, icon: "coin" },
  Escrita: { hue: 345, icon: "mail" },
  Carreira: { hue: 95, icon: "briefcase" },
  Estudos: { hue: 275, icon: "grad" },
  Dados: { hue: 175, icon: "database" },
  Negócios: { hue: 120, icon: "chart" },
};

function hashHue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Hue (0..360) of the category, for the .tile (style={{"--h": hue}}). */
export const hue = (category: string) => CATEGORY_STYLE[category]?.hue ?? hashHue(category);
/** Category icon (fallback: "spark"). */
export const categoryIcon = (category: string): IconName => CATEGORY_STYLE[category]?.icon ?? "spark";

/** SVG path of a line (sparkline) inside w x h. */
export function spark(series: number[], w: number, h: number): string {
  if (series.length < 2) return `M0 ${h / 2} L${w} ${h / 2}`;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pad = 3;
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Saves a text as a file (Blob) in the browser. */
export function saveTextFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.split("/").pop() || "arquivo.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// Formatters per language.

export type T = ((key: string, values?: Record<string, string | number>) => string) & { has?: (key: string) => boolean };

// Fixed time zone per language: the server (SSR) and the browser format the same way, with no hydration error.
const TIME_ZONE: Record<Locale, string> = { en: "UTC", pt: "America/Sao_Paulo" };

const LEVEL_TONE: Record<RepLevel["key"], RepTone> = { ref: "ok", trust: "ok", grow: "brand", new: "soft", low: "warn" };
const levelKey = (score: number): RepLevel["key"] =>
  score >= 95 ? "ref" : score >= 90 ? "trust" : score >= 80 ? "grow" : score >= 60 ? "new" : "low";
/** "Jurídico" -> "juridico", "Dia a dia" -> "dia_a_dia" (key in format.json -> categories). */
const categoryKey = (c: string) =>
  c.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();

export function makeFormat(locale: Locale, t: T) {
  const intl = INTL_LOCALE[locale];
  const num = (n: number, min: number, max = min) =>
    Number(n).toLocaleString(intl, { minimumFractionDigits: min, maximumFractionDigits: max });
  const datePart = new Intl.DateTimeFormat(intl, { timeZone: TIME_ZONE[locale], day: "numeric", month: "short", year: "numeric" });
  const dateTimePart = new Intl.DateTimeFormat(intl, { timeZone: TIME_ZONE[locale], dateStyle: "short", timeStyle: "short" });
  const timePart = new Intl.DateTimeFormat(intl, { timeZone: TIME_ZONE[locale], hour: "2-digit", minute: "2-digit" });

  return {
    locale,
    /** Number with fixed decimals in the language (1,234.50 / 1.234,50). */
    num,
    /** Display-only local price from a stablecoin amount. pt: BRL by the rate ("R$ 129,90"); en: dollars ("$24.99"). */
    brl: (amount: number, rate: number) => (locale === "pt" ? `R$ ${num(amount * rate, 2)}` : `$${num(amount, 2)}`),
    /** Same as brl, rounded without cents (cards). */
    brl0: (amount: number, rate: number) =>
      locale === "pt" ? `R$ ${num(Math.round(amount * rate), 0)}` : `$${num(Math.round(amount), 0)}`,
    /** Amount already in BRL (e.g. AgentDetail.priceBrl). Only meaningful in pt. */
    brlValue: (reais: number, digits = 2) => `R$ ${num(reais, digits)}`,
    /** Basis points as a percentage: 500 -> "5%", 750 -> "7.5%". */
    bpsPct: (bps: number) => `${num(bps / 100, 0, 2)}%`,
    int: (n: number) => Number(n).toLocaleString(intl),
    dec1: (n: number) => num(n, 1),
    /** Signed change: "+3.2%", "−1.0%". */
    pct: (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${num(Math.abs(n), 1)}%`,
    /** "Sep 30, 2026" / "30 de set. de 2026". */
    date: (iso: string) => datePart.format(new Date(iso)),
    /** Short date and time (tooltips, histories). */
    dateTime: (iso: string | number | Date) => dateTimePart.format(new Date(iso)),
    /** "14:05" / "02:05 PM". */
    time: (iso: string | number | Date) => timePart.format(new Date(iso)),
    /** "3 days ago", "yesterday"... Depends on the clock: in a server component, use <Ago iso />. */
    ago: (iso: string, now = Date.now()) => {
      const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
      const d = Math.floor(s / 86400);
      if (d >= 60) return t("ago.months", { n: Math.floor(d / 30) });
      if (d >= 2) return t("ago.days", { n: d });
      if (d === 1) return t("ago.yesterday");
      const h = Math.floor(s / 3600);
      if (h >= 1) return t("ago.hours", { n: h });
      return t("ago.justNow");
    },
    /** Countdown to `iso` (e.g. autoReleaseAt). */
    countdown: (iso: string, now = Date.now()): Countdown => {
      const ms = new Date(iso).getTime() - now;
      if (ms <= 0) return { text: t("countdown.releasing"), clock: "00:00:00", h: 0, m: 0, s: 0, urgent: true, done: true };
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const pad = (x: number) => (x < 10 ? `0${x}` : `${x}`);
      return { text: t("countdown.text", { h, m: pad(m) }), clock: `${pad(h)}:${pad(m)}:${pad(sec)}`, h, m, s: sec, urgent: h < 24, done: false };
    },
    /** Reputation level (0..100) with the design's text and tone. */
    repLevel: (score: number): RepLevel => {
      const key = levelKey(score);
      return { key, label: t(`rep.${key}`), tone: LEVEL_TONE[key] };
    },
    /** Reputation bands ("Reputation levels" table). */
    repLevels: () => REP_LEVELS.map((l) => ({ ...l, name: t(`rep.${l.key}`), range: t(`repRange.${l.key}`) })),
    /** Buyer guarantee level (getMyGuarantee().level). */
    guaranteeLevel: (level: "none" | "limited" | "full") => t(`guaranteeLevel.${level}`),
    /** Readable duration: "2 minutes", "48 hours", "3 days" (days only from 2 on, when exact). */
    durationText: (secs: number) => {
      if (secs >= 172800 && secs % 86400 === 0) return t("duration.days", { n: secs / 86400 });
      if (secs >= 3600) return t("duration.hours", { n: Math.round(secs / 3600) });
      return t("duration.minutes", { n: Math.max(1, Math.round(secs / 60)) });
    },
    /** File size: "1.5 MB", "300 KB". */
    fileSize: (bytes: number) =>
      bytes >= 1024 * 1024 ? `${num(bytes / (1024 * 1024), 0, 1)} MB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(intl)} KB`,
    /**
     * Display name of the category. The API sends the name in Portuguese ("Desenvolvimento"); the translation lives in
     * format.json -> categories.<key without accents>; without a translation, the name is shown as received.
     */
    categoryLabel: (category: string) => {
      const key = `categories.${categoryKey(category)}`;
      return t.has?.(key) ? t(key) : category;
    },
    /** Connector name without the "(opcional)"/"(optional)" some manifests put in the label. */
    connectorName: (label: string) => label.replace(/\s*\((opcional|optional)\)\s*$/i, "").trim() || label,
  };
}

export type Format = ReturnType<typeof makeFormat>;

/** Formatters in the page language (client component or synchronous server component). */
export function useFormat(): Format {
  const locale = useLocale() as Locale;
  const t = useTranslations("format");
  return makeFormat(locale, t as unknown as T);
}
