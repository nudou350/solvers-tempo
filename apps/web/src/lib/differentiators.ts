import type { IconName } from "@/components/ui/Icon";
import type { Locale } from "@/i18n/routing";
import { localText } from "./local-text";

// Proven differentiators of a Solver (PACKAGE_SPEC.md 4.2 and 20), in plain language. Unknown values (a new
// differentiator on the server) are ignored instead of showing raw. Texts in messages/<locale>/errors.json
// (differentiators.<key>.label|text); only the icons live here. The map's `label` and `text` follow the page
// language in the browser; in a server component use the functions with `locale`.
const ICONS: Record<string, IconName> = {
  memory: "history",
  escalation: "message",
  liveData: "refresh",
  tool: "wrench",
  verifier: "shield-check",
};

export const DIFFERENTIATORS: Record<string, { readonly label: string; readonly text: string; icon: IconName }> = Object.fromEntries(
  Object.entries(ICONS).map(([k, icon]) => [
    k,
    {
      icon,
      get label() {
        return localText(`differentiators.${k}.label`);
      },
      get text() {
        return localText(`differentiators.${k}.text`);
      },
    },
  ]),
);

export function differentiatorLabel(key: string, locale?: Locale): string {
  return key in ICONS ? localText(`differentiators.${key}.label`, undefined, locale) : key;
}

/** Short sentence of the differentiator in the given language (empty when the storefront does not know the key). */
export function differentiatorText(key: string, locale?: Locale): string {
  return key in ICONS ? localText(`differentiators.${key}.text`, undefined, locale) : "";
}

/** Only the differentiators the storefront can name, in the order they came. */
export function knownDifferentiators(keys: readonly string[]): string[] {
  return keys.filter((k) => k in ICONS);
}
