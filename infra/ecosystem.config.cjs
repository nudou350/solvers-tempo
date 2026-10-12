// PM2 apps of Solvers on Tempo (D13; VPS_GUIDE conventions: /var/www/<project>, <project>-api / <project>-web names,
// logs in /var/www/<project>/logs). Ports: API 3018 and web 4018, both bound to 127.0.0.1 (only nginx is public).
// Check they are still free on the server before the first start (VPS_GUIDE section 2):
//   ss -tln | grep -oE '127.0.0.1:[34][0-9]{3}|\*:[34][0-9]{3}' | sort -u
// `backend`, `frontend` and `app` are symlinks to the active release, switched by infra/deploy.sh. A change to an app
// block here needs `pm2 delete <name>` + `pm2 start <this file> --only <name>`: `pm2 reload` does not re-read it.
const APP = "/var/www/solvers-tempo";

const common = {
  instances: 1,
  exec_mode: "fork",
  time: true,
  merge_logs: true,
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
};

module.exports = {
  apps: [
    {
      // API + MCP + OAuth + webhooks + jobs + indexer. Exactly ONE instance: the MPP replay protection and the nonce-lane
      // queues live in memory. The server always listens on 127.0.0.1 (apps/server/src/index.ts); HOST is informative.
      // backend/.env is a symlink to shared/.env (deploy.sh); variables set here win over the file.
      ...common,
      name: "solvers-tempo-api",
      script: "./dist/index.js",
      cwd: `${APP}/backend`,
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production", PORT: 3018, HOST: "127.0.0.1" },
      error_file: `${APP}/logs/backend-err.log`,
      out_file: `${APP}/logs/backend-out.log`,
      log_file: `${APP}/logs/backend-combined.log`,
      // Local embeddings (transformers.js) take ~300 MB.
      max_memory_restart: "900M",
      // Time to finish in-flight requests and journal sent transactions on SIGTERM (deploy/reload).
      kill_timeout: 10000,
    },
    {
      // Web app (Next.js `next start` through start.mjs). nginx sends / to 4018 and the API routes to 3018.
      // NEXT_PUBLIC_* are inlined at build time from shared/web.env (deploy.sh); API_INTERNAL_URL is read at runtime by
      // server components.
      ...common,
      name: "solvers-tempo-web",
      script: "./start.mjs",
      cwd: `${APP}/frontend`,
      env: { NODE_ENV: "production", PORT: 4018, HOSTNAME: "127.0.0.1", API_INTERNAL_URL: "http://127.0.0.1:3018" },
      error_file: `${APP}/logs/frontend-err.log`,
      out_file: `${APP}/logs/frontend-out.log`,
      log_file: `${APP}/logs/frontend-combined.log`,
      max_memory_restart: "500M",
    },
    {
      // Creator submissions worker (PACKAGE_SPEC.md 16): extracts the ZIP, validates, scans and ingests knowledge, one
      // ingestion at a time with a checkpoint. No HTTP and no chain keys. Kept out of the API so it never competes with
      // MCP and payments. PM2 has no nice option, so infra/worker-run.sh does `exec nice -n 10 node ...`.
      ...common,
      name: "solvers-tempo-worker",
      script: `${APP}/app/infra/worker-run.sh`,
      interpreter: "bash",
      cwd: `${APP}/backend`,
      // No WORKER_NODE here: worker-run.sh resolves node when it starts (the PM2 daemon's node), so a saved process list
      // never points at a removed Node install.
      env: { NODE_ENV: "production", ORT_NUM_THREADS: "1", WORKER_NICE: "10" },
      error_file: `${APP}/logs/worker-err.log`,
      out_file: `${APP}/logs/worker-out.log`,
      log_file: `${APP}/logs/worker-combined.log`,
      max_memory_restart: "900M",
      // Time to finish the current file and write the checkpoint on SIGTERM (the job resumes from it).
      kill_timeout: 20000,
    },
  ],
};
