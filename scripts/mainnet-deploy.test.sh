#!/usr/bin/env bash
# Offline behavioral checks. All chain and build commands are replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"/{scripts,docs,keys,bin,programs/veto/src,target/deploy}
cp "$ROOT/scripts/mainnet-deploy.sh" "$TMP/scripts/"
export CALLS="$TMP/calls" CASE=ok
export VETO_MAINNET_RPC='https://rpc.invalid/?api-key=secret-marker'
export ANCHOR_BUILD_SBF_ARCH=v0
export REAL_GIT
REAL_GIT="$(command -v git)"
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  status)
    [[ "$CASE" != git-fail ]] || exit 1
    if [[ "$CASE" == dirty || ( "$CASE" == build-dirty && -f build-marker ) ]]; then
      echo '?? untracked'
      exit 0
    fi;;
esac
exec "$REAL_GIT" "$@"
STUB
cat > "$TMP/bin/solana-keygen" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$2" == keys/program.json ]]; then
  [[ "$CASE" != mismatch ]] || { echo wrong; exit; }
  echo program
else
  echo deployer
fi
STUB
cat > "$TMP/bin/anchor" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${ANCHOR_BUILD_SBF_ARCH:-}" ]]
[[ "$*" == 'build --no-idl' ]]
[[ ! -e target/deploy/veto.so ]]
echo build >> "$CALLS"
[[ "$CASE" != build-fail ]] || exit 1
printf 'fresh-deploy-elf' > target/deploy/veto.so
[[ "$CASE" != build-dirty ]] || touch build-marker
STUB
cat > "$TMP/bin/solana" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS"
[[ "$*" == *"--url $VETO_MAINNET_RPC"* ]]
if [[ "$CASE" == rpc-fail ]]; then
  echo "$VETO_MAINNET_RPC" >&2
  exit 1
fi
case "$1 $2" in
  'genesis-hash --url')
    [[ "$CASE" != genesis ]] || { echo wrong; exit; }
    echo 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d;;
  'balance deployer')
    case "$CASE" in
      poor) echo '4999999999 lamports';;
      malformed) echo 'unknown lamports';;
      *) echo '5000000000 lamports';;
    esac;;
  'rent '*) echo 'Rent-exempt minimum: 12345 lamports';;
  'program deploy')
    [[ "$*" == *'--program-id keys/program.json --upgrade-authority keys/deployer.json'* ]]
    [[ "$*" == *'--with-compute-unit-price 5000'* ]]
    [[ "$*" == *'--keypair keys/deployer.json'* ]]
    [[ "$*" == *'--fee-payer keys/deployer.json'* ]]
    [[ "$CASE" != deploy-fail ]] || exit 1
    echo '{"programId":"program","signature":"1111111111111111111111111111111111111111111111111111111111111111"}';;
  'program show')
    [[ "$CASE" != show-fail ]] || exit 1
    echo '{"programId":"program","authority":"deployer","lastDeploySlot":123}';;
  *) exit 90;;
esac
STUB
chmod +x "$TMP/bin/"*
printf 'declare_id!("program");\n' > "$TMP/programs/veto/src/lib.rs"
touch "$TMP/keys/"{program,deployer}.json
printf '*\n' > "$TMP/.gitignore"
printf '## Deploy log\n' > "$TMP/docs/MAINNET.md"
git -C "$TMP" init -q
git -C "$TMP" config user.name 'Offline Test'
git -C "$TMP" config user.email 'offline@example.invalid'
git -C "$TMP" config commit.gpgsign false
git -C "$TMP" config tag.gpgsign false
git -C "$TMP" add -f .gitignore scripts/mainnet-deploy.sh docs/MAINNET.md programs/veto/src/lib.rs
git -C "$TMP" commit -qm fixture
commit="$(git -C "$TMP" rev-parse HEAD)"
reset_fixture() {
  printf '## Deploy log\n' > "$TMP/docs/MAINNET.md"
  while IFS= read -r tag; do
    git -C "$TMP" tag -d "$tag" >/dev/null
  done < <(git -C "$TMP" tag -l)
  git -C "$TMP" tag -a mainnet-deploy-test -m 'Reviewed offline deployment fixture'

  printf stale-v0 > "$TMP/target/deploy/veto.so"
  rm -f "$TMP/build-marker"
  : > "$CALLS"
}
refuse() {
  local expected="$1"
  shift
  if (cd "$TMP" && printf '%s\n' "${ANSWER:-DEPLOY}" | bash scripts/mainnet-deploy.sh "$@") > "$TMP/output" 2>&1; then
    echo "not ok - $CASE accepted"; exit 1
  fi
  grep -Fq "$expected" "$TMP/output" || { cat "$TMP/output"; exit 1; }
  if grep -q 'program deploy' "$CALLS"; then exit 1; fi
  if grep -q secret-marker "$TMP/output"; then exit 1; fi
  echo "ok - $CASE refuses: $expected"
}
for CASE in mismatch dirty git-fail genesis poor malformed rpc-fail build-fail build-dirty; do
  reset_fixture
  case "$CASE" in
    mismatch) expected=declare_id;; dirty|git-fail|build-dirty) expected='working tree';;
    genesis) expected=mainnet;; poor|malformed) expected='5 SOL';;
    rpc-fail) expected='RPC command failed';; build-fail) expected='build failed';;
  esac
  refuse "$expected" --dry-run
