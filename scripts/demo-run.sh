#!/usr/bin/env bash
#
# GovExit — repeatable end-to-end demo runner (Avalanche Fuji).
#
# Runs the whole story once, or N times back-to-back:
#   Alice opens a Position -> approves GovExit as her Exit agent (once) ->
#   sets/re-arms her Exit rule -> the Demo Admin queues a threshold Proposal ->
#   the Keeper (permissionless) calls checkAndExit inside the 60s Timelock and the
#   Position is closed with no further Alice signature.
#
# Usage:
#   scripts/demo-run.sh [collateralAvax] [borrowMusdc] [minBps] [proposedBps] [runs]
#
# Defaults: 0.02 AVAX / 0.3 mUSDC / min 7000 bps / proposed 6000 bps / 1 run.
# The defaults are deliberately small so testnet AVAX lasts for many runs. Each
# run returns the unused Collateral, so Alice is only out the settled Debt plus
# gas. Pass `0.5 6.5 7000 6000` to reproduce the issue-10/11 scaled Position.
#
# Requires: cast (Foundry), jq, node, and the repo-root .env holding
#   ALICE_PRIVATE_KEY, DEMO_ADMIN_PRIVATE_KEY, KEEPER_PRIVATE_KEY.
# The three contract addresses default to the canonical Fuji deployment (the same
# built-ins the Keeper uses) and are deliberately NOT read from NEXT_PUBLIC_*, so
# a stale browser env cannot point the runner at a superseded deployment. Override
# with POOL_ADDRESS / GOVERNANCE_ADDRESS / GOVEXIT_ADDRESS if ever needed.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "error: $ROOT/.env not found" >&2
  exit 1
fi
set -a; source .env; set +a

: "${ALICE_PRIVATE_KEY:?ALICE_PRIVATE_KEY is missing from .env}"
: "${DEMO_ADMIN_PRIVATE_KEY:?DEMO_ADMIN_PRIVATE_KEY is missing from .env}"
: "${KEEPER_PRIVATE_KEY:?KEEPER_PRIVATE_KEY is missing from .env}"

# Canonical Fuji deployment — the same built-in defaults the Keeper uses. These are
# deliberately NOT read from NEXT_PUBLIC_*: a stale browser env must never be able
# to point the runner at a superseded deployment.
POOL="${POOL_ADDRESS:-0x25838379779FB4b229efbCCbb96d52aa94ddF278}"
GOVERNANCE="${GOVERNANCE_ADDRESS:-0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB}"
GOVEXIT="${GOVEXIT_ADDRESS:-0x90970F046e70B4E11579566aD22F5CFb8AefC390}"
RPC="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
CHAIN_ID="${CHAIN_ID:-43113}"

COLLATERAL_AVAX="${1:-0.02}"
BORROW_MUSDC="${2:-0.3}"
MIN_BPS="${3:-7000}"
PROPOSED_BPS="${4:-6000}"
RUNS="${5:-1}"

COLLATERAL_WEI="$(cast to-wei "$COLLATERAL_AVAX" ether)"
BORROW_WEI="$(cast to-wei "$BORROW_MUSDC" ether)"
GAS_BUFFER_WEI="$(cast to-wei 0.003 ether)"

ALICE="$(cast wallet address --private-key "$ALICE_PRIVATE_KEY")"
KEEPER="$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")"
ADMIN="$(cast wallet address --private-key "$DEMO_ADMIN_PRIVATE_KEY")"
QUEUE_SIG="$(cast keccak "ProposalQueued(uint256,uint256,uint256,uint256)")"
SNOWTRACE="https://testnet.snowtrace.io/tx"

if (( PROPOSED_BPS >= MIN_BPS )); then
  echo "error: proposed $PROPOSED_BPS bps is not below the Minimum threshold $MIN_BPS bps" >&2
  exit 1
fi

rpc() { cast "$@" --rpc-url "$RPC"; }

echo "GovExit demo runner"
echo "  chain        $CHAIN_ID ($(rpc chain-id))"
echo "  pool         $POOL"
echo "  governance   $GOVERNANCE"
echo "  govExit      $GOVEXIT"
echo "  alice        $ALICE"
echo "  demo admin   $ADMIN"
echo "  keeper       $KEEPER"
echo "  per run      collateral $COLLATERAL_AVAX AVAX, borrow $BORROW_MUSDC mUSDC,"
echo "               rule min $MIN_BPS bps vs proposed $PROPOSED_BPS bps"
echo "  runs         $RUNS"
echo

# --- Pre-flight ---------------------------------------------------------------
if [[ "$(rpc chain-id)" != "$CHAIN_ID" ]]; then
  echo "error: RPC is not chain $CHAIN_ID" >&2
  exit 1
fi
if [[ "$(rpc call "$GOVERNANCE" 'owner()(address)' --json | jq -r '.[0]')" != "$ADMIN" ]]; then
  echo "error: DEMO_ADMIN_PRIVATE_KEY does not own MockGovernance" >&2
  exit 1
