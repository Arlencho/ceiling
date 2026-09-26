#!/usr/bin/env bash
# Ground truth for scripts/ci-toolchain.sh: the install is bounded (3
# attempts with back-off), verification runs on every attempt, a partial
# download is cleaned up before the next attempt, and the dangerous
# --skip-attestation flag is never passed to avm.
#
# Every scenario runs against stub cargo/avm/anchor/curl/sleep binaries in a
# scratch directory, with HOME pointed at the scratch so no real toolchain is
# touched. CI_TOOLCHAIN_UNDER_TEST overrides the script path so the suite can
# be run against a weakened copy to prove the tests go red.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${CI_TOOLCHAIN_UNDER_TEST:-$ROOT/scripts/ci-toolchain.sh}"

BASE_PATH="$PATH"
pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

[ -f "$SCRIPT" ] || { echo "no script at $SCRIPT" >&2; exit 1; }

# A fresh scratch directory with the stub bin on PATH and an empty HOME.
new_scratch() {
    STUB_DIR=$(mktemp -d)
    mkdir -p "$STUB_DIR/bin" "$STUB_DIR/home"
    export STUB_DIR
    export HOME="$STUB_DIR/home"
    export PATH="$STUB_DIR/bin:$BASE_PATH"
    write_common_stubs
}

write_common_stubs() {
    cat > "$STUB_DIR/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$STUB_DIR/sleep.log"
EOF
    cat > "$STUB_DIR/bin/cargo" <<'EOF'
#!/usr/bin/env bash
echo "cargo $*" >> "$STUB_DIR/cargo.log"
if [ "${1:-}" = "install" ]; then
  cp "$STUB_DIR/avm_stub.sh" "$STUB_DIR/bin/avm"
  chmod +x "$STUB_DIR/bin/avm"
  # Model a failed cargo install that still leaves an executable behind.
  [ ! -f "$STUB_DIR/cargo_fail" ] || exit 1
fi
EOF
    # The avm stub honors two control files in STUB_DIR:
    #   avm_fail_times      first N `avm install` calls leave a corrupt
    #                       version binary behind and exit 1 (partial download)
    #   anchor_bad_version  if present, the installed binary reports the wrong
    #                       version, so verification fails on every attempt
    cat > "$STUB_DIR/avm_stub.sh" <<'EOF'
#!/usr/bin/env bash
echo "avm $*" >> "$STUB_DIR/avm.log"
case "${1:-}" in
  install)
    n=$(cat "$STUB_DIR/avm_install_count" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$STUB_DIR/avm_install_count"
    mkdir -p "$HOME/.avm/bin"
    fail_times=$(cat "$STUB_DIR/avm_fail_times" 2>/dev/null || echo 0)
    if [ "$n" -le "$fail_times" ]; then
      printf 'corrupt partial download\n' > "$HOME/.avm/bin/anchor-1.2.0"
      exit 1
    fi
    version="anchor-cli 1.2.0"
    [ -f "$STUB_DIR/anchor_bad_version" ] && version="anchor-cli 0.0.0"
    cat > "$HOME/.avm/bin/anchor-1.2.0" <<INNER
#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo "$version"; exit 0; }
exit 0
INNER
    chmod +x "$HOME/.avm/bin/anchor-1.2.0"
    [ ! -f "$STUB_DIR/attestation_fail" ] || exit 1
    ;;
  use)
    [ ! -f "$STUB_DIR/avm_use_fail" ] || exit 1
    ln -sf "$HOME/.avm/bin/anchor-1.2.0" "$STUB_DIR/bin/anchor"
    ;;
esac
EOF
    cat > "$STUB_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_DIR/curl.log"
n=$(cat "$STUB_DIR/curl_count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_DIR/curl_count"
fail_times=$(cat "$STUB_DIR/curl_fail_times" 2>/dev/null || echo 0)
if [ "$n" -le "$fail_times" ]; then
  exit 22
fi
if [ -f "$STUB_DIR/installer_fail" ]; then
  echo 'exit 1'
  exit 0
fi
cat <<'INSTALLER'
mkdir -p "$HOME/.local/share/solana/install/active_release/bin"
cat > "$HOME/.local/share/solana/install/active_release/bin/solana" <<'INNER'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "solana-cli 4.1.2 (src:stub; feat:stub, client:Agave)"; exit 0; }
exit 0
INNER
chmod +x "$HOME/.local/share/solana/install/active_release/bin/solana"
INSTALLER
EOF
    chmod +x "$STUB_DIR/bin/sleep" "$STUB_DIR/bin/cargo" "$STUB_DIR/bin/curl"
    cp "$STUB_DIR/avm_stub.sh" "$STUB_DIR/bin/avm"
    chmod +x "$STUB_DIR/bin/avm"
}

count_lines_matching() {
    grep -c "$1" "$2" 2>/dev/null || printf '0'
}

