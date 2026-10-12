// Expected price texts, computed here from on-chain base units with plain bigint arithmetic (never with the web app's
// own formatter), so a wrong number on the page cannot pass by sharing the bug.

/** 19_000_000n -> "19.00" (en-US) / "19,00" (pt-BR); `fixed2` false drops ".00" from whole amounts. */
export function unitsText(units: bigint, locale: "en" | "pt", fixed2: boolean): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const intText = whole.toLocaleString(locale === "en" ? "en-US" : "pt-BR");
  const fracText = frac === "" ? (fixed2 ? "00" : "") : frac.padEnd(2, "0");
  return fracText ? `${intText}${locale === "en" ? "." : ","}${fracText}` : intText;
}

/** "$19.00": the en price of a Solver page. */
export const usd = (units: bigint) => `$${unitsText(units, "en", true)}`;

/** "19 USD" / "5,5 USD": an amount in the payment token. */
export const token = (units: bigint, symbol: string, locale: "en" | "pt") => `${unitsText(units, locale, false)} ${symbol}`;
