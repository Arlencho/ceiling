#!/usr/bin/env bash
# Prove the Cloud Run deploy script refuses missing inputs instead of
# creating a half deployment, and that it is safe to invoke twice.
# Does not talk to Google Cloud.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-watcher-cloud.sh"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -x "$SCRIPT" ]] || { echo "missing executable ${SCRIPT}"; exit 1; }

IDENTITIES=(
  VETO_RPC=http://rpc.test
  VETO_PROGRAM_ID=Prog
  VETO_MINT=Mint
  VETO_OWNER=Owner
  VETO_OWNER_TOKEN=OwnerToken
  VETO_MERCHANT=Merchant
  VETO_MERCHANT_TOKEN=MerchantToken
  VETO_AGENT=Agent
)

fake_key() {
  local path="$1"
  python3 -c 'import json,sys; json.dump([0]*64, open(sys.argv[1],"w"))' "$path"
}

run_check() {
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-/tmp}" \
    AGENT_KEY_PATH="${AGENT_KEY_PATH:-}" \
    BUCKET="${BUCKET:-}" \
    "${IDENTITIES[@]}" \
    "$SCRIPT" --check "$@"
}

DIR="$(mktemp -d)"
KEY="${DIR}/agent.json"
fake_key "$KEY"

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$SCRIPT" --check 2>&1)"; then
  bad "missing AGENT_KEY_PATH must refuse"
else
  if printf '%s' "$out" | grep -q "missing AGENT_KEY_PATH"; then
    pass "missing AGENT_KEY_PATH refuses before any deploy"
  else
    bad "missing AGENT_KEY_PATH message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="${DIR}/no-such.json" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "missing agent key file must refuse"
else
  if printf '%s' "$out" | grep -q "agent key file not found"; then
    pass "missing agent key file refuses before any deploy"
  else
    bad "missing agent key file message: ${out}"
  fi
fi

printf '%s\n' '{"not":"a keypair"}' > "${DIR}/bad.json"
if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="${DIR}/bad.json" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "invalid agent key file must refuse"
else
  if printf '%s' "$out" | grep -q "not a JSON keypair array" \
    && ! printf '%s' "$out" | grep -q 'not":"a keypair'; then
    pass "invalid agent key file refuses without printing the file"
  else
    bad "invalid agent key file message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" VETO_PROGRAM_ID=Prog VETO_MINT=Mint VETO_OWNER=Owner VETO_OWNER_TOKEN=OwnerToken VETO_MERCHANT=Merchant VETO_MERCHANT_TOKEN=MerchantToken VETO_AGENT=Agent "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep -q "missing VETO_RPC"; then
    pass "missing VETO_RPC refuses before any deploy"
  else
    bad "missing VETO_RPC message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" BUCKET="" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "missing BUCKET must refuse"
else
  if printf '%s' "$out" | grep -q "missing BUCKET"; then
    pass "missing BUCKET refuses before any deploy"
  else
    bad "missing BUCKET message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  if printf '%s' "$out" | grep -q "check ok"; then
    pass "check succeeds when every required input is present"
  else
    bad "check success message: ${out}"
  fi
else
  bad "check should succeed when every required input is present: ${out}"
fi

if out1="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)" \
  && out2="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  if printf '%s' "$out1" | grep -q "check ok" && printf '%s' "$out2" | grep -q "check ok"; then
    pass "check is safe to run twice"
  else
    bad "second check output: ${out2}"
  fi
else
  bad "running check twice must succeed"
fi

if grep -nE 'cat[[:space:]]+"?\$\{?AGENT_KEY_PATH' "$SCRIPT"; then
  bad "script must not cat AGENT_KEY_PATH"
else
  pass "script does not cat AGENT_KEY_PATH"
fi

if grep -nE 'echo[[:space:]]+"?\$\{?(SECRET|AGENT_KEY|KEYPAIR)' "$SCRIPT"; then
  bad "script must not echo a secret variable"
else
  pass "script does not echo a secret variable"
fi

rm -rf "$DIR"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'deploy-watcher-cloud checks: passed\n'
