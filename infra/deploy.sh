#!/usr/bin/env bash
# Deploy of Solvers on Tempo to the VPS. RUN MANUALLY BY THE OWNER, from the repository root of a trusted machine (or
# through the manual-only .github/workflows/deploy.yml). It is NEVER run by CI automatically: no push, merge or schedule
# triggers it, and without --yes it only prints what it would do.
#
#   DEPLOY_HOST=deploy@<vps> bash infra/deploy.sh          # dry-run: checks the local side and prints the plan
#   DEPLOY_HOST=deploy@<vps> bash infra/deploy.sh --yes    # deploys the current commit to the VPS (DEPLOY_HOST required)
#
# Before the first run, follow infra/README.md (directories, database, shared/.env and shared/web.env, nginx, TLS) and
# have the contracts deployed with deployments/<CHAIN_ID>.json committed (docs/deploy-runbook.md).
#
# What it does: ships the commit (git archive, never the working tree), installs, builds the API and the web app,
# rebuilds the verifier image, runs the database migrations from the new release (backward compatible: the old release
# is still serving), switches the symlinks, reloads the three PM2 processes and watches them for ~30 s. Any failure after
# the switch rolls back to the previous release automatically. It does not touch nginx, certificates or the database
# schema beyond the migrations.
set -euo pipefail
HOST=${DEPLOY_HOST:?set DEPLOY_HOST=deploy@<vps>}
APP=/var/www/solvers-tempo
SHA=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain -- apps packages agents infra deployments contracts/src scripts)" ]; then
  echo "warning: uncommitted changes are NOT deployed; only commit $SHA is shipped." >&2
fi
CHAIN_FILES=$(git ls-tree --name-only HEAD deployments/ | grep -E '/[0-9]+\.json$' | grep -v '/31337.json$' || true)
[ -n "$CHAIN_FILES" ] || { echo "no deployments/<chainId>.json for a public network in this commit" >&2; exit 1; }

if [ "${1:-}" != "--yes" ]; then
  cat <<PLAN
Dry-run (nothing was sent). With --yes this would:
  1. ship commit $SHA to $HOST:$APP/releases/$SHA
  2. pnpm install, build the packages, the API and the web app (NEXT_PUBLIC_* from $APP/shared/web.env)
  3. docker build the verifier image, run migrations against the database in $APP/shared/.env
  4. switch app/backend/frontend/agents to the new release and reload solvers-tempo-api, -web and -worker
  5. health-check 127.0.0.1:3018/health and 127.0.0.1:4018 for ~30 s; roll back on failure
Deployments in this commit: $(echo $CHAIN_FILES | tr '\n' ' ')
PLAN
  exit 0
fi

echo "> shipping $SHA"
git archive --format=tar HEAD | ssh "$HOST" "set -e; mkdir -p $APP/releases/$SHA && tar -x -C $APP/releases/$SHA"

ssh "$HOST" bash -s -- "$SHA" <<'REMOTE'
set -euo pipefail
SHA=$1
APP=${APP_DIR:-/var/www/solvers-tempo}   # APP_DIR only exists for local simulation; on the VPS the default applies
REL=$APP/releases/$SHA
API_PORT=3018
WEB_PORT=4018
PROCS=(solvers-tempo-api solvers-tempo-web solvers-tempo-worker)
HEALTH_TRIES=${HEALTH_TRIES:-15}         # 15 x 2 s = ~30 s of observation
HEALTH_INTERVAL=${HEALTH_INTERVAL:-2}
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
command -v pnpm >/dev/null || corepack enable pnpm

envval() { grep -E "^$1=" "$APP/shared/.env" | tail -n 1 | cut -d= -f2- || true; }
webval() { grep -E "^$1=" "$APP/shared/web.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

# ---- 1. Prepare the new release (nothing here touches what is live) ----
cd "$REL"
[ -f "$APP/shared/.env" ] || { echo "x $APP/shared/.env is missing (infra/README.md, step 3)" >&2; exit 1; }
ln -sfn "$APP/shared/.env" apps/server/.env
# Creator data and deliverables live in shared/, outside any release, so release cleanup never deletes them.
mkdir -p "$APP/shared/submissions" "$APP/shared/packages" "$APP/shared/deliverables"
chmod 700 "$APP/shared/submissions" "$APP/shared/packages" "$APP/shared/deliverables"
# Without these the server would write under ./data inside the release, which this script deletes later.
for V in SUBMISSIONS_DIR PUBLISHED_DIR DELIVERABLES_DIR AGENTS_DIR CHAIN_ID DATABASE_URL; do
  [ -n "$(envval $V)" ] || { echo "x $V is not set in $APP/shared/.env (see infra/.env.example)" >&2; exit 1; }
done
[ -z "$(envval PORT)" ] || [ "$(envval PORT)" = "$API_PORT" ] || { echo "x PORT in shared/.env must be $API_PORT" >&2; exit 1; }
CHAIN_ID=$(envval CHAIN_ID)
[ -n "$(envval DEPLOYMENTS_FILE)" ] || [ -f "deployments/$CHAIN_ID.json" ] \
  || { echo "x deployments/$CHAIN_ID.json is not in this release (CHAIN_ID=$CHAIN_ID)" >&2; exit 1; }
[ "$(webval NEXT_PUBLIC_CHAIN_ID)" = "$CHAIN_ID" ] \
  || { echo "x NEXT_PUBLIC_CHAIN_ID in shared/web.env must equal CHAIN_ID ($CHAIN_ID)" >&2; exit 1; }
[ -n "$(envval ADMIN_WALLETS)" ] || echo "! ADMIN_WALLETS is empty: nobody can review submissions on the site" >&2

pnpm install --frozen-lockfile --prod=false >/dev/null
# pnpm runs filtered builds in dependency order. The contracts client is built from its committed generated files: the
# VPS needs no Foundry.
pnpm --filter @solvers/shared --filter @solvers/contracts-client --filter @solvers/chain --filter @solvers/api-client \
  --filter @solvers/server build
# Web: NEXT_PUBLIC_* are inlined at build time, from shared/web.env.
( set -a; . "$APP/shared/web.env"; set +a; pnpm --filter @solvers/web build )
# Guarantee verifier image (cached layers: only rebuilt when the harness changes). Skipped in simulated mode.
if [ "$(envval VERIFIER_MODE)" != simulated ]; then
  IMAGE=$(envval VERIFIER_IMAGE); IMAGE=${IMAGE:-solvers-tempo-react-test}
  docker build -q -t "$IMAGE" "$REL/agents/frontend-react/verifier" >/dev/null
  echo "ok verifier image $IMAGE"
fi
# Migrations from the new release. The database is shared with the release still serving, so every migration must be
# backward compatible (additive only).
( cd "$REL/apps/server" && node --env-file=.env dist/db/migrate.js )

# ---- 2. Activate, with automatic rollback ----
pm2_info() { # pm2_info <process> <restart_time|status>
  pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const line = s.split("\n").filter((l) => l.startsWith("[")).pop() || "[]";
      const p = JSON.parse(line).find((x) => x.name === process.argv[1]);
      console.log(p ? p.pm2_env[process.argv[2]] : "");
    });' "$1" "$2"
}

