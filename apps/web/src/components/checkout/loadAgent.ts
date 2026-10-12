// Server-side loading of a Solver (and the public config) for the checkout, done and install routes.
import type { AgentDetail, PublicConfig } from "@solvers/api-client";
import { getLocale } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import { ApiError, serverApi } from "@/lib/api";

export type LoadError = "not_found" | "unavailable";
export type LoadedAgent = { detail: AgentDetail | null; error: LoadError | null };

export async function loadAgent(slug: string | null): Promise<LoadedAgent> {
  if (!slug) return { detail: null, error: "not_found" };
  try {
    // Solver texts in the page language (name, description, requirements).
    const lang = (await getLocale()) as Locale;
    return { detail: await serverApi().getAgent(slug, lang), error: null };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { detail: null, error: "not_found" };
    return { detail: null, error: "unavailable" };
  }
}

/** Public config (payment token, Pix, connector URL...); null when the API is down. */
export async function loadConfig(): Promise<PublicConfig | null> {
  try {
    return await serverApi().getConfig();
  } catch {
    return null;
  }
}