fi
ALICE_BAL="$(rpc balance "$ALICE")"
# Big-int safe: bash's $(( )) is 64-bit and would overflow on a funded account.
NEED_WEI="$(node -e 'console.log((BigInt(process.argv[1]) + BigInt(process.argv[2])).toString())' "$COLLATERAL_WEI" "$GAS_BUFFER_WEI")"
if ! node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$ALICE_BAL" "$NEED_WEI"; then
  echo "error: Alice $ALICE holds $(cast from-wei "$ALICE_BAL") AVAX; needs $(cast from-wei "$NEED_WEI") AVAX (Collateral + gas buffer)" >&2
  exit 1
fi

close_if_open() {
  local active
  active="$(rpc call "$POOL" 'positions(address)(uint256,uint256,bool)' "$ALICE" --json | jq -r '.[2]')"
  if [[ "$active" == "true" ]]; then
    echo "  · leftover Position found — Alice closes it first"
    rpc send "$POOL" 'closePosition()' --private-key "$ALICE_PRIVATE_KEY" >/dev/null
  fi
}

approve_if_needed() {
  local approved
  approved="$(rpc call "$POOL" 'exitAgents(address,address)(bool)' "$ALICE" "$GOVEXIT" --json | jq -r '.[0]')"
  if [[ "$approved" != "true" ]]; then
    echo "  · Alice approves GovExit as her Exit agent"
    rpc send "$POOL" 'approveExitAgent(address,bool)' "$GOVEXIT" true --private-key "$ALICE_PRIVATE_KEY" >/dev/null
  fi
}

for (( run = 1; run <= RUNS; run++ )); do
  echo "──────── run $run / $RUNS ────────"
  close_if_open
  approve_if_needed

  echo "  · Alice opens a Position ($COLLATERAL_AVAX AVAX / $BORROW_MUSDC mUSDC)"
  rpc call "$POOL" 'openPosition(uint256)' "$BORROW_WEI" --value "$COLLATERAL_WEI" --from "$ALICE" >/dev/null
  rpc send "$POOL" 'openPosition(uint256)' "$BORROW_WEI" --value "$COLLATERAL_WEI" --private-key "$ALICE_PRIVATE_KEY" >/dev/null

  echo "  · Alice sets her Exit rule at $MIN_BPS bps (re-arms it)"
  rpc send "$GOVEXIT" 'setRule(uint256)' "$MIN_BPS" --private-key "$ALICE_PRIVATE_KEY" >/dev/null

  echo "  · Demo Admin queues a $PROPOSED_BPS bps Proposal"
  queue_receipt="$(rpc send "$GOVERNANCE" 'queueThresholdChange(uint256)' "$PROPOSED_BPS" --private-key "$DEMO_ADMIN_PRIVATE_KEY" --json)"
  proposal_topic="$(jq -r --arg sig "$QUEUE_SIG" '[.logs[] | select(.topics[0]==$sig) | .topics[1]] | last' <<<"$queue_receipt")"
  if [[ -z "$proposal_topic" || "$proposal_topic" == "null" ]]; then
    echo "error: the queue transaction emitted no ProposalQueued event" >&2
    exit 1
  fi
  PROPOSAL_ID="$(( proposal_topic ))"

  if [[ "$(rpc call "$GOVEXIT" 'shouldExit(address,uint256)(bool)' "$ALICE" "$PROPOSAL_ID" --json | jq -r '.[0]')" != "true" ]]; then
    echo "error: shouldExit is false for proposal $PROPOSAL_ID — aborting" >&2
    exit 1
  fi

  echo "  · Keeper calls checkAndExit(alice, $PROPOSAL_ID) — no Alice signature"
  exit_receipt="$(rpc send "$GOVEXIT" 'checkAndExit(address,uint256)' "$ALICE" "$PROPOSAL_ID" --private-key "$KEEPER_PRIVATE_KEY" --json)"
  EXIT_TX="$(jq -r '.transactionHash' <<<"$exit_receipt")"
  EXIT_BLOCK="$(( $(jq -r '.blockNumber' <<<"$exit_receipt") ))"

  pos="$(rpc call "$POOL" 'positions(address)(uint256,uint256,bool)' "$ALICE" --json)"
  rule="$(rpc call "$GOVEXIT" 'rules(address)(uint256,bool,bool)' "$ALICE" --json)"
  echo "  ✓ proposal $PROPOSAL_ID closed the Position"
  echo "      Position  ($(jq -r '.[0]' <<<"$pos") wei Collateral, $(jq -r '.[1]' <<<"$pos") wei Debt, active=$(jq -r '.[2]' <<<"$pos"))"
  echo "      Rule      ($(jq -r '.[0]' <<<"$rule") bps, active=$(jq -r '.[1]' <<<"$rule"), triggered=$(jq -r '.[2]' <<<"$rule"))"
  echo "      exit tx   $EXIT_TX (block $EXIT_BLOCK)"
  echo "      explorer  $SNOWTRACE/$EXIT_TX"
  echo
done

echo "Done — $RUNS run(s) complete."
