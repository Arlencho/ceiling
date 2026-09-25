#!/usr/bin/env bash
# Prove the pool script pairs wrapped SOL with Circle devnet USDC, encodes the
# enforced fee schedule, and appends only absent pool keys. No network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf 'not ok - node is available\n'
  exit 1
fi

node "${ROOT}/scripts/devnet-token-swap-pool.test.mjs"
