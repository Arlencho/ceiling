#!/usr/bin/env bash
# Prove that a declare_id mismatch is a loud refusal naming both ids, and that
# a missing program keypair is refused rather than minted.
#
# These checks read source and exercise the keypair guards. They do not talk
# to a cluster and do not need a funded key. CI runs this file as-is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=devnet-setup.sh
source "${ROOT}/scripts/devnet-setup.sh"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -f "${ROOT}/programs/veto/src/lib.rs" ]] || { echo "missing programs/veto/src/lib.rs"; exit 1; }

id="$(declared_program_id)"
expected="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)");/\1/p' "${ROOT}/programs/veto/src/lib.rs" | head -n1)"
if [[ -n "$id" && "$id" == "$expected" ]]; then
  pass "declared_program_id reads lib.rs"
else
  bad "declared_program_id reads lib.rs (got '${id}', expected '${expected}')"
fi

if assert_program_keypair_matches_declare_id "$id"; then
  pass "matching id is accepted"
else
  bad "matching id is accepted"
fi

fake="11111111111111111111111111111111"
if out="$(assert_program_keypair_matches_declare_id "$fake" 2>&1)"; then
  bad "mismatch must refuse"
else
  if printf '%s' "$out" | grep -F -q "$fake" \
    && printf '%s' "$out" | grep -F -q "$id" \
    && printf '%s' "$out" | grep -q "the program keypair must be restored from backup"; then
    pass "mismatch names both ids and says restore from backup"
  else
    bad "mismatch message: ${out}"
  fi
fi

saved_kp="$PROGRAM_KP"
PROGRAM_KP="${ROOT}/keys/does-not-exist-program.json"
if out="$(require_backed_up_program_keypair 2>&1)"; then
  bad "missing program keypair must refuse"
else
  if printf '%s' "$out" | grep -q "keys/program.json is missing" \
    && printf '%s' "$out" | grep -q "the program keypair must be restored from backup" \
    && printf '%s' "$out" | grep -F -q "$id"; then
    pass "missing program keypair names declare_id and says restore from backup"
  else
    bad "missing keypair message: ${out}"
  fi
fi
PROGRAM_KP="$saved_kp"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'devnet-setup checks: 4 passed\n'
