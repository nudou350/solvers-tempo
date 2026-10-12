// Honest labels of the eval score (PACKAGE_SPEC.md §12.2/§20). Every score today comes from an internal team test
// (automated checks): "verified" would only apply to an evalMethod "verified", which does not exist. No score
// (0/missing) = not rated yet; a score measured for another version reads as not measured (decisions.md D6).
// Texts in messages/<locale>/errors.json (eval.*). Without `locale`, the page language in the browser applies; a
// server component must pass the page `locale`.
import type { Locale } from "@/i18n/routing";
import { localText } from "./local-text";

/** Is there an eval score? (0, null or invalid = not rated yet.) */
export function hasEvalScore(score: number | null | undefined): score is number {
  return typeof score === "number" && Number.isFinite(score) && score > 0;
}

/** "82% in internal tests" / "82% nos testes internos", or "No reviews yet" / "Sem avaliações ainda". */
export function evalShort(score: number | null | undefined, locale?: Locale): string {
  return hasEvalScore(score) ? localText("eval.short", { score: Math.round(score) }, locale) : localText("eval.none", undefined, locale);
}

/** Long sentence for details and tooltips, in the page language. */
export function evalMethodNote(locale?: Locale): string {
  return localText("eval.note", undefined, locale);
}
