#!/usr/bin/env bash
# Start command of solvers-tempo-worker (PM2 runs it with interpreter "bash"; cwd = /var/www/solvers-tempo/backend).
# PM2 does not apply nice; `exec` keeps the node PID, so PM2's SIGTERM reaches the worker directly.
# Low priority (nice 10) so extraction/ingestion never competes with the API and MCP on the shared 2 vCPU.
set -euo pipefail
# Node is resolved at every start, never frozen in PM2's saved list: WORKER_NODE if set, else the node running the PM2
# daemon (this script's parent, the same node as the API and web apps, also after a reboot without the login PATH),
# else the first node on PATH.
node_bin=${WORKER_NODE:-}
if [ -z "$node_bin" ] && [ -r "/proc/$PPID/exe" ]; then
  parent=$(readlink -f "/proc/$PPID/exe" 2>/dev/null || true)
  case "$parent" in */node) node_bin=$parent ;; esac
fi
node_bin=${node_bin:-$(command -v node || true)}
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "worker-run.sh: no node binary found (set WORKER_NODE in the ecosystem env or put node on PATH)" >&2
  exit 1
fi
exec nice -n "${WORKER_NICE:-10}" "$node_bin" --env-file=.env ./dist/worker/index.js
