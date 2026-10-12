#!/usr/bin/env bash
# One-time preparation of the VPS for Solvers on Tempo. Run ON THE VPS as the `deploy` user (uses sudo), by the owner,
# after reading VPS_GUIDE.md and infra/README.md. Never run by CI. Idempotent: existing files and roles are kept.
#
#   bash setup-vps.sh            # dry-run: prints what it would create
#   bash setup-vps.sh --yes      # creates directories, the database and the .env skeletons
#
# Creates: /var/www/solvers-tempo/{releases,shared/{submissions,packages,deliverables},keys,logs}, the PostgreSQL 16
# (port 5433) role solvers_tempo_user + database solvers_tempo with pgvector, shared/.env (generated JWT_SECRET and
# SERVER_KEK; chain keys left as file paths to fill) and shared/web.env. It does NOT touch nginx, certificates, PM2 or
# other projects: those steps are manual (infra/README.md, steps 4-7).
set -euo pipefail
APP=/var/www/solvers-tempo
DOMAIN=${DOMAIN:-solvers-tempo.wondervelop.com}
PGPORT=5433

if [ "${1:-}" != "--yes" ]; then
  echo "Dry-run. With --yes this creates $APP/{releases,shared,keys,logs}, the database solvers_tempo on port $PGPORT"
  echo "(role solvers_tempo_user, extension vector) and, if missing, $APP/shared/.env and $APP/shared/web.env for $DOMAIN."
  exit 0
fi

sudo mkdir -p $APP/{releases,shared/submissions,shared/packages,shared/deliverables,keys,logs}
sudo chown -R deploy:deploy $APP
chmod 700 $APP/keys $APP/shared/submissions $APP/shared/packages $APP/shared/deliverables

# Database: the PG16 cluster on 5433 has pgvector (D13); the password goes to shared/db.env (chmod 600), never printed.
# The role and the database are checked separately (a rerun after a partial run completes what is missing). The password
# reaches psql on stdin (printf is a shell builtin), never on a command line visible in `ps`.
dpkg -s postgresql-16-pgvector >/dev/null 2>&1 || sudo apt-get install -y postgresql-16-pgvector >/dev/null
pg() { sudo -u postgres psql -p $PGPORT -v ON_ERROR_STOP=1 -qtA "$@"; }
if [ "$(pg -c "select 1 from pg_roles where rolname='solvers_tempo_user'")" != 1 ]; then
  if [ -f $APP/shared/db.env ]; then
    echo "! role solvers_tempo_user is missing but $APP/shared/db.env exists: move db.env away (or recreate the role with its password) and rerun" >&2
    exit 1
  fi
  PASS=$(openssl rand -hex 16)
  printf "CREATE ROLE solvers_tempo_user WITH LOGIN PASSWORD '%s';\n" "$PASS" | pg >/dev/null
  (umask 077 && echo "DATABASE_URL=postgres://solvers_tempo_user:$PASS@127.0.0.1:$PGPORT/solvers_tempo" > $APP/shared/db.env)
  unset PASS
  echo "ok role solvers_tempo_user created (credentials in $APP/shared/db.env)"
elif [ ! -f $APP/shared/db.env ]; then
  echo "! role solvers_tempo_user exists but $APP/shared/db.env is missing: restore it (DATABASE_URL from shared/.env) or reset the password by hand" >&2
  exit 1
fi
if [ "$(pg -c "select 1 from pg_database where datname='solvers_tempo'")" != 1 ]; then
  pg -c "CREATE DATABASE solvers_tempo OWNER solvers_tempo_user;" >/dev/null
  echo "ok database solvers_tempo created"
fi
pg -d solvers_tempo -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

# API/worker environment. Every variable is documented in infra/.env.example (source of truth: apps/server/src/env.ts).
if [ ! -f $APP/shared/.env ]; then
  . $APP/shared/db.env
  umask 077
  cat > $APP/shared/.env <<ENV
NODE_ENV=production
PORT=3018
PUBLIC_API_URL=https://$DOMAIN
PUBLIC_WEB_URL=https://$DOMAIN
DATABASE_URL=$DATABASE_URL
# Moderato testnet until the mainnet decisions are made (docs/migration/decisions.md, owed). Never set ADMIN_PRIVATE_KEY here.
CHAIN_ID=42431
RPC_URL=https://rpc.moderato.tempo.xyz
PAYMENT_TOKEN=0x20c0000000000000000000000000000000000000
PAYMENT_TOKEN_DECIMALS=6
PAYMENT_TOKEN_SYMBOL=USD
# Key files (0x hex inside, chmod 600) copied by hand into $APP/keys; never committed, never printed.
PLATFORM_PRIVATE_KEY=$APP/keys/platform.key
RELAY_PRIVATE_KEY=$APP/keys/relay.key
VERIFIER_PRIVATE_KEY=$APP/keys/verifier.key
TREASURY_ADDRESS=
JWT_SECRET=$(openssl rand -hex 32)
SERVER_KEK=$(openssl rand -base64 32)
FAUCET_ENABLED=true
AGENTS_DIR=$APP/agents
PUBLISHED_DIR=$APP/shared/packages
SUBMISSIONS_DIR=$APP/shared/submissions
DELIVERABLES_DIR=$APP/shared/deliverables
ADMIN_WALLETS=
VERIFIER_MODE=docker
VERIFIER_IMAGE=solvers-tempo-react-test
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
ENV
  echo "ok $APP/shared/.env created: fill TREASURY_ADDRESS, ADMIN_WALLETS, Telegram, Privy, Pix; copy the key files"
fi

# Web build environment (NEXT_PUBLIC_* are inlined at build time by infra/deploy.sh).
if [ ! -f $APP/shared/web.env ]; then
  cat > $APP/shared/web.env <<ENV
NEXT_PUBLIC_CHAIN_ID=42431
NEXT_PUBLIC_PRIVY_APP_ID=
NEXT_PUBLIC_ALLOW_DEV_WALLET=
NEXT_PUBLIC_API_URL=
API_INTERNAL_URL=http://127.0.0.1:3018
ENV
  chmod 600 $APP/shared/web.env
  echo "ok $APP/shared/web.env created"
fi

# Guarantee verifier: Docker access (the deploy user in the docker group is root-equivalent on the host).
if ! id -nG deploy | grep -qw docker; then echo "! deploy is not in the docker group (needed for VERIFIER_MODE=docker)"; fi

echo "next: infra/README.md step 4 (ports), 5 (TLS), 6 (nginx), 7 (first deploy)"
