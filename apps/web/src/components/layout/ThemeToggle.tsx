"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";

export type Theme = "light" | "dark";
export const THEME_KEY = "solvers.theme";

/**
 * Script that runs before paint (at the start of <body>): applies the saved theme, or the system one,
 * so the wrong theme never flashes. Kept small and dependency-free.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.body.setAttribute("data-theme",t)}catch(e){}})();`;

export function setTheme(t: Theme) {
  document.body.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* no localStorage: applies to this tab only */
  }
}

/** Sun/moon button in the header. Persists the choice in localStorage. */
export function ThemeToggle() {
  const t = useTranslations("common.theme");
  const [theme, setState] = useState<Theme | null>(null);
  useEffect(() => {
    // Follows the <body> attribute, so it stays right if something else changes the theme.
    const read = () => setState(document.body.getAttribute("data-theme") === "dark" ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={dark ? t("useLight") : t("useDark")}
      title={dark ? t("useLight") : t("useDark")}
      onClick={() => {
        const next: Theme = dark ? "light" : "dark";
        setTheme(next);
        setState(next);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
