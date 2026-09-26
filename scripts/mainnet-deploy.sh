#!/usr/bin/env bash
# Guarded, operator-confirmed deployment. Never selects an RPC implicitly.
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# == 0 ]] || die 'unknown argument; usage: mainnet-deploy.sh [--dry-run]'
[[ -n "${VETO_MAINNET_RPC:-}" ]] || die 'missing VETO_MAINNET_RPC'
RPC="$VETO_MAINNET_RPC"
# Do not relay CLI errors: they can include the full credential-bearing URL.
# No endpoint is printed, including its query string.
rpc() {
  solana "$@" --url "$RPC" --commitment finalized 2>/dev/null \
    || die 'RPC command failed (endpoint and query string masked)'
}
for cmd in git solana solana-keygen anchor python3; do
  command -v "$cmd" >/dev/null || die "missing required command: $cmd"
done
for key in program deployer; do
  [[ -f "keys/$key.json" ]] || die "missing keys/$key.json; restore the backed-up keypair"
done
program="$(solana-keygen pubkey keys/program.json 2>/dev/null)"
deployer="$(solana-keygen pubkey keys/deployer.json 2>/dev/null)"
declared="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)");/\1/p' programs/veto/src/lib.rs)"
[[ -n "$declared" && "$program" == "$declared" ]] || die 'program keypair does not match declare_id'
check_checkout() {
  local status
  status="$(git status --porcelain --untracked-files=all)" || die 'cannot inspect working tree'
  [[ -z "$status" ]] || die 'working tree must be clean'
  head="$(git rev-parse HEAD)"
  tag="$(git describe --exact-match --tags --match 'mainnet-deploy-*' HEAD 2>/dev/null)" \
    || die 'HEAD must carry an exact annotated mainnet-deploy-* tag'
  [[ "$tag" == mainnet-deploy-* && "$(git cat-file -t "refs/tags/$tag")" == tag ]] \
    || die 'HEAD must carry an exact annotated mainnet-deploy-* tag'
}
check_checkout
commit="$head"
printf 'Attestation tag: %s\n' "$tag"
git for-each-ref --format='%(contents)' "refs/tags/$tag"
[[ "$(grep -c '^## Deploy log$' docs/MAINNET.md)" == 1 ]] || die 'missing or duplicate Deploy log section'
check_chain() {
  [[ "$(rpc genesis-hash)" == 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d ]] \
    || die 'RPC genesis hash is not mainnet'
  local balance
  balance="$(rpc balance "$deployer" --lamports)"
  python3 - "$balance" <<'PY' || die 'deployer must hold at least 5 SOL; invalid or insufficient balance'
import re, sys
m = re.fullmatch(r'([0-9]+) lamports', sys.argv[1].strip())
sys.exit(0 if m and int(m[1]) >= 5_000_000_000 else 1)
PY
}
check_chain
# Match the devnet deployment architecture. Remove any LiteSVM test artifact.
# The key already matches declare_id, so no source rewrite by keys sync is needed.
unset ANCHOR_BUILD_SBF_ARCH
mkdir -p target/deploy
cp keys/program.json target/deploy/veto-keypair.json
rm -f target/deploy/veto.so
anchor build --no-idl >/dev/null 2>&1 || die 'deploy build failed'
[[ -s target/deploy/veto.so ]] || die 'build produced no program'
read -r size sha256 < <(python3 - <<'PY'
import hashlib
from pathlib import Path
b = Path('target/deploy/veto.so').read_bytes()
print(len(b), hashlib.sha256(b).hexdigest())
PY
)
printf 'Program size: %s bytes\nSHA256: %s\n' "$size" "$sha256"
# Upgradeable loader headers: ProgramData 45, Program 36, Buffer 37 bytes.
# Explicit max-len below avoids reserving an implicit multiple of the ELF size.
for entry in "ProgramData:$((size + 45))" 'Program:36' "Temporary-buffer:$((size + 37))"; do
  rent="$(rpc rent "${entry#*:}" --lamports)"
  [[ "$rent" =~ ^Rent-exempt\ minimum:\ [0-9]+\ lamports$ ]] || die 'invalid rent response'
  printf '%s rent: %s\n' "${entry%%:*}" "$rent"
done
printf 'ProgramData and Program rent remain locked; buffer rent is temporary. Fees are additional.\n'
check_checkout
[[ "$head" == "$commit" ]] || die 'HEAD changed during build'
printf 'Type DEPLOY to confirm (also required for dry run): '
IFS= read -r answer || die 'confirmation required'
[[ "$answer" == DEPLOY ]] || die 'confirmation must be DEPLOY'
if "$dry_run"; then
  printf 'Dry run complete; no deployment or log entry.\n'
  exit 0
fi
check_checkout
[[ "$head" == "$commit" ]] || die 'HEAD changed before deploy'
check_chain
receipt="$(rpc program deploy target/deploy/veto.so \
  --program-id keys/program.json --upgrade-authority keys/deployer.json \
  --keypair keys/deployer.json --fee-payer keys/deployer.json \
  --with-compute-unit-price 5000 --max-len "$size" --output json)"
shown="$(rpc program show "$program" --output json)"
# Only validated fields reach stdout or the public runbook, never raw CLI output.
python3 - "$receipt" "$shown" "$program" "$deployer" "$sha256" "$commit" <<'PY'
import datetime, json, re, sys
from pathlib import Path
receipt, shown = map(json.loads, sys.argv[1:3])
program, deployer, digest, commit = sys.argv[3:]
sig = receipt.get('signature', '')
slot = shown.get('lastDeploySlot')
if not (receipt.get('programId') == shown.get('programId') == program
        and shown.get('authority') == deployer
        and isinstance(slot, int) and not isinstance(slot, bool) and slot >= 0
        and isinstance(sig, str) and re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{64,88}', sig)):
    sys.exit('error: deployment receipt or program verification invalid; reconcile on chain before retrying')
when = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
entry = f'\n- Date: {when}; Slot: {slot}; Signature: {sig}; SHA256: {digest}; Commit: {commit}\n'
path = Path('docs/MAINNET.md')
text = path.read_text()
heading = '## Deploy log\n'
start = text.index(heading) + len(heading)
end = text.find('\n## ', start)
if end == -1:
    end = len(text)
path.write_text(text[:end] + entry + text[end:])
print(entry.strip())
PY
