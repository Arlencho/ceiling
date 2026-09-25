#!/usr/bin/env bash
# Hold journey.
#
#   ./scripts/hold-e2e.sh local
#     Builds the deploy arch (not the LiteSVM v0 ELF), starts
#     solana-test-validator with that program, and runs
#     sdk/e2e/holdJourney.test.ts. The test warps the clock once. A second
#     --warp-slot does not come back on solana-test-validator 4.1: the
#     snapshot written after a warp fails to load (leader id mismatch).
#
#   ./scripts/hold-e2e.sh devnet
#     Runs the same test against public devnet. The clock is not warped.
#     The payment after the delay is not claimed on that run.
#
#   ./scripts/hold-e2e.sh warp <slot>
#     Restarts the validator this script started, at <slot>. The test calls
#     this. It is not a standalone journey.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.cargo/bin:${HOME}/.avm/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

PROGRAM_ID="3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV"
RPC_PORT="${HOLD_E2E_RPC_PORT:-18999}"
FAUCET_PORT="${HOLD_E2E_FAUCET_PORT:-19900}"
GOSSIP_PORT="${HOLD_E2E_GOSSIP_PORT:-18001}"
PORT_RANGE="${HOLD_E2E_PORT_RANGE:-18010-18060}"
LEDGER_DIR=""

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v anchor >/dev/null 2>&1 || die "anchor is not on PATH. Prepend ~/.cargo/bin, ~/.avm/bin, and ~/.local/share/solana/install/active_release/bin"
  command -v solana-test-validator >/dev/null 2>&1 || die "solana-test-validator is not on PATH. Prepend ~/.local/share/solana/install/active_release/bin"
  command -v node >/dev/null 2>&1 || die "node is not on PATH"
  command -v npm >/dev/null 2>&1 || die "npm is not on PATH"
}

rpc_body() {
  local port="$1"
  curl -sf -m 2 "http://127.0.0.1:${port}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}' \
    || true
}

rpc_ready() {
  local body
  body="$(rpc_body "$1")"
  [[ "$body" == *blockhash* ]]
}

dump_validator_logs() {
  local ledger="$1"
  if [[ -f "$ledger/validator-stdout.log" ]]; then
    printf 'validator stdout:\n' >&2
    tail -80 "$ledger/validator-stdout.log" >&2 || true
  fi
  if [[ -f "$ledger/validator.log" ]]; then
    printf 'validator log:\n' >&2
    tail -80 "$ledger/validator.log" >&2 || true
  fi
}

wait_rpc() {
  local port="$1"
  local pid="$2"
  local _
  for _ in $(seq 1 80); do
    if rpc_ready "$port"; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

start_validator() {
  local ledger="$1"
  shift
  solana-test-validator \
    --quiet \
    --ledger "$ledger" \
    --bind-address 127.0.0.1 \
    --rpc-port "$RPC_PORT" \
    --faucet-port "$FAUCET_PORT" \
    --gossip-port "$GOSSIP_PORT" \
    --dynamic-port-range "$PORT_RANGE" \
    "$@" \
    >>"$ledger/validator-stdout.log" 2>&1 &
  printf '%s\n' "$!" >"$ledger/validator.pid"
}

# The pid file is the process we started. A restart also kills whatever is
# still bound to the RPC port, because that is the validator even if the
# recorded pid has already exited.
listeners_on() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return 0
  fi
  return 0
}

stop_pid() {
  local pid="$1"
  local _
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
}

stop_port() {
  local port="$1"
  local pid _
  local pids
  pids="$(listeners_on "$port")"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    stop_pid "$pid"
  done <<<"$pids"
  for _ in $(seq 1 40); do
    if ! rpc_ready "$port"; then
      return 0
    fi
    sleep 0.25
  done
  die "port ${port} is still serving"
}

