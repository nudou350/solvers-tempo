#!/usr/bin/env bash
# Local end-to-end check of the contracts on `anvil --tempo` (plan §6 phase 2 step 4).
# Starts a fresh anvil in Tempo mode, deploys with script/Deploy.s.sol, accepts the admin handover, then runs the core
# flows SPONSORED by a separate fee payer (each receipt's feePayer must be the sponsor; senders pay no fee) and asserts
# exact token movements. Foundry 1.8.5 `cast batch-send` ignores --tempo.sponsor-signer (measured: the sender pays), so
# sponsored steps are single `cast send` calls; steps 7-8 prove an atomic multi-call 0x76 batch (self-paid). Sponsored
# batches are exercised with viem, the production path, in packages/chain (phase 3).
#   1. creator registers (approve staking + registerAgent)      5. platform purchaseLicenseFor (float)
#   2. admin approves                                            6. escrow create -> markPassed -> release
#   3. buyer purchases: pays exactly the price                   7. atomic batch [approve, purchaseLicense]
#   4. transfer with royalty: exact 5% + 5%                      8. a reverting call reverts the whole batch
# Usage (from contracts/): bash script/e2e-anvil.sh      Requires Foundry >= 1.8.5 and node.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${ANVIL_PORT:-8547}
RPC="http://127.0.0.1:$PORT"
TOKEN=0x20c0000000000000000000000000000000000000 # pathUSD predeploy (6 decimals) on anvil --tempo

# anvil default accounts (public test keys)
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # 0
PLATFORM_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # 1
VERIFIER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # 2
ADMIN_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6      # 3 (cold admin)
CREATOR_PK=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba    # 5
BUYER_PK=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e      # 6
BUYER2_PK=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356     # 7
export SPONSOR_PK=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 # 9 (fee payer only)
addr() { cast wallet address --private-key "$1"; }
PLATFORM=$(addr $PLATFORM_PK); VERIFIER=$(addr $VERIFIER_PK); ADMIN=$(addr $ADMIN_PK)
CREATOR=$(addr $CREATOR_PK); BUYER=$(addr $BUYER_PK); BUYER2=$(addr $BUYER2_PK); SPONSOR=$(addr $SPONSOR_PK)
TREASURY=0x000000000000000000000000000000000000dEaD
MIN_STAKE=20000000; PRICE=10000000
AGENT=0xc71ad0a50f750e75c71ad0a50f750e7500000000000000000000000000000000
lower() { echo "$1" | tr 'A-F' 'a-f'; }

# openzeppelin-foundry-upgrades validation needs exactly one build-info per contract: `forge script` compiles its own
# sparse unit, so start from a clean out/ and let the deploy script do the only build.
forge clean

anvil --tempo --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

