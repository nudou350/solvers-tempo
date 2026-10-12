#!/usr/bin/env bash
# End-to-end check of the upgrade procedure (decision X16) on a fresh `anvil --tempo`; never touches a public network.
#   1. deploy the six proxies with script/Deploy.s.sol (GIT_SHA = HEAD) and hand the admin role to the cold admin
#   2. use that deploy's build-info as the reference build of GIT_SHA (what script/reference-build.sh produces for a
#      public network from a git worktree)
#   3. Upgrade.s.sol validate mode on all six (openzeppelin-foundry-upgrades validateUpgrade, via npx)
#   4. guards: a missing reference build and a non-admin signer are refused
#   5. execute mode signed by the cold admin on registry + license; state kept; record-upgrade.mjs updates the file;
#      validation of the upgraded proxies against the recorded commit still passes
# Usage (from contracts/): bash script/upgrade-anvil.sh      Requires Foundry >= 1.8.5, node and npx.
# deployments/31337.json (local, gitignored) is backed up and restored.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${ANVIL_PORT:-8548}
RPC="http://127.0.0.1:$PORT"
TOKEN=0x20c0000000000000000000000000000000000000
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil 0
PLATFORM_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # anvil 1
VERIFIER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a # anvil 2
ADMIN_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6    # anvil 3 (cold admin)
addr() { cast wallet address --private-key "$1"; }
PLATFORM=$(addr $PLATFORM_PK); VERIFIER=$(addr $VERIFIER_PK); ADMIN=$(addr $ADMIN_PK)
GIT_SHA=$(git rev-parse HEAD)
REF_ROOT=reference-build/anvil-upgrade-check
D=../deployments/31337.json
BACKUP=$(mktemp)
HAD_LOCAL=0; [ -f "$D" ] && { cp "$D" "$BACKUP"; HAD_LOCAL=1; }

fail() { echo "FAIL: $*" >&2; exit 1; }
lower() { echo "$1" | tr 'A-F' 'a-f'; }
get() { node -e "const d=require('./$D'); console.log(process.argv[1].split('.').reduce((o,k)=>o[k], d))" "$1"; }

forge clean
anvil --tempo --port "$PORT" --silent &
ANVIL=$!
cleanup() {
  kill $ANVIL 2>/dev/null || true
  rm -rf "$REF_ROOT"
  if [ "$HAD_LOCAL" = 1 ]; then cp "$BACKUP" "$D"; else rm -f "$D"; fi
  rm -f "$BACKUP"
}
trap cleanup EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

echo "== 1. deploy (GIT_SHA ${GIT_SHA:0:12}) and admin handover"
PAYMENT_TOKEN=$TOKEN TREASURY_ADDRESS=0x000000000000000000000000000000000000dEaD PLATFORM_ADDRESS=$PLATFORM \
VERIFIER_ADDRESS=$VERIFIER COLD_ADMIN=$ADMIN LICENSE_BASE_URI=http://localhost:3018/api/license/ \
DEPLOYMENT_NAME=anvil GIT_SHA=$GIT_SHA \
  forge script script/Deploy.s.sol --skip test --rpc-url "$RPC" --broadcast --private-key $DEPLOYER_PK >/dev/null