cleanup() {
  local ec=$?
  local pidfile pid
  if [[ -n "$LEDGER_DIR" && -d "$LEDGER_DIR" ]]; then
    pidfile="$LEDGER_DIR/validator.pid"
    if [[ -f "$pidfile" ]]; then
      pid="$(cat "$pidfile")"
      stop_pid "$pid"
    fi
    local extra
    extra="$(listeners_on "$RPC_PORT")"
    if [[ -n "$extra" ]]; then
      while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue
        stop_pid "$pid"
      done <<<"$extra"
    fi
    if [[ "$ec" -ne 0 ]]; then
      dump_validator_logs "$LEDGER_DIR"
    fi
    rm -rf "$LEDGER_DIR"
  fi
}

cmd_warp() {
  local slot="${1:-}"
  local ledger pidfile old pid
  ledger="${HOLD_E2E_LEDGER:-}"
  [[ -n "$slot" ]] || die "usage: hold-e2e.sh warp <slot>"
  [[ "$slot" =~ ^[0-9]+$ ]] || die "warp slot must be an integer"
  [[ -n "$ledger" && -d "$ledger" ]] || die "HOLD_E2E_LEDGER is not a directory"
  pidfile="$ledger/validator.pid"
  if [[ -f "$pidfile" ]]; then
    old="$(cat "$pidfile")"
    stop_pid "$old"
  fi
  stop_port "$RPC_PORT"
  start_validator "$ledger" --warp-slot "$slot"
  pid="$(cat "$ledger/validator.pid")"
  if ! wait_rpc "$RPC_PORT" "$pid"; then
    dump_validator_logs "$ledger"
    die "validator did not come back after warp to slot ${slot}"
  fi
  log "warped local validator to slot ${slot}"
}

cmd_local() {
  local pid so
  require_tools
  # A validator rejects the v0 ELF the LiteSVM suite builds. Clear the arch
  # pin so this build is the Anchor default, and delete the shared artifact
  # so a previous v0 file cannot be reused.
  unset ANCHOR_BUILD_SBF_ARCH
  rm -f target/deploy/veto.so
  anchor build --ignore-keys
  so="$ROOT/target/deploy/veto.so"
  [[ -f "$so" ]] || die "build did not produce target/deploy/veto.so"
  if rpc_ready "$RPC_PORT"; then
    die "http://127.0.0.1:${RPC_PORT} is already in use"
  fi
  LEDGER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hold-e2e.XXXXXX")"
  trap cleanup EXIT
  start_validator "$LEDGER_DIR" --reset --bpf-program "$PROGRAM_ID" "$so"
  pid="$(cat "$LEDGER_DIR/validator.pid")"
  if ! wait_rpc "$RPC_PORT" "$pid"; then
    die "validator did not become ready"
  fi
  (cd "$ROOT/sdk" && npm ci)
  (
    cd "$ROOT/sdk"
    VETO_E2E=1 \
      VETO_CLUSTER=localnet \
      VETO_RPC="http://127.0.0.1:${RPC_PORT}" \
      VETO_PROGRAM_ID="$PROGRAM_ID" \
      HOLD_E2E_LEDGER="$LEDGER_DIR" \
      HOLD_E2E_RPC_PORT="$RPC_PORT" \
      HOLD_E2E_FAUCET_PORT="$FAUCET_PORT" \
      HOLD_E2E_WARP_SLOT="${HOLD_E2E_WARP_SLOT:-300000}" \
      npx tsx --test e2e/holdJourney.test.ts
  )
}

cmd_devnet() {
  require_tools
  (cd "$ROOT/sdk" && npm ci)
  (
    cd "$ROOT/sdk"
    VETO_E2E=1 \
      VETO_CLUSTER=devnet \
      VETO_RPC="${VETO_RPC:-https://api.devnet.solana.com}" \
      VETO_PROGRAM_ID="$PROGRAM_ID" \
      npx tsx --test e2e/holdJourney.test.ts
  )
}

case "${1:-}" in
  local) cmd_local ;;
  devnet) cmd_devnet ;;
  warp)
    shift
    cmd_warp "${1:-}"
    ;;
  *) die "usage: hold-e2e.sh local|devnet|warp <slot>" ;;
esac