fail() { echo "FAIL: $*" >&2; exit 1; }
bal() { cast call "$TOKEN" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }
expect_eq() { [ "$1" = "$2" ] || fail "$3: expected $2, got $1"; echo "ok  $3 = $1"; }
ssend() { # ssend <pk> <to> <sig> [args...] : sponsored single call; asserts success and that the sponsor paid the fee
  local pk=$1; shift
  local receipt status payer
  # Foundry 1.8.5 sets too low a gas limit on sponsored sends (measured: registerAgent uses 1.87M, eth_estimateGas
  # says 1.90M, the automatic limit runs out of gas); pass an explicit cap. Fees are charged on gas used.
  receipt=$(cast send "$@" --gas-limit 6000000 --rpc-url "$RPC" --private-key "$pk" --tempo.sponsor "$SPONSOR" \
    --tempo.sponsor-signer env://SPONSOR_PK 2>&1 || true)
  status=$(echo "$receipt" | awk '$1 == "status" {print $2}')
  payer=$(echo "$receipt" | awk '$1 == "feePayer" {print $2}')
  [ "$status" = "true" ] || { echo "$receipt" | grep -vE "^(logs|logsBloom)" >&2; fail "tx failed: $*"; }
  [ "$(lower "$payer")" = "$(lower "$SPONSOR")" ] || fail "fee payer was $payer, expected the sponsor ($*)"
}

echo "== deploy"
PAYMENT_TOKEN=$TOKEN TREASURY_ADDRESS=$TREASURY PLATFORM_ADDRESS=$PLATFORM VERIFIER_ADDRESS=$VERIFIER COLD_ADMIN=$ADMIN \
MIN_STAKE=$MIN_STAKE LICENSE_BASE_URI=http://localhost:3018/api/license/ DEPLOYMENT_NAME=anvil \
  forge script script/Deploy.s.sol --skip test --rpc-url "$RPC" --broadcast --private-key $DEPLOYER_PK >/dev/null
D=../deployments/31337.json
get() { node -e "console.log(require('./$D')['$1'])"; }
REGISTRY=$(get registry); LICENSE=$(get license); ESCROW=$(get escrow); STAKING=$(get staking)
cast rpc evm_increaseTime 2 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
REGISTRY=$REGISTRY forge script script/AcceptAdmin.s.sol --skip test --rpc-url "$RPC" --broadcast --private-key $ADMIN_PK >/dev/null
expect_eq "$(cast call "$REGISTRY" "defaultAdmin()(address)" --rpc-url "$RPC")" "$ADMIN" "default admin"

echo "== 1. creator registers (sponsored)"
SPONSOR_BEFORE=$(bal "$SPONSOR"); CREATOR_BEFORE=$(bal "$CREATOR")
REG="($AGENT,https://api.test/agents/a.json,1.0.0,$(cast keccak v1),$PRICE,1000000,500)"
ssend $CREATOR_PK "$TOKEN" "approve(address,uint256)" "$STAKING" $MIN_STAKE
ssend $CREATOR_PK "$REGISTRY" "registerAgent((bytes32,string,string,bytes32,uint96,uint96,uint16))" "$REG"
expect_eq "$(( CREATOR_BEFORE - $(bal "$CREATOR") ))" "$MIN_STAKE" "creator paid exactly the stake (no fee)"
expect_eq "$(cast call "$STAKING" "totalStaked()(uint256)" --rpc-url "$RPC" | awk '{print $1}')" "$MIN_STAKE" "totalStaked"
# balances of anvil dev accounts exceed bash's signed 64-bit range: compare as BigInt
node -e 'process.exit(BigInt(process.argv[1]) < BigInt(process.argv[2]) ? 0 : 1)' "$(bal "$SPONSOR")" "$SPONSOR_BEFORE" \
  || fail "sponsor did not pay"; echo "ok  sponsor paid the fees"

echo "== 2. admin approves (sponsored; the cold key holds no tokens for fees)"
ssend $ADMIN_PK "$REGISTRY" "approveAgent(bytes32)" $AGENT
expect_eq "$(cast call "$REGISTRY" "statusOf(bytes32)(uint8)" $AGENT --rpc-url "$RPC")" "1" "agent active"

echo "== 3. buyer purchases (sponsored)"
BUYER_BEFORE=$(bal "$BUYER"); CREATOR_BEFORE=$(bal "$CREATOR"); TREASURY_BEFORE=$(bal "$TREASURY")
ssend $BUYER_PK "$TOKEN" "approve(address,uint256)" "$LICENSE" $PRICE
ssend $BUYER_PK "$LICENSE" "purchaseLicense(bytes32,uint96,bytes32)" $AGENT $PRICE "$(cast keccak solvers:v1:e2e-1)"
expect_eq "$(( BUYER_BEFORE - $(bal "$BUYER") ))" "$PRICE" "buyer paid exactly the price"
expect_eq "$(( $(bal "$CREATOR") - CREATOR_BEFORE ))" "9000000" "creator received 90%"
expect_eq "$(( $(bal "$TREASURY") - TREASURY_BEFORE ))" "1000000" "treasury received 10%"
expect_eq "$(cast call "$LICENSE" "ownerOf(uint256)(address)" 1 --rpc-url "$RPC")" "$BUYER" "license #1 owner"

echo "== 4. transfer with royalty (sponsored)"
BUYER_BEFORE=$(bal "$BUYER"); CREATOR_BEFORE=$(bal "$CREATOR"); TREASURY_BEFORE=$(bal "$TREASURY")
ssend $BUYER_PK "$TOKEN" "approve(address,uint256)" "$LICENSE" 1000000
ssend $BUYER_PK "$LICENSE" "transferWithRoyalty(address,uint256,uint256)" "$BUYER2" 1 1000000
expect_eq "$(( BUYER_BEFORE - $(bal "$BUYER") ))" "1000000" "owner paid 10% royalty"
expect_eq "$(( $(bal "$CREATOR") - CREATOR_BEFORE ))" "500000" "creator royalty 5%"
expect_eq "$(( $(bal "$TREASURY") - TREASURY_BEFORE ))" "500000" "platform royalty 5%"
expect_eq "$(cast call "$LICENSE" "ownerOf(uint256)(address)" 1 --rpc-url "$RPC")" "$BUYER2" "license #1 new owner"

echo "== 5. platform buys for buyer2 from its float (sponsored)"
PLATFORM_BEFORE=$(bal "$PLATFORM")
ssend $PLATFORM_PK "$TOKEN" "approve(address,uint256)" "$LICENSE" $PRICE
ssend $PLATFORM_PK "$LICENSE" "purchaseLicenseFor(address,bytes32,uint96,bytes32)" "$BUYER2" $AGENT $PRICE \
  "$(cast keccak solvers:v1:pix-1)"
expect_eq "$(( PLATFORM_BEFORE - $(bal "$PLATFORM") ))" "$PRICE" "platform float paid exactly the price"
expect_eq "$(cast call "$LICENSE" "ownerOf(uint256)(address)" 2 --rpc-url "$RPC")" "$BUYER2" "license #2 owner"

echo "== 6. escrow: create -> markPassed -> release (sponsored)"
ssend $BUYER_PK "$TOKEN" "approve(address,uint256)" "$ESCROW" 7000000
ssend $BUYER_PK "$ESCROW" "createEscrow(bytes32,(uint96,bytes32)[],uint32,uint16,bytes32)" $AGENT \
  "[(7000000,$(cast keccak m0))]" 3600 0 "$(cast keccak solvers:v1:e2e-esc)"
expect_eq "$(bal "$ESCROW")" "7000000" "escrow vault"
ssend $VERIFIER_PK "$ESCROW" "markPassed(uint256,uint8,bytes32)" 1 0 "$(cast keccak deliverable)"
CREATOR_BEFORE=$(bal "$CREATOR")
ssend $BUYER_PK "$ESCROW" "releaseMilestone(uint256,uint8)" 1 0
expect_eq "$(( $(bal "$CREATOR") - CREATOR_BEFORE ))" "6300000" "creator milestone payout (90%)"
expect_eq "$(bal "$ESCROW")" "0" "escrow vault empty"
expect_eq "$(cast call "$ESCROW" "statusOf(uint256)(uint8)" 1 --rpc-url "$RPC")" "1" "escrow completed"

echo "== 7. atomic 0x76 batch (self-paid): [approve, purchaseLicense] by buyer2"
BUYER2_BEFORE=$(bal "$BUYER2")
cast batch-send --rpc-url "$RPC" --private-key $BUYER2_PK \
  --call "$TOKEN::approve(address,uint256):$LICENSE,$PRICE" \
  --call "$LICENSE::purchaseLicense(bytes32,uint96,bytes32):$AGENT,$PRICE,$(cast keccak solvers:v1:e2e-batch)" >/dev/null
PAID=$(( BUYER2_BEFORE - $(bal "$BUYER2") ))
[ "$PAID" -gt "$PRICE" ] || fail "batch: expected price + own fee, got $PAID"; echo "ok  batch paid price + own fee ($PAID)"
expect_eq "$(cast call "$LICENSE" "ownerOf(uint256)(address)" 3 --rpc-url "$RPC")" "$BUYER2" "license #3 owner (batched)"

echo "== 8. batch atomicity: a reverting second call reverts the approve too"
allowance() { cast call "$TOKEN" "allowance(address,address)(uint256)" "$BUYER2" "$LICENSE" --rpc-url "$RPC" | awk '{print $1}'; }
ALLOW_BEFORE=$(allowance)
if cast batch-send --rpc-url "$RPC" --private-key $BUYER2_PK \
  --call "$TOKEN::approve(address,uint256):$LICENSE,123" \
  --call "$LICENSE::purchaseLicense(bytes32,uint96,bytes32):$AGENT,1,$(cast keccak solvers:v1:e2e-bad)" >/dev/null 2>&1; then
  fail "a batch with a reverting call succeeded"
fi
expect_eq "$(allowance)" "$ALLOW_BEFORE" "allowance unchanged after the reverted batch"

echo "ALL E2E CHECKS PASSED"