no_skip_attestation() {
    [ ! -f "$STUB_DIR/avm.log" ] && return 0
    ! grep -q 'skip-attestation' "$STUB_DIR/avm.log"
}

# Scenario: first attempt succeeds. One install, no back-off, verification ok.
new_scratch
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(count_lines_matching 'avm install' "$STUB_DIR/avm.log")" = "1" ] \
    && [ ! -f "$STUB_DIR/sleep.log" ]; then
    ok "anchor install succeeds on the first attempt without any back-off"
else
    bad "anchor install succeeds on the first attempt without any back-off"
fi
if no_skip_attestation; then
    ok "avm is never told to skip the build provenance attestation"
else
    bad "avm is never told to skip the build provenance attestation"
fi
rm -rf "$STUB_DIR"

# Scenario: two transient failures then success. The third attempt must run,
# the back-off must grow, and the corrupt binary from the partial downloads
# must not be what finally verifies.
new_scratch
printf '2' > "$STUB_DIR/avm_fail_times"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(count_lines_matching 'avm install' "$STUB_DIR/avm.log")" = "3" ] \
    && [ "$(anchor --version)" = "anchor-cli 1.2.0" ]; then
    ok "anchor install retries through transient failures and verifies the real binary"
else
    bad "anchor install retries through transient failures and verifies the real binary"
fi
if [ "$(cat "$STUB_DIR/sleep.log")" = "$(printf 'sleep 10\nsleep 20')" ]; then
    ok "back-off grows between anchor attempts (10s then 20s)"
else
    bad "back-off grows between anchor attempts (10s then 20s): $(cat "$STUB_DIR/sleep.log" 2>/dev/null)"
fi
if no_skip_attestation; then
    ok "every anchor retry keeps the attestation check on"
else
    bad "every anchor retry keeps the attestation check on"
fi
rm -rf "$STUB_DIR"

# Scenario: verification fails on every attempt. The install must stop after
# exactly 3 attempts and exit nonzero; a wrong binary must never pass.
new_scratch
: > "$STUB_DIR/anchor_bad_version"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1; then
    bad "anchor install fails the run when verification never passes"
else
    if [ "$(count_lines_matching 'avm install' "$STUB_DIR/avm.log")" = "3" ] \
        && [ "$(count_lines_matching 'avm use' "$STUB_DIR/avm.log")" = "3" ]; then
        ok "anchor install fails the run when verification never passes"
    else
        bad "anchor install stops after exactly 3 verified attempts ($(count_lines_matching 'avm install' "$STUB_DIR/avm.log") installs, $(count_lines_matching 'avm use' "$STUB_DIR/avm.log") uses)"
    fi
fi
rm -rf "$STUB_DIR"

# Scenario: avm is missing, so the install compiles it with cargo first.
new_scratch
rm -f "$STUB_DIR/bin/avm"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(count_lines_matching 'cargo install' "$STUB_DIR/cargo.log")" = "1" ]; then
    ok "a runner without avm compiles it with cargo before installing anchor"
else
    bad "a runner without avm compiles it with cargo before installing anchor"
fi
rm -rf "$STUB_DIR"

# Scenario: verify-anchor rejects a missing toolchain and a wrong version.
new_scratch
if bash "$SCRIPT" verify-anchor >/dev/null 2>&1; then
    bad "verify-anchor refuses a runner with no anchor installed"
else
    ok "verify-anchor refuses a runner with no anchor installed"
fi
: > "$STUB_DIR/anchor_bad_version"
bash "$SCRIPT" install-anchor >/dev/null 2>&1 || true
if bash "$SCRIPT" verify-anchor >/dev/null 2>&1; then
    bad "verify-anchor refuses an anchor that reports the wrong version"
else
    ok "verify-anchor refuses an anchor that reports the wrong version"
fi
rm -rf "$STUB_DIR"

# Scenario: solana download 500s twice, then succeeds on the third attempt.
new_scratch
printf '2' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ "$(count_lines_matching 'curl' "$STUB_DIR/curl.log")" = "3" ] \
    && [ "$(cat "$STUB_DIR/sleep.log")" = "$(printf 'sleep 10\nsleep 20')" ]; then
    ok "solana install retries through release download errors with growing back-off"
else
    bad "solana install retries through release download errors with growing back-off"
fi
rm -rf "$STUB_DIR"

# Scenario: a stale partial release directory is removed before the retry, so
# the installer cannot mistake it for a completed download.
new_scratch
printf '1' > "$STUB_DIR/curl_fail_times"
mkdir -p "$STUB_DIR/home/.local/share/solana/install/releases/partial"
: > "$STUB_DIR/home/.local/share/solana/install/releases/partial/marker"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ ! -e "$STUB_DIR/home/.local/share/solana/install/releases/partial/marker" ]; then
    ok "a partial solana download is cleaned up before the next attempt"
else
    bad "a partial solana download is cleaned up before the next attempt"
fi
rm -rf "$STUB_DIR"

