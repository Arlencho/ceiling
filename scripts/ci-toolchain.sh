#!/usr/bin/env bash
# Install and verify the Solana and Anchor toolchain for the program CI job.
#
# The job used to run each installer exactly once, so one transient download
# error failed the whole run and blocked unrelated pull requests. Two such
# failures landed on the same day: a 500 from the release download, and a
# build provenance check that rejected a partially downloaded Anchor binary.
#
# Every install here is bounded: 3 attempts with a linear back-off, and the
# installer's own verification runs inside the attempt, so a partial download
# is never carried into the next attempt and verification is never skipped to
# get a green run. `avm install` verifies the build provenance attestation of
# the downloaded binary by default; the dangerous --skip-attestation flag is
# never passed. On top of the installer's checks, each attempt ends by running
# the installed binary and matching its reported version, and the workflow
# reruns the Anchor install and attestation check even after a cache restore.
#
# Subcommands:
#   install-anchor   retry loop: cargo install avm, avm install, avm use, verify
#   verify-anchor    exit 0 only if anchor on PATH reports the pinned version
#   install-solana   retry loop: anza installer, verify
#   verify-solana    exit 0 only if the installed solana binary runs
set -euo pipefail

ATTEMPTS=3
BACKOFF_BASE_S=10

# Anchor is pinned. The Solana CLI is not: CI installs the stable release and
# the workflow cache key rotates weekly to track it.
ANCHOR_VERSION="1.2.0"
ANCHOR_VERSION_OUTPUT="anchor-cli ${ANCHOR_VERSION}"

SOLANA_INSTALL_URL="https://release.anza.xyz/stable/install"
SOLANA_INSTALL_DIR="${HOME}/.local/share/solana/install"
SOLANA_BIN="${SOLANA_INSTALL_DIR}/active_release/bin"

log() { printf 'ci-toolchain: %s\n' "$*"; }
die() { printf 'ci-toolchain: error: %s\n' "$*" >&2; exit 1; }

backoff() {
  local attempt="$1"
  local wait_s=$((BACKOFF_BASE_S * (attempt - 1)))
  log "waiting ${wait_s}s before attempt ${attempt} of ${ATTEMPTS}"
  sleep "$wait_s"
}

verify_anchor() {
  command -v avm >/dev/null 2>&1 || return 1
  command -v anchor >/dev/null 2>&1 || return 1
  local version
  version=$(anchor --version 2>/dev/null) || return 1
  [ "$version" = "$ANCHOR_VERSION_OUTPUT" ]
}

install_anchor_once() {
  # The caller uses this function as a condition, so errexit is disabled.
  # Explicitly propagate each failure before checking the installed version.
  # avm itself is compiled once per runner; a later attempt reuses it instead
  # of paying for another cargo build.
  if ! command -v avm >/dev/null 2>&1; then
    cargo install --git https://github.com/coral-xyz/anchor avm --force || return 1
  fi
  # --force re-downloads even when a previous attempt left a binary behind,
  # so the provenance attestation check really runs on every attempt.
  avm install --force "$ANCHOR_VERSION" || return 1
  avm use "$ANCHOR_VERSION" || return 1
  verify_anchor || return 1
}

install_anchor() {
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -gt 1 ]; then
      # Drop anything a partial download left behind before trying again.
      rm -rf "${HOME}/.avm/tmp" "${HOME}/.avm/bin/anchor-${ANCHOR_VERSION}"
      backoff "$attempt"
    fi
    log "anchor install attempt ${attempt} of ${ATTEMPTS} (build provenance verification enabled)"
    if install_anchor_once; then
      log "anchor installed and verified: $(anchor --version)"
      return 0
    fi
    log "anchor install attempt ${attempt} failed verification"
  done
  die "anchor install failed ${ATTEMPTS} attempts; the binary never passed verification"
}

verify_solana() {
  [ -x "${SOLANA_BIN}/solana" ] || return 1
  "${SOLANA_BIN}/solana" --version >/dev/null 2>&1
}

install_solana_once() {
  # The installer checks the release it downloads; that check runs on every
  # attempt because the whole installer runs on every attempt.
  local installer
  installer=$(curl -sSfL "$SOLANA_INSTALL_URL") || return 1
  sh -c "$installer" || return 1
  verify_solana || return 1
}

install_solana() {
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -gt 1 ]; then
      # A partial release directory must not survive into the next attempt:
      # the installer treats an existing release as already downloaded.
      rm -rf "${SOLANA_INSTALL_DIR}/releases"
      backoff "$attempt"
    fi
    log "solana install attempt ${attempt} of ${ATTEMPTS}"
    if install_solana_once; then
      log "solana installed and verified: $("${SOLANA_BIN}/solana" --version)"
      return 0
    fi
    log "solana install attempt ${attempt} failed verification"
  done
  die "solana install failed ${ATTEMPTS} attempts; the binary never passed verification"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    install-anchor) install_anchor ;;
    verify-anchor)  verify_anchor ;;
    install-solana) install_solana ;;
    verify-solana)  verify_solana ;;
    *)
      printf 'usage: %s {install-anchor|verify-anchor|install-solana|verify-solana}\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
