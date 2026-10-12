#!/usr/bin/env bash
# Builds the reference that script/Upgrade.s.sol validates against (decision X16): for every source commit named in
# deployments/<chainId>.json (`gitSha` and any `implGitSha.<key>`), checks that commit out in a temporary git worktree,
# compiles its contracts with that commit's own foundry.toml, and copies the build-info into
# contracts/reference-build/sha-<first 12 hex>/ (gitignored; nothing here is committed or sent anywhere).
#
#   bash script/reference-build.sh 42431          (from contracts/)
#
# Libraries: when the commit pins the same contracts/lib submodule revisions as the current checkout, they are copied
# from it (offline); otherwise `git submodule update --init --recursive` fetches them in the worktree.
# Requires git, forge (Foundry >= 1.8.5) and node.
set -euo pipefail
cd "$(dirname "$0")/.."
CONTRACTS=$(pwd)
REPO=$(git rev-parse --show-toplevel)

CHAIN_ID=${1:?usage: bash script/reference-build.sh <chainId>}
DEP="$REPO/deployments/$CHAIN_ID.json"
[ -f "$DEP" ] || { echo "missing $DEP" >&2; exit 1; }

SHAS=$(node -e '
  const d = require(process.argv[1]);
  const all = [d.gitSha, ...Object.values(d.implGitSha ?? {})].filter(Boolean);
  for (const s of new Set(all)) {
    if (!/^[0-9a-f]{40}$/.test(s)) { console.error(`not a 40-hex commit: ${s}`); process.exit(1); }
    console.log(s);
  }' "$DEP")
[ -n "$SHAS" ] || { echo "no gitSha in $DEP (a local deployment without GIT_SHA has no reference)" >&2; exit 1; }

# Top-level submodule pins of a commit / of the working copy, as "<path> <rev>" lines (nested pins follow from these).
pins_at() { git -C "$REPO" ls-tree "$1" contracts/lib/ | awk '$2 == "commit" {print $4, $3}' | sort; }
pins_now() { git -C "$REPO" submodule status -- contracts/lib | awk '{sub(/^[-+U]/, "", $1); print $2, $1}' | sort; }

mkdir -p "$CONTRACTS/reference-build"
for SHA in $SHAS; do
  SHORT="sha-${SHA:0:12}"
  OUT="$CONTRACTS/reference-build/$SHORT"
  if [ -d "$OUT" ] && ls "$OUT"/*.json >/dev/null 2>&1; then echo "== $SHORT already built"; continue; fi
  git -C "$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "commit $SHA is not in this clone (git fetch first)" >&2; exit 1; }

  WT=$(mktemp -d "${TMPDIR:-/tmp}/solvers-ref-XXXXXX")
  cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
  trap cleanup EXIT
  echo "== $SHORT: worktree at $WT"
  git -C "$REPO" worktree add --detach "$WT" "$SHA" >/dev/null

  if [ "$(pins_at "$SHA")" = "$(pins_now)" ]; then
    echo "   libraries: same pins as the working copy, copying"
    for L in "$CONTRACTS"/lib/*/; do
      NAME=$(basename "$L")
      mkdir -p "$WT/contracts/lib/$NAME"
      tar -C "$L" --exclude=.git -cf - . | tar -C "$WT/contracts/lib/$NAME" -xf -
    done
  else
    echo "   libraries: pins differ from the working copy, fetching submodules"
    git -C "$WT" submodule update --init --recursive
  fi

  # One compilation unit with the commit's own settings (src only: scripts and tests are not deployed code).
  (cd "$WT/contracts" && forge clean && forge build --skip test --skip script >/dev/null)
  mkdir -p "$OUT"
  cp "$WT/contracts/out/build-info/"*.json "$OUT/"
  echo "   wrote $(ls "$OUT" | wc -l | tr -d ' ') build-info file(s) to reference-build/$SHORT"
  cleanup
  trap - EXIT
done
echo "reference ready; next: forge clean && UPGRADE=<keys> forge script script/Upgrade.s.sol --skip test --rpc-url <rpc>"
