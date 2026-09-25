#!/usr/bin/env bash
# Inspect locally; never publish the APK or pass SDK diagnostics to the terminal.
set +x
set -euo pipefail
export LC_ALL=C
umask 077
fail() { printf 'release-apk: %s\n' "$1" >&2; exit 1; }
[[ $# == 1 ]] || fail 'usage: scripts/release-apk.sh <path to apk>'
[[ -f "$1" && -r "$1" ]] || fail 'APK file is missing or unreadable'
# Restrict printed filenames so the install command cannot disclose a URL or
# contain shell syntax. Paths themselves are never printed.
name="$(basename "$1")"
[[ "$name" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.apk$ ]] || fail 'use a simple APK filename ending in .apk'
apk="$(cd "$(dirname "$1")" && pwd)/$name"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v aapt2 >/dev/null 2>&1; then
  metadata_tool=aapt2
elif command -v apkanalyzer >/dev/null 2>&1; then
  metadata_tool=apkanalyzer
else
  fail 'neither aapt2 nor apkanalyzer is on PATH; add Android SDK tools to PATH'
fi
command -v apksigner >/dev/null 2>&1 || fail 'apksigner is not on PATH; add Android SDK build-tools to PATH'
command -v unzip >/dev/null 2>&1 || fail 'unzip is not on PATH'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Raw output can contain certificate subjects, manifest values or URLs.
if [[ "$metadata_tool" == aapt2 ]]; then
  aapt2 dump badging "$apk" >"$work/metadata" 2>"$work/errors" || fail 'aapt2 could not read APK metadata'
  package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" "$work/metadata")"
  version_code="$(sed -n "s/^package: .*versionCode='\([^']*\)'.*/\1/p" "$work/metadata")"
  version_name="$(sed -n "s/^package: .*versionName='\([^']*\)'.*/\1/p" "$work/metadata")"
  target_sdk="$(sed -n "s/^targetSdkVersion:'\([0-9]*\)'.*/\1/p" "$work/metadata")"
  sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" "$work/metadata" | sort -u >"$work/permissions"
  aapt2 dump xmltree "$apk" --file AndroidManifest.xml >"$work/manifest" 2>"$work/errors" || fail 'aapt2 could not read the manifest'
else
  package="$(apkanalyzer manifest application-id "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read package'
  version_code="$(apkanalyzer manifest version-code "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read versionCode'
  version_name="$(apkanalyzer manifest version-name "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read versionName'
  target_sdk="$(apkanalyzer manifest target-sdk "$apk" 2>"$work/errors")" || fail 'apkanalyzer could not read targetSdk'
  apkanalyzer manifest permissions "$apk" 2>"$work/errors" | sort -u >"$work/permissions" || fail 'apkanalyzer could not read permissions'
  apkanalyzer manifest print "$apk" >"$work/manifest" 2>"$work/errors" || fail 'apkanalyzer could not read the manifest'
