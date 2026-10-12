import { PixIntermediatedProvider } from "../pix/provider.js";
import { SolanaPayProvider } from "../solana-pay/provider.js";
import { DirectWalletProvider } from "./providers/direct-wallet.js";
import { FiatOnrampProvider, PixMarketplaceSplitProvider } from "./providers/stubs.js";
import { getProvider, registerProvider } from "./registry.js";
import { installSaleHook } from "./sale-hook.js";

// Boot of the payments module: registers the providers and installs the `SaleAuthorized` handler the indexer calls.
// Idempotent; routes.ts calls it on import so mounting the router is enough.

let ready = false;

export function initPayments(): void {
  if (ready) return;
  registerProvider(new DirectWalletProvider());
  registerProvider(new PixIntermediatedProvider());
  // Always registered so the reconcile job finishes open charges even after SOLANA_PAY_ENABLED is turned off; new
  // charges are refused while it is off.
  registerProvider(new SolanaPayProvider());
  registerProvider(new PixMarketplaceSplitProvider());
  registerProvider(new FiatOnrampProvider());
  // agent-pay registers itself when its router is mounted (src/agent-pay/routes.ts, only with AGENT_PAY_ENABLED).
  installSaleHook();
  ready = true;
}

export const directWallet = () => getProvider<DirectWalletProvider>("direct-wallet");
export const pixProvider = () => getProvider<PixIntermediatedProvider>("pix-intermediated");
export const solanaPayProvider = () => getProvider<SolanaPayProvider>("solana-pay");

export { registerProvider, getProvider, reconcileAll } from "./registry.js";
export { handleSaleAuthorized } from "./sale-hook.js";
export { preparePurchase } from "./intent.js";
export { setEscrowPlanner, type EscrowPlanner, type EscrowPlan } from "./escrow-plan.js";
