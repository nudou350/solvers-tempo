import type { Mount } from "./app.js";
import { env } from "./env.js";
import { jobs } from "./jobs.js";
import { agentPayRouter } from "./agent-pay/routes.js";
import { creatorRouter } from "./creator/routes.js";
import { onGovernanceChange } from "./indexer/index.js";
import { mountMcp } from "./mcp/routes.js";
import { mountOAuth } from "./oauth/routes.js";
import { initPayments, setEscrowPlanner } from "./payments/index.js";
import { publishRouter } from "./publish/routes.js";
import { solanaPayRouter } from "./solana-pay/routes.js";
import { invalidateConfigCache } from "./store/chain-reads.js";
import { creatorTxRouter } from "./store/creator-tx.js";
import { escrowRouter, planEscrowPurchase } from "./store/escrow.js";
import { helpRouter } from "./store/help.js";
import { imagesRouter } from "./store/images.js";
import { meRouter } from "./store/me.js";
import { mountPreview } from "./verifier/preview.js";

// Single place where modules register with the app (extra routes, cross-module hooks and periodic jobs).

export const mounts: Mount[] = [
  mountOAuth,
  mountMcp,
  mountPreview,
  (app) => {
    app.use("/api", escrowRouter);
    app.use("/api", creatorTxRouter);
    app.use("/api", imagesRouter);
    app.use("/api", helpRouter);
    app.use("/api", meRouter);
    app.use("/api", creatorRouter);
    app.use("/api", publishRouter);
    // Solana Pay (USDC on Solana), next to Pix (app.ts): mounted always; with SOLANA_PAY_ENABLED off, creating answers 400.
    app.use("/api", solanaPayRouter);
    // Agent purchases over HTTP 402 (MPP): only with AGENT_PAY_ENABLED; off, the routes answer 404 (rollback = flag off).
    if (env.AGENT_PAY_ENABLED) app.use("/api", agentPayRouter);
  },
];

let unsubscribe: (() => void) | null = null;

/**
 * Cross-module hooks installed once at boot: payment providers, guarantee planning for purchase intents and Pix (store → payments), and the
 * Registry config/pause cache dropped on every `PauseChanged` / `ConfigUpdated` the indexer sees.
 */
export function installHooks(): void {
  initPayments();
  setEscrowPlanner(planEscrowPurchase);
  unsubscribe ??= onGovernanceChange((c) => {
    if (c.name === "PauseChanged" || c.name === "ConfigUpdated") invalidateConfigCache();
  });
}

export function startJobs(): void {
  for (const j of jobs) j.start();
}

export function stopJobs(): void {
  for (const j of jobs) j.stop();
  unsubscribe?.();
  unsubscribe = null;
}
