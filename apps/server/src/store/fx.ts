import { env } from "../env.js";

// USD -> BRL quote: shows the "equivalent in reais" and prices Pix charges (the payment token is a USD stablecoin).
// Cached for 1 h; when the public API fails, BRL_PER_USD from env is used (and retried after 5 min).

export type FxQuote = { rate: number; source: "awesomeapi" | "env" };

let cached: { quote: FxQuote; at: number } | null = null;
const TTL_MS = 3600_000;

export async function brlQuote(): Promise<FxQuote> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.quote;
  try {
    const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL", { signal: AbortSignal.timeout(3000) });
    // AwesomeAPI quotes `bid` (what a dealer pays for USD) and `ask` (what it charges to sell USD). The buyer pays BRL for a
    // USD stablecoin, i.e. the platform sells USD, so the price is the `ask` side (`bid` only if `ask` is missing).
    const json = (await res.json()) as { USDBRL?: { bid?: string; ask?: string } };
    const rate = Number(json.USDBRL?.ask ?? json.USDBRL?.bid);
    if (Number.isFinite(rate) && rate > 1 && rate < 20) {
      cached = { quote: { rate, source: "awesomeapi" }, at: Date.now() };
      return cached.quote;
    }
  } catch {
    /* fall back to env */
  }
  cached = { quote: { rate: env.BRL_PER_USD, source: "env" }, at: Date.now() - TTL_MS + 300_000 };
  return cached.quote;
}

export async function brlPerUsd(): Promise<number> {
  return (await brlQuote()).rate;
}

/** Test hook: fixes the quote (null clears the cache). */
export function setFxQuoteForTests(quote: FxQuote | null): void {
  cached = quote ? { quote, at: Date.now() } : null;
}
