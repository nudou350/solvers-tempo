import { networkLabel } from "@solvers/chain";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { initChain } from "./chain/index.js";
import { reconcileSentTxs } from "./chain/lanes.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/index.js";
import { installHooks, mounts, startJobs, stopJobs } from "./modules.js";
import { warmEmbeddings } from "./knowledge/embeddings.js";
import { packages } from "./runtime/packages.js";

async function main() {
  await runMigrations();
  // Boot validation (chain id, token decimals, contract code, treasury, roles): any problem refuses to start.
  const chain = await initChain({ validate: true });
  console.log(
    `[chain] ${networkLabel(env.CHAIN_ID)} (chain ${env.CHAIN_ID}) registry ${chain.deployment.registry} platform ${chain.accounts.platform.address} relay ${chain.accounts.relay.address}`,
  );
  // Settle server transactions left pending by a previous run before anything sends on the nonce lanes.
  await reconcileSentTxs().catch((e: unknown) => console.error("[chain] sent_txs reconcile failed:", (e as Error).message));

  const pkgCount = new Set([...packages().values()].map((p) => p.manifest.id)).size;
  console.log(`[runtime] ${pkgCount} Solver packages loaded`);
  warmEmbeddings();

  installHooks();
  const app = createApp(mounts);
  const server = app.listen(env.PORT, "127.0.0.1", () => {
    console.log(`[server] listening on 127.0.0.1:${env.PORT} (${env.PUBLIC_API_URL})`);
  });

  // The indexer runs as one of the jobs (indexerJob), like payments and the store's jobs.
  startJobs();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[server] ${signal}, shutting down`);
    stopJobs();
    // Stop accepting connections; idle keep-alive sockets do not hold the exit for more than 5 s.
    await Promise.race([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => setTimeout(r, 5000))]);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[server] failed to start", e);
  process.exit(1);
});
