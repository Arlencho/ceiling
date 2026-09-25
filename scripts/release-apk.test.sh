#!/usr/bin/env bash
# Offline fixtures: real ZIPs, fake Android SDK commands, no device or signing keys.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release-apk.sh"
CASE="$(mktemp -d)"
trap 'rm -rf "$CASE"' EXIT
mkdir -p "$CASE/bin" "$CASE/assets" "$CASE/output"
# Keep PATH deterministic even when an Android SDK is installed on the host.
for tool in bash dirname basename mktemp rm sed grep git unzip shasum wc tr cat chmod; do
  ln -s "$(command -v "$tool")" "$CASE/bin/$tool"
done
export PATH="$CASE/bin"
fail() { echo "not ok - $1"; exit 1; }
run() {
  rc=0
  "$SCRIPT" "$CASE/output/release.apk" >"$CASE/stdout" 2>"$CASE/stderr" || rc=$?
  if grep -aEqi 'https?://|private-test-key' "$CASE/stdout" "$CASE/stderr" "$CASE/output/release-notes.md" 2>/dev/null; then
    fail 'output disclosed a URL or credential'
  fi
}
run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'APK file' "$CASE/stderr"; }; then fail 'refuses a missing file clearly'; fi
echo 'ok - refuses a missing file'
cat >"$CASE/bin/aapt2" <<'SDK'
#!/usr/bin/env bash
[[ "$1 $2" == 'dump badging' ]] || exit 1
printf "package: name='app.veto' versionCode='7' versionName='1.2.3'\n"
printf 'https://rpc.example.test/private-test-key\n' >&2
SDK
cat >"$CASE/bin/apksigner" <<'SDK'
#!/usr/bin/env bash
[[ "$1 $2" == 'verify --print-certs' ]] || exit 1
printf 'Signer #1 certificate DN: https://rpc.example.test/private-test-key\n'
printf 'Signer #1 certificate SHA-256 digest: %064d\n' 1
exit "${SIGNATURE_FAIL:-0}"
SDK
chmod +x "$CASE/bin/aapt2" "$CASE/bin/apksigner"
# zip is only used to construct fixtures, outside the isolated PATH.
ZIP=/usr/bin/zip
bundle() {
  printf '%s\000%s\000%s\n' "$1" "$2" "$3" >"$CASE/assets/index.android.bundle"
  rm -f "$CASE/output/release.apk"
  (cd "$CASE" && "$ZIP" -q output/release.apk assets/index.android.bundle)
}
PROGRAM=3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export EXPO_PUBLIC_VETO_RPC=https://rpc.example.test/private-test-key
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC"
run
[[ "$rc" == 0 ]] || fail 'valid APK inspection succeeds'
NOTES="$CASE/output/release-notes.md"
for fact in 'Metadata tool: aapt2' 'Package: app.veto' 'versionCode: 7' 'versionName: 1.2.3' 'Signature verifies: yes' 'RPC present: yes' 'adb install release.apk' 'Solana devnet. Devnet USDC is a test token with no value.'; do
  grep -Fxq "$fact" "$NOTES" || fail 'release notes contain the required facts'
done
grep -Fxq "Main commit: $(git -C "$ROOT" rev-parse main)" "$NOTES" || fail 'notes record main'
grep -Fxq "File SHA-256: $(shasum -a 256 <"$CASE/output/release.apk" | sed 's/ .*//')" "$NOTES" || fail 'notes record file hash'
grep -Fxq "Signing certificate SHA-256: $(printf '%064d' 1)" "$NOTES" || fail 'notes record signing fingerprint'
grep -Fxq "Size (bytes): $(wc -c <"$CASE/output/release.apk" | tr -d '[:space:]')" "$NOTES" || fail 'notes record file size'
grep -Fxq "Program id $PROGRAM present: yes" "$NOTES" || fail 'notes record program presence'
grep -Fxq "Devnet USDC mint $MINT present: yes" "$NOTES" || fail 'notes record mint presence'
echo 'ok - produces notes without URLs from binary bundle or SDK output'
SIGNATURE_FAIL=1 run
if ! { [[ "$rc" -ne 0 ]] && grep -Fxq 'Signature verifies: no' "$NOTES"; }; then fail 'rejects failed signature'; fi
echo 'ok - rejects failed signature'
for missing in program mint; do
  if [[ "$missing" == program ]]; then bundle '' "$MINT" ''; else bundle "$PROGRAM" '' ''; fi
  run
  [[ "$rc" -ne 0 ]] || fail 'rejects missing required address'
  grep -Fxq 'RPC present: no' "$NOTES" || fail 'reports absent RPC'
done
echo 'ok - rejects missing program or mint and reports absent RPC'
bundle "$PROGRAM" "$MINT" "$EXPO_PUBLIC_VETO_RPC"
rm "$CASE/bin/aapt2"
run
if ! { [[ "$rc" -ne 0 ]] && grep -q 'neither aapt2 nor apkanalyzer' "$CASE/stderr"; }; then fail 'explains missing SDK'; fi
cat >"$CASE/bin/apkanalyzer" <<'SDK'
#!/usr/bin/env bash
[[ "$1" == manifest ]] || exit 1
case "$2" in
  application-id) echo app.veto ;;
  version-code) echo 7 ;;
  version-name) echo 1.2.3 ;;
  *) exit 1 ;;
esac
SDK
chmod +x "$CASE/bin/apkanalyzer"
run
if ! { [[ "$rc" == 0 ]] && grep -Fxq 'Metadata tool: apkanalyzer' "$NOTES"; }; then fail 'supports apkanalyzer fallback'; fi
echo 'ok - missing SDK fails clearly and apkanalyzer fallback works'

unset EXPO_PUBLIC_VETO_RPC
bundle "$PROGRAM" "$MINT" 'https://api.devnet.solana.com'
run
[[ "$rc" == 0 ]] || fail 'recognizes known provider in a binary bundle'
grep -Fxq 'RPC present: yes' "$NOTES" || fail 'reports known provider RPC'
bundle "$PROGRAM" "$MINT" 'https://veto-hq.github.io'
run
grep -Fxq 'RPC present: no' "$NOTES" || fail 'does not mistake wallet identity for RPC'
echo 'ok - provider heuristic recognizes RPC and excludes wallet identity'
