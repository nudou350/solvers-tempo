import type { CSSProperties } from "react";

/**
 * style with the design's --gap variable (.row/.col), plus other optional properties.
 * Number = pixels (`gap(12)`); text is passed as is (`gap("6px 10px")`).
 */
export const gap = (g: number | string, extra?: CSSProperties): CSSProperties =>
  ({ "--gap": typeof g === "number" ? `${g}px` : g, ...extra }) as CSSProperties;
