# CI notes

State of the GitHub Actions workflows of this repository and the hardening still to apply. Nothing deploys on its own:
the only deploy workflow is manual, and pushing or creating a remote waits for the owner.

## 1. What exists today

`.github/workflows/` holds three workflows, all with `permissions: contents: read`: `contracts.yml`, `ci.yml` and
`deploy.yml`.

**`contracts.yml`** runs on pull requests and pushes to `master` that touch `contracts/**` or the workflow itself, and on
`workflow_dispatch`. One job on `ubuntu-latest`, working directory `contracts/`:

| Step | Command | What it guards |
|---|---|---|
| Checkout | `actions/checkout` (pinned by commit, v7.0.1) with `submodules: recursive` | `contracts/lib` (forge-std, OpenZeppelin upgradeable, openzeppelin-foundry-upgrades, tempo-std) |
| Node | `actions/setup-node` (pinned by commit, v7.0.0), Node 22 | the layout and ABI scripts, and `npx @openzeppelin/upgrades-core` used by the upgrade validator |
| Foundry | `foundry-rs/foundry-toolchain@v1`, `version: v1.8.5` | upstream Foundry with Tempo support |
| Format | `forge fmt --check src script test` | formatting |
| Build | `forge build --sizes --skip test --skip 'test/**'` | every contract under 24,576 bytes |
| Tests | `FOUNDRY_PROFILE=ci forge test` | unit, access-control and pause matrices, ABI meta-check, fuzz (2000 runs) and invariants (256 × 64) |
| Gas snapshot | `FOUNDRY_PROFILE=gas forge snapshot --check --no-match-path 'test/invariant/*' --no-match-test 'Fuzz\|fuzz'` | `.gas-snapshot` (deterministic tests only) |
| Storage layouts | `node script/check-layouts.mjs` | UUPS storage stays append-only against `contracts/storage-layouts/*.json` |
| End to end | `bash script/e2e-anvil.sh` | fresh `anvil --tempo`, validated deploy (`Deploy.s.sol` through `openzeppelin-foundry-upgrades`), `AcceptAdmin.s.sol`, sponsored flows with exact token movements |
| Upgrade procedure | `bash script/upgrade-anvil.sh` | X16 on a fresh `anvil --tempo`: `Upgrade.s.sol` validate against a reference build, guards (missing reference, non-admin signer), execute on two proxies, `record-upgrade.mjs` |

**`ci.yml`** (monorepo) runs on pull requests, pushes to `master` and `workflow_dispatch`: `pnpm install --frozen-lockfile`,
Foundry `v1.8.5` (for `anvil --tempo`), `pnpm --filter @solvers/contracts-client generate:check` (builds `contracts/out` and
fails when the generated ABIs/addresses are stale), `pnpm build`, `pnpm typecheck`, migration of a `pgvector/pgvector:pg16`
service on port 5546 (`TEST_DATABASE_URL`), then `pnpm test` (unit, `*.db.test.ts` and the anvil-based chain, lanes,
indexer, publish and admin CLI tests). `node scripts/purge-check.mjs` is run by hand before commits, not in CI.

**`deploy.yml`** is **`workflow_dispatch` only** (no push, merge or schedule trigger: a deploy must never race a contract
change or happen without the owner). It runs only from `master`, only when the typed confirmation is
`deploy solvers-tempo`, inside the `production` environment; it installs, builds and typechecks on the runner, loads
`VPS_SSH_KEY` with `webfactory/ssh-agent`, pins the host key from `VPS_KNOWN_HOSTS` and runs `bash infra/deploy.sh --yes`
(`docs/deploy-runbook.md` §8).

## 2. Owner setup still needed on GitHub

- Create the `production` environment with required reviewers (the owner) and a branch restriction (`master`).
- Add the environment secrets `VPS_SSH_KEY` and `VPS_KNOWN_HOSTS` (see "Known hosts" below).

## 3. Hardening to apply

### Pin actions by commit SHA

Done for `actions/checkout`, `actions/setup-node` and `webfactory/ssh-agent` (full commit SHA with the version as a
comment). `foundry-rs/foundry-toolchain@v1` in `ci.yml` and `contracts.yml` is still a floating tag: pin it the same way, so
a moved tag cannot change what runs. Resolve a tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`; if `.object.type`
is `tag`, dereference it with `gh api repos/<owner>/<repo>/git/tags/<sha>`. Upgrading a pin is a reviewed change of its own.

### Secrets

The deploy job reads only `VPS_SSH_KEY` (VPS_GUIDE §8) through `webfactory/ssh-agent` and `VPS_KNOWN_HOSTS`; no `echo`/`set -x` of secrets.
`set -euo pipefail` in every script so a failing step fails the job. `actions/checkout` with `persist-credentials: false`
where the job does not push (the deploy only needs `git archive` and `git rev-parse`).

### Known hosts without trust on first use

The VPS_GUIDE template runs `ssh-keyscan -H <host> >> ~/.ssh/known_hosts`, which trusts whatever answers at that moment: a
machine in the path between the runner and the VPS could impersonate it and receive the code and the deploy environment.
Fix:

1. From a trusted machine, run `ssh-keyscan -t ed25519 <host>` once and compare its fingerprint with the VPS's own
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, run on the VPS).
2. Store the line (`<host> ssh-ed25519 AAAA...`) as a repository variable or secret, e.g. `VPS_KNOWN_HOSTS` (a host public
   key is not secret).
3. `deploy.yml` already does this: `printf '%s\n' "$VPS_KNOWN_HOSTS" >> ~/.ssh/known_hosts` from the environment secret
   `VPS_KNOWN_HOSTS`, and it fails when the secret is empty. If the host key changes (VPS reinstall), the deploy fails on
   purpose until the value is updated.

### Approval gate

The deploy job has `environment: production` and a `master`-only condition; the owner still creates the environment with
required reviewers (the owner) and a branch restriction (`master`) on GitHub. `workflow_dispatch` alone lets anyone with write access run the deploy from any
branch; the environment makes every run wait for the owner. Contract deploys and upgrades never run in CI: they are signed
by keys that never leave the operator's machine (`docs/deploy-runbook.md` §2, §4).

### Toolchain

`corepack enable pnpm` follows the `packageManager` field (`pnpm@10.20.0`); keep Foundry pinned (`v1.8.5`) in every workflow
that builds contracts, so local and CI builds produce the same bytecode and gas snapshot.
