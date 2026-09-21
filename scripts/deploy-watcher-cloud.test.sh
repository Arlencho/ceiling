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

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" VETO_RPC=http://rpc.test VETO_MINT=Mint VETO_OWNER=Owner VETO_OWNER_TOKEN=OwnerToken VETO_MERCHANT=Merchant VETO_MERCHANT_TOKEN=MerchantToken VETO_AGENT=Agent "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_PROGRAM_ID must refuse"
else
  if printf '%s' "$out" | grep -q "missing VETO_PROGRAM_ID"; then
    pass "missing VETO_PROGRAM_ID refuses before any deploy"
  else
    bad "missing VETO_PROGRAM_ID message: ${out}"
  fi
fi

FAKE_BIN="${DIR}/bin"
mkdir -p "$FAKE_BIN"
FAKE_LOG="${DIR}/gcloud.log"
cat > "${FAKE_BIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_GCLOUD_LOG}"
case " $* " in
  *" auth list "*) printf 'owner@example.com\n' ;;
  *" projects describe "*) printf '123456789\n' ;;
  *" monitoring policies list "*) printf 'projects/veto-watcher-260921/alertPolicies/1\n' ;;
  *" monitoring channels list "*) printf '\n' ;;
esac
exit 0
EOF
chmod +x "${FAKE_BIN}/gcloud"

DRY_ENV=(
  env -i
  PATH="${FAKE_BIN}:${PATH}"
  HOME="${DIR}"
  FAKE_GCLOUD_LOG="$FAKE_LOG"
  AGENT_KEY_PATH="$KEY"
  "${IDENTITIES[@]}"
)
if out1="$("${DRY_ENV[@]}" "$SCRIPT" --dry-run 2>&1)" \
  && out2="$("${DRY_ENV[@]}" "$SCRIPT" --dry-run 2>&1)"; then
  if printf '%s\n' "$out1" "$out2" | grep -qE 'storage rm|buckets delete|secrets delete|jobs delete' ; then
    bad "dry-run twice must not delete the journal, secret, or jobs"
  elif printf '%s' "$out1" | grep -q 'dry-run:' && printf '%s' "$out2" | grep -q 'dry-run:'; then
    if printf '%s' "$out1$out2" | grep -q '\[0, 0, 0'; then
      bad "dry-run printed key bytes"
    else
      pass "dry-run twice is safe (no delete, no key bytes)"
    fi
  else
    bad "dry-run twice output missing dry-run prefix: ${out2}"
  fi
else
  if printf '%s' "${out1-}${out2-}" | grep -q 'env_file: unbound variable'; then
    bad "EXIT trap references local env_file after deploy returns; script exits 1 after printing deployed"
  else
    bad "dry-run twice must succeed: ${out1-}${out2-}"
  fi
fi

if printf '%s' "$out1" | grep -q "storage cp" && printf '%s' "$out1" | grep -q "decisions.jsonl"; then
  bad "dry-run with an existing journal object must not upload a replacement"
else
  pass "dry-run does not wipe an existing journal object"
fi

rm -rf "$DIR"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'deploy-watcher-cloud checks: passed\n'