# Scenario: every solana attempt fails. Stop after 3, exit nonzero.
new_scratch
printf '9' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1; then
    bad "solana install fails the run after 3 failed attempts"
else
    if [ "$(count_lines_matching 'curl' "$STUB_DIR/curl.log")" = "3" ]; then
        ok "solana install fails the run after 3 failed attempts"
    else
        bad "solana install stops after exactly 3 attempts (curl ran $(count_lines_matching 'curl' "$STUB_DIR/curl.log") times)"
    fi
fi
rm -rf "$STUB_DIR"

# Scenario: verify-solana rejects a missing install.
new_scratch
if bash "$SCRIPT" verify-solana >/dev/null 2>&1; then
    bad "verify-solana refuses a runner with no solana installed"
else
    ok "verify-solana refuses a runner with no solana installed"
fi
rm -rf "$STUB_DIR"

# Failed commands cannot be masked by a valid binary from a previous install.
for failure in attestation_fail avm_use_fail; do
    new_scratch
    bash "$SCRIPT" install-anchor >/dev/null 2>&1
    : > "$STUB_DIR/$failure"
    # Keep a correct-looking binary independent of the cleaned download path.
    cp "$HOME/.avm/bin/anchor-1.2.0" "$STUB_DIR/bin/cached-anchor"
    ln -sf "$STUB_DIR/bin/cached-anchor" "$STUB_DIR/bin/anchor"
    : > "$STUB_DIR/avm.log"
    if bash "$SCRIPT" install-anchor >"$STUB_DIR/result.log" 2>&1; then
        bad "$failure rejects a correct-looking cached binary"
    elif [ "$(count_lines_matching 'failed verification' "$STUB_DIR/result.log")" = 3 ]; then
        ok "$failure rejects a correct-looking cached binary after three attempts"
    else
        bad "$failure exhausts exactly three attempts"
    fi
    rm -rf "$STUB_DIR"
done

# Cargo can fail after creating avm. That attempt must fail before avm runs.
new_scratch
rm -f "$STUB_DIR/bin/avm"
: > "$STUB_DIR/cargo_fail"
if bash "$SCRIPT" install-anchor >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/sleep.log" 2>/dev/null)" = "sleep 10" ] \
    && [ "$(count_lines_matching 'avm install' "$STUB_DIR/avm.log")" = 1 ]; then
    ok "failed cargo install retries before using the executable it left behind"
else
    bad "failed cargo install retries before using the executable it left behind"
fi
rm -rf "$STUB_DIR"

# Execute the actual workflow install step with a cache hit and failed attestation.
new_scratch
bash "$SCRIPT" install-anchor >/dev/null 2>&1
: > "$STUB_DIR/attestation_fail"
: > "$STUB_DIR/avm.log"
awk '
  /- name: Install Anchor/ { step=1; next }
  step && /^      - name:/ { exit }
  step && /run: \|/ { body=1; next }
  body {
    sub(/^          /, "")
    gsub(/\$\{\{[^}]*\}\}/, "true")
    print
  }
' "$ROOT/.github/workflows/ci.yml" > "$STUB_DIR/cache-step.sh"
if (cd "$ROOT" && bash -e "$STUB_DIR/cache-step.sh") >/dev/null 2>&1; then
    bad "Anchor cache hit must still pass provenance verification"
elif [ "$(count_lines_matching 'avm install --force' "$STUB_DIR/avm.log")" = 3 ]; then
    ok "Anchor cache hit must still pass provenance verification on every retry"
else
    bad "Anchor cache hit retries provenance verification three times"
fi
rm -rf "$STUB_DIR"

for failure in curl_fail_times installer_fail; do
    new_scratch
    bash "$SCRIPT" install-solana >/dev/null 2>&1
    printf '9' > "$STUB_DIR/$failure"
    : > "$STUB_DIR/curl.log"
    if bash "$SCRIPT" install-solana >/dev/null 2>&1; then
        bad "$failure rejects an existing runnable Solana binary"
    elif [ "$(count_lines_matching curl "$STUB_DIR/curl.log")" = 3 ]; then
        ok "$failure rejects an existing runnable Solana binary after three attempts"
    else
        bad "$failure exhausts exactly three Solana attempts"
    fi
    rm -rf "$STUB_DIR"
done

# A cached Solana binary must not short-circuit a transient download retry.
new_scratch
bash "$SCRIPT" install-solana >/dev/null 2>&1
printf '0' > "$STUB_DIR/curl_count"
printf '1' > "$STUB_DIR/curl_fail_times"
if bash "$SCRIPT" install-solana >/dev/null 2>&1 \
    && [ "$(cat "$STUB_DIR/curl_count")" = 2 ] \
    && bash "$SCRIPT" verify-solana; then
    ok "transient download failure retries before accepting cached Solana"
else
    bad "transient download failure retries before accepting cached Solana"
fi
rm -rf "$STUB_DIR"

printf 'ci-toolchain checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
