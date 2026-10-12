// Labels of the eval score in the page language, from the catalog namespace (lib/eval-label.ts reads errors.json).
// Project rule: the score is an "internal team test", never "verified".
import { useTranslations } from "next-intl";
import { hasEvalScore } from "@/lib/eval-label";

type Tr = (key: string, values?: Record<string, string | number>) => string;

/** Short text ("82% on internal tests" / "No ratings yet") from a translator of the catalog namespace. */
export function evalShortWith(t: Tr, score: number | null | undefined): string {
  return hasEvalScore(score) ? t("eval.short", { score: Math.round(score) }) : t("eval.none");
}

export function useEvalText(): { short: (score: number | null | undefined) => string; note: string } {
  const t = useTranslations("catalog") as unknown as Tr;
  return { short: (score) => evalShortWith(t, score), note: t("eval.note") };
}