# The deploy's own compilation unit is the reference build of GIT_SHA (step 2); copied now, before AcceptAdmin.s.sol
# compiles a second unit that also contains SolversRegistry.
mkdir -p "$REF_ROOT/sha-${GIT_SHA:0:12}"
cp out/build-info/*.json "$REF_ROOT/sha-${GIT_SHA:0:12}/"
[ "$(ls "$REF_ROOT/sha-${GIT_SHA:0:12}" | wc -l | tr -d ' ')" = 1 ] || fail "expected one build-info from the deploy"
cast rpc evm_increaseTime 2 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
REGISTRY=$(get registry) forge script script/AcceptAdmin.s.sol --skip test --rpc-url "$RPC" --broadcast \
  --private-key $ADMIN_PK >/dev/null
[ "$(lower "$(cast call "$(get registry)" "defaultAdmin()(address)" --rpc-url "$RPC")")" = "$(lower "$ADMIN")" ] \
  || fail "default admin is not the cold admin"

echo "== 2. reference build of ${GIT_SHA:0:12} = the deploy's build-info (copied above)"
forge clean # the upgrade script compiles its own unit: exactly one build-info per contract

up() { # up <mode> <keys> <pk> [extra env...]: runs Upgrade.s.sol, prints its output
  local mode=$1 keys=$2 pk=$3; shift 3
  env UPGRADE="$keys" UPGRADE_MODE="$mode" REFERENCE_ROOT="$REF_ROOT" "$@" \
    forge script script/Upgrade.s.sol --skip test --rpc-url "$RPC" --private-key "$pk" \
    $([ "$mode" = validate ] || echo --broadcast) 2>&1
}

echo "== 3. validate all six against the reference"
OUT=$(up validate all $DEPLOYER_PK) || { echo "$OUT" >&2; fail "validation failed"; }
[ "$(echo "$OUT" | grep -c 'valid upgrade:')" = 6 ] || { echo "$OUT" >&2; fail "expected 6 valid upgrades"; }
echo "ok  6 proxies validated (validateUpgrade against sha-${GIT_SHA:0:12})"

echo "== 4. guards"
OUT=$(up validate registry $DEPLOYER_PK REFERENCE_ROOT=reference-build/absent) && fail "a missing reference passed"
echo "$OUT" | grep -q "is missing" || { echo "$OUT" >&2; fail "unexpected error for a missing reference"; }
echo "ok  missing reference build refused"
OUT=$(up execute registry $DEPLOYER_PK) && fail "a non-admin executed an upgrade"
echo "$OUT" | grep -q "execute must be signed by the default admin" || { echo "$OUT" >&2; fail "unexpected non-admin error"; }
echo "ok  non-admin signer refused"

echo "== 5. execute (cold admin) on registry + license"
OLD_REG_IMPL=$(get impls.registry); OLD_LIC_IMPL=$(get impls.license)
CONFIG_BEFORE=$(cast call "$(get registry)" "config()" --rpc-url "$RPC")
OUT=$(up execute registry,license $ADMIN_PK) || { echo "$OUT" >&2; fail "execute failed"; }
NEW_REG_IMPL=$(cast implementation "$(get registry)" --rpc-url "$RPC")
NEW_LIC_IMPL=$(cast implementation "$(get license)" --rpc-url "$RPC")
[ "$(lower "$NEW_REG_IMPL")" != "$(lower "$OLD_REG_IMPL")" ] || fail "registry implementation did not change"
[ "$(lower "$NEW_LIC_IMPL")" != "$(lower "$OLD_LIC_IMPL")" ] || fail "license implementation did not change"
[ "$(lower "$(cast implementation "$(get credits)" --rpc-url "$RPC")")" = "$(lower "$(get impls.credits)")" ] \
  || fail "credits changed although it was not listed"
CONFIG_AFTER=$(cast call "$(get registry)" "config()" --rpc-url "$RPC")
[ "$CONFIG_AFTER" = "$CONFIG_BEFORE" ] || fail "registry config changed across the upgrade"
[ "$(lower "$(cast call "$(get registry)" "defaultAdmin()(address)" --rpc-url "$RPC")")" = "$(lower "$ADMIN")" ] \
  || fail "default admin changed across the upgrade"
echo "ok  registry and license upgraded by the default admin; config and admin kept"

OUT=$(up validate registry $DEPLOYER_PK) && fail "an unrecorded upgrade passed the plan"
echo "$OUT" | grep -q "record the previous upgrade" || { echo "$OUT" >&2; fail "unexpected error for an unrecorded upgrade"; }
echo "ok  unrecorded upgrade refused until recorded"
node script/record-upgrade.mjs 31337 --rpc-url "$RPC" --sha "$GIT_SHA" >/dev/null
[ "$(lower "$(get impls.registry)")" = "$(lower "$NEW_REG_IMPL")" ] || fail "record-upgrade did not write impls.registry"
[ "$(get implGitSha.license)" = "$GIT_SHA" ] || fail "record-upgrade did not write implGitSha.license"
OUT=$(up validate registry,license $DEPLOYER_PK) || { echo "$OUT" >&2; fail "validation after the recorded upgrade failed"; }
echo "ok  recorded; upgraded proxies validate against implGitSha"

echo "ALL UPGRADE CHECKS PASSED"
