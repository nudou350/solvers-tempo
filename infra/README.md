# infra/

Production setup of Solvers on Tempo on the owner's VPS (the shared host described in `VPS_GUIDE.md`). **Nothing here
runs by itself**: no workflow deploys on push, and every script is started by hand by the owner. Contract deployment,
roles, keys and the full checklist are in `docs/deploy-runbook.md`; this file covers the host.

| File | What it is |
|---|---|
| `.env.example` | Every API/worker variable (kept in sync with `apps/server/src/env.ts` by a test) |
| `ecosystem.config.cjs` | PM2 apps: `solvers-tempo-api` (127.0.0.1:3018), `solvers-tempo-web` (127.0.0.1:4018), `solvers-tempo-worker` (no port) |
| `worker-run.sh` | Start command of the worker (`nice -n 10`) |
| `nginx/solvers-tempo` | nginx site for `solvers-tempo.wondervelop.com`: `/` → web, `/api` `/mcp` `/oauth` `/.well-known` `/webhooks` `/preview` `/health` → API |
| `manifest.json` | Project metadata, copied to `/var/www/solvers-tempo/manifest.json` by each deploy (VPS_GUIDE convention) |
| `setup-vps.sh` | One-time host preparation (directories, database, `.env` skeletons); dry-run without `--yes` |
| `deploy.sh` | Ships a commit, builds, migrates, switches releases, reloads PM2, rolls back on failure; dry-run without `--yes` |

## Names and ports (D13)

| Item | Value | Why |
|---|---|---|
| Directory | `/var/www/solvers-tempo` | VPS_GUIDE §3 (releases + `shared/` like the previous app) |
| API | `solvers-tempo-api`, port **3018**, bound to 127.0.0.1 | Next free 3xxx in VPS_GUIDE §2 (3017 = `solvers-api`, 3020 = `agendou-br-api`) |
| Web | `solvers-tempo-web`, port **4018**, bound to 127.0.0.1 | 4xxx = SSR frontends; 4010/4011/4017 are taken |
| Worker | `solvers-tempo-worker` | No port |
| Database | `solvers_tempo` on PostgreSQL 16, port 5433, pgvector | The cluster with pgvector; role `solvers_tempo_user` |
| nginx | site `solvers-tempo`; zones `solvers_tempo_api`, `solvers_tempo_web`, `solvers_tempo_auth`, `solvers_tempo_upload`; upstreams `solvers_tempo_api`, `solvers_tempo_web` | nginx names are global: the prefix avoids clashing with `solvers_upload` and the shared `general`/`api`/`login` zones |
| Domain | `solvers-tempo.wondervelop.com` | Working name until the owner decides (owed decision #5) |

The port table in VPS_GUIDE has been out of date before. Confirm on the server before the first start; a busy port does
not fail loudly, the PM2 process just restarts in a loop.

## Order of operations (first time)

Every step is manual and needs the owner's go (shared host).

1. **Contracts and client.** Deploy and verify the contracts, accept the admin handover, commit
   `deployments/<chainId>.json` and the regenerated `packages/contracts-client` (`docs/deploy-runbook.md` §4).
2. **DNS.** `A` record of the domain → the VPS IP.
3. **Host preparation.** Copy `infra/setup-vps.sh` to the VPS and run `bash setup-vps.sh` (dry-run), then
   `bash setup-vps.sh --yes`. Fill `shared/.env` (treasury, admin wallets, Telegram, Privy, Pix) and `shared/web.env`;
   copy the three key files into `/var/www/solvers-tempo/keys/` (`chmod 600`). Add `deploy` to the `docker` group if
   the script says so.
4. **Ports.** `ss -tln | grep -oE '127.0.0.1:[34][0-9]{3}|\*:[34][0-9]{3}' | sort -u` must not list 3018 or 4018.
5. **TLS first, before enabling the site** (the site references the certificate files, so `nginx -t` fails until they
   exist): `sudo certbot certonly --nginx -d solvers-tempo.wondervelop.com`. Renewal is automatic (VPS_GUIDE §6).
6. **nginx.** Copy `infra/nginx/solvers-tempo` to `/etc/nginx/sites-available/solvers-tempo`,
   `sudo ln -s /etc/nginx/sites-available/solvers-tempo /etc/nginx/sites-enabled/`, then
   `sudo nginx -t && sudo systemctl reload nginx`. Until the first deploy, `/` answers 502.
7. **First deploy** from a clean checkout of the commit to ship: `bash infra/deploy.sh` (dry-run), then
   `bash infra/deploy.sh --yes`. The first run starts the three PM2 processes from `ecosystem.config.cjs`; afterwards
   run `pm2 save` once more if `pm2 list` shows them online.
8. **Checks**: `docs/deploy-runbook.md` §9 (`/health`, `/api/config`, PM2 status, worker logs, smoke script).
9. **Backups**: the daily PostgreSQL dump picks up `solvers_tempo` automatically; the weekly tarball exclusions are an
   owner decision (`docs/deploy-runbook.md`, Backups).

## Later deploys

`bash infra/deploy.sh --yes` from the commit to ship, or the manual GitHub workflow (`.github/workflows/deploy.yml`,
`workflow_dispatch` only, behind the `production` environment's approval). Only after `ci.yml` is green for that commit.

- Migrations run from the new release while the old one still serves: keep them additive.
- `deploy.sh` never changes nginx. A change to `infra/nginx/solvers-tempo` is copied by hand (keep a dated backup of the
  live file), followed by `sudo nginx -t && sudo systemctl reload nginx`.
- A change to an app block of `ecosystem.config.cjs` needs `pm2 delete <name>` and
  `pm2 start /var/www/solvers-tempo/app/infra/ecosystem.config.cjs --only <name>`, then `pm2 save` (`pm2 reload` does
  not re-read the file).
- Contract upgrades are separate from deploys: `contracts/script/Upgrade.s.sol` (header) and `docs/deploy-runbook.md`.

## Rollback

`deploy.sh` rolls back by itself when the new release fails its ~30 s health check. To go back by hand to an earlier
release still on disk (`ls /var/www/solvers-tempo/releases`): point the `app`, `backend`, `frontend` and `agents`
symlinks at it (as `activate` in `deploy.sh` does) and `pm2 reload solvers-tempo-api solvers-tempo-web solvers-tempo-worker`.
Database migrations are not rolled back (they are additive).
