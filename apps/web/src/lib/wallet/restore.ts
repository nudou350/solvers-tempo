// Which wallet source to restore on page load when a build offers both Privy and the dev wallet. No React (unit-tested).
import { sameAddress } from "@solvers/shared";
import type { WalletKind } from "./types";

/**
 * Restore decision from the restored addresses of each source and, when both exist, the server session's wallet
 * (`/api/auth/me`; `undefined` = not asked yet, `null` = no session). The source whose address IS the session wallet
 * wins, so the relay (which sponsors only the session wallet) and the screens agree; without a session, Privy (the
 * default sign-in) wins. `"ask-session"`: both exist and the session was not read yet.
 */
export function restoreChoice(c: { privy: string | null; dev: string | null; session?: string | null }): WalletKind | "ask-session" | null {
  if (c.privy && !c.dev) return "privy";
  if (c.dev && !c.privy) return "dev";
  if (!c.privy || !c.dev) return null;
  if (c.session === undefined) return "ask-session";
  return sameAddress(c.session, c.dev) && !sameAddress(c.session, c.privy) ? "dev" : "privy";
}