fi
[[ "$package" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]] || fail 'invalid package metadata'
[[ "$version_code" =~ ^[0-9]+$ ]] || fail 'invalid versionCode metadata'
[[ "$version_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$ ]] || fail 'invalid versionName metadata'
[[ "$target_sdk" =~ ^[0-9]+$ ]] || fail 'invalid targetSdk metadata'
# The release is com.veto.app, as android.package in app/app.json.
[[ "$package" == com.veto.app ]] || fail "package is $package, not com.veto.app"
# Google Play requires targetSdk 36 for new releases.
[[ "$target_sdk" -ge 36 ]] || fail "targetSdk $target_sdk is below 36"
# The blocked list mirrors android.blockedPermissions in app/app.json. That
# list still blocks VIBRATE (expo-haptics is not a dependency), so it is
# blocked here too.
blocked_permissions='android.permission.SYSTEM_ALERT_WINDOW android.permission.READ_EXTERNAL_STORAGE android.permission.WRITE_EXTERNAL_STORAGE android.permission.VIBRATE'
while IFS= read -r permission; do
  [[ -z "$permission" ]] && continue
  [[ "$permission" =~ ^[a-zA-Z][a-zA-Z0-9_.]*$ ]] || fail 'invalid permission metadata'
  for blocked in $blocked_permissions; do
    [[ "$permission" == "$blocked" ]] && fail "blocked permission present: $blocked"
  done
done <"$work/permissions"
# URL schemes come from the manifest as scheme="value" pairs, in both
# aapt2 xmltree and apkanalyzer print output.
{ grep -oE 'scheme(\(0x[0-9a-fA-F]+\))?="[^"]+"' "$work/manifest" || true; } | sed -E 's/.*="([^"]*)"/\1/' | sort -u >"$work/schemes"
scheme_veto=no
while IFS= read -r scheme; do
  [[ -z "$scheme" ]] && continue
  [[ "$scheme" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*$ ]] || fail 'invalid scheme metadata'
  [[ "$scheme" == exp+* ]] && fail "development scheme present: $scheme"
  [[ "$scheme" == veto ]] && scheme_veto=yes
done <"$work/schemes"
[[ "$scheme_veto" == yes ]] || fail 'the veto scheme is missing from the manifest'
signature=no
if apksigner verify --print-certs "$apk" >"$work/signature" 2>&1; then signature=yes; fi
fingerprints="$(sed -nE 's/^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$/\1/p' "$work/signature")"
[[ -n "$fingerprints" ]] || { fingerprints=unavailable; signature=no; }
# Stream only the named entry, avoiding archive-controlled extraction paths.
# grep -a also handles Hermes bytecode with its binary string table.
unzip -p "$apk" assets/index.android.bundle >"$work/bundle" 2>"$work/errors" || fail 'APK has no readable assets/index.android.bundle'
program=3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
program_present=no
mint_present=no
rpc_present=no
if grep -aFq "$program" "$work/bundle"; then program_present=yes; fi
if grep -aFq "$mint" "$work/bundle"; then mint_present=yes; fi
# The release bundle is a devnet build. mainnet-beta must never appear.
if grep -aFq 'mainnet-beta' "$work/bundle"; then fail 'the bundle names mainnet-beta; do not release this APK'; fi
devnet_named=no
if grep -aFq 'devnet' "$work/bundle"; then devnet_named=yes; fi
# Known limit: the release RPC is an EAS sensitive variable inlined at build
# time. It remains extractable from the APK. Never print it or matching lines.
# An optional EXPO_PUBLIC_VETO_RPC permits exact matching for custom hosts.
# Otherwise this is a known-provider URL heuristic, not proof of connectivity
# or of the selected endpoint. Unrecognized hosts report no.
if [[ -n "${EXPO_PUBLIC_VETO_RPC:-}" ]]; then
  if grep -aFq -- "$EXPO_PUBLIC_VETO_RPC" "$work/bundle"; then rpc_present=yes; fi
elif grep -aEq 'https?://([a-zA-Z0-9-]+\.)*(solana\.com|helius-rpc\.com|helius\.xyz|quiknode\.pro|rpcpool\.com|ankr\.com)([^a-zA-Z0-9.-]|$)' "$work/bundle"; then
  rpc_present=yes
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum <"$apk" | sed 's/ .*//')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(shasum -a 256 <"$apk" | sed 's/ .*//')"
else
  fail 'sha256sum or shasum is required'
fi
size="$(wc -c <"$apk" | tr -d '[:space:]')"
main_commit="$(git -C "$root" rev-parse --verify refs/heads/main 2>"$work/errors")" || fail 'local main ref is missing'
[[ "$main_commit" =~ ^[a-f0-9]{40,64}$ ]] || fail 'invalid main commit'
{
  printf 'Metadata tool: %s\nPackage: %s\nversionCode: %s\nversionName: %s\ntargetSdk: %s\n' "$metadata_tool" "$package" "$version_code" "$version_name" "$target_sdk"
  while IFS= read -r permission; do
    [[ -n "$permission" ]] && printf 'Permission: %s\n' "$permission"
  done <"$work/permissions"
  while IFS= read -r scheme; do
    [[ -n "$scheme" ]] && printf 'Scheme: %s\n' "$scheme"
  done <"$work/schemes"
  while IFS= read -r fingerprint; do printf 'Signing certificate SHA-256: %s\n' "$fingerprint"; done <<<"$fingerprints"
  printf 'Signature verifies: %s\nFile SHA-256: %s\nSize (bytes): %s\n' "$signature" "$digest" "$size"
  printf 'Program id %s present: %s\nDevnet USDC mint %s present: %s\n' "$program" "$program_present" "$mint" "$mint_present"
  printf 'RPC present: %s\nBundle names devnet: %s\nMain commit: %s\nadb install %s\n' "$rpc_present" "$devnet_named" "$main_commit" "$name"
  printf 'Solana devnet. Devnet USDC is a test token with no value.\n'
} >"$work/notes"
cat "$work/notes"
cat "$work/notes" >"$(dirname "$apk")/release-notes.md" 2>"$work/errors" || fail 'could not write release notes'
[[ "$signature" == yes && "$program_present" == yes && "$mint_present" == yes && "$devnet_named" == yes ]] || fail 'signature, program id, mint or devnet check failed; do not release this APK'