done
CASE=ok
reset_fixture
VETO_MAINNET_RPC='' refuse VETO_MAINNET_RPC --dry-run
for CASE in untagged lightweight wrong-tag ancestor-tag; do
  reset_fixture
  git -C "$TMP" tag -d mainnet-deploy-test >/dev/null
  case "$CASE" in
    lightweight) git -C "$TMP" tag mainnet-deploy-test;;
    wrong-tag) git -C "$TMP" tag -a release-test -m 'Wrong prefix';;
    ancestor-tag)
      git -C "$TMP" tag -a mainnet-deploy-test -m 'Previous commit'
      git -C "$TMP" commit --allow-empty -qm 'Untagged successor';;
  esac
  refuse 'annotated mainnet-deploy-* tag' --dry-run
  [[ ! -s "$CALLS" ]]
  if [[ "$CASE" == ancestor-tag ]]; then
    git -C "$TMP" checkout -q "$commit"
  fi
done
CASE=ok
for key in program deployer; do
  reset_fixture
  rm "$TMP/keys/$key.json"
  refuse "keys/$key.json" --dry-run
  touch "$TMP/keys/$key.json"
done
reset_fixture
ANSWER=no refuse 'confirmation' --dry-run
reset_fixture
if (cd "$TMP" && bash scripts/mainnet-deploy.sh --dry-run < /dev/null) > "$TMP/output" 2>&1; then exit 1; fi
grep -q 'confirmation required' "$TMP/output"
if grep -q 'program deploy' "$CALLS"; then exit 1; fi
echo 'ok - EOF cannot confirm deployment'
reset_fixture
refuse 'unknown argument' --bad
reset_fixture
(cd "$TMP" && printf 'DEPLOY\n' | bash scripts/mainnet-deploy.sh --dry-run) > "$TMP/output" 2>&1
grep -q 'Attestation tag: mainnet-deploy-test' "$TMP/output"
grep -q 'Reviewed offline deployment fixture' "$TMP/output"
grep -q 'SHA256:' "$TMP/output"
grep -q 'Program size: 16 bytes' "$TMP/output"
grep -q 'rent 61 ' "$CALLS"
grep -q 'rent 36 ' "$CALLS"
if grep -q 'program deploy' "$CALLS"; then exit 1; fi
if grep -q 'Signature:' "$TMP/docs/MAINNET.md"; then exit 1; fi
echo 'ok - dry run builds fresh deploy arch and prints size, rent and digest without deploying'
reset_fixture
(cd "$TMP" && printf 'DEPLOY\n' | bash scripts/mainnet-deploy.sh) > "$TMP/output" 2>&1
grep -q 'program show' "$CALLS"
grep -q 'Slot: 123' "$TMP/docs/MAINNET.md"
grep -q 'Signature: 111111' "$TMP/docs/MAINNET.md"
grep -q 'SHA256:' "$TMP/docs/MAINNET.md"
grep -q "Commit: $commit" "$TMP/docs/MAINNET.md"
if grep -q secret-marker "$TMP/output"; then exit 1; fi
echo 'ok - deploy uses explicit signers and records verified receipt'
for CASE in deploy-fail show-fail; do
  reset_fixture
  if (cd "$TMP" && printf 'DEPLOY\n' | bash scripts/mainnet-deploy.sh) > "$TMP/output" 2>&1; then exit 1; fi
  if grep -q 'Signature:' "$TMP/docs/MAINNET.md"; then exit 1; fi
  echo "ok - $CASE does not append a success record"
done
