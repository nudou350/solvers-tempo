import { env } from "../env.js";
import { forbidden } from "../lib/http.js";
import { isAdminIn } from "./admin-rules.js";

// Is the authenticated wallet a site admin? (ADMIN_WALLETS; rule in admin-rules.ts.)

export const isAdminWallet = (wallet: string): boolean => isAdminIn(wallet, env.ADMIN_WALLETS);

export function requireAdminWallet(wallet: string): void {
  if (!isAdminWallet(wallet)) throw forbidden("Only the team can do this");
}