swap_link() { # atomic switch: swap_link <name> <target>
  ln -sfn "$2" "$APP/.$1.new" && mv -T "$APP/.$1.new" "$APP/$1"
}

activate() { # activate <release>
  swap_link app "$1"
  swap_link backend "$APP/app/apps/server"
  swap_link frontend "$APP/app/apps/web"
  swap_link agents "$APP/app/agents"
  cp "$APP/app/infra/manifest.json" "$APP/manifest.json"
}

reload_all() {
  cd "$APP"
  for P in "${PROCS[@]}"; do
    if pm2 describe "$P" >/dev/null 2>&1; then
      if [ "$(pm2_info "$P" status)" = online ]; then pm2 reload "$P" --update-env; else pm2 restart "$P" --update-env; fi
    else
      pm2 start app/infra/ecosystem.config.cjs --only "$P"
    fi
  done
}

# Reloading the single API process drops open connections, including a ZIP upload in progress (the creator re-sends).
# Wait (up to UPLOAD_WAIT s) while a SUBMISSIONS_DIR/<id>/package.zip* was written in the last 10 s, then go anyway.
wait_for_uploads() {
  local waited=0 dir="$APP/shared/submissions"
  while [ "$waited" -lt "${UPLOAD_WAIT:-120}" ] && [ -n "$(find "$dir" -type f -name 'package.zip*' -newermt '10 seconds ago' 2>/dev/null | head -n 1)" ]; do
    [ "$waited" -eq 0 ] && echo "... upload in progress in $dir; waiting up to ${UPLOAD_WAIT:-120}s before reloading"
    sleep 5; waited=$((waited + 5))
  done
}

PREV=$(readlink -f "$APP/app" 2>/dev/null || true)
SWITCHED=0
DONE=0

rollback() {
  set +e
  trap - EXIT
  echo "x deploy of $SHA failed after the switch" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    echo "< rolling back to $(basename "$PREV")" >&2
    activate "$PREV"
    reload_all
    echo "< rollback done; release $SHA stays in $REL for diagnosis" >&2
  else
    echo "No previous release to restore; check 'pm2 logs solvers-tempo-api'." >&2
  fi
  exit 1
}
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$SWITCHED" -eq 1 ] && [ "$DONE" -eq 0 ]; then rollback; fi
  exit "$rc"
}
trap on_exit EXIT

wait_for_uploads
SWITCHED=1
activate "$REL"
reload_all

# ---- 3. Health check (~30 s): answers, does not restart by itself, stays online ----
# The worker serves no HTTP: it only has to stay online without a crash loop.
declare -A BASE
for P in "${PROCS[@]}"; do BASE[$P]=$(pm2_info "$P" restart_time); done
streak=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  sleep "$HEALTH_INTERVAL"
  for P in "${PROCS[@]}"; do
    [ "$(pm2_info "$P" restart_time)" = "${BASE[$P]}" ] || { echo "x $P restarted by itself after the reload (crash loop)" >&2; exit 1; }
  done
  if curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 \
    && curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then
    streak=$((streak + 1))
  else
    streak=0
  fi
done
if [ "$streak" -lt 3 ]; then echo "x health check did not stabilise (consecutive ok: $streak)" >&2; exit 1; fi
for P in "${PROCS[@]}"; do
  [ "$(pm2_info "$P" status)" = "online" ] || { echo "x $P is not online" >&2; exit 1; }
done
echo "ok ${PROCS[*]} online ($SHA)"

DONE=1
pm2 save >/dev/null

# ---- 4. Cleanup: keep the active release, the previous one and the newest of the rest ----
KEEP=(-e "$SHA")
[ -n "$PREV" ] && KEEP+=(-e "$(basename "$PREV")")
ls -1t "$APP/releases" | grep -vxF "${KEEP[@]}" | tail -n +2 | xargs -r -I{} rm -rf "$APP/releases/{}" || true
REMOTE
