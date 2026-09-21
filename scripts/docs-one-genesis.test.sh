#!/usr/bin/env bash
# Ground Truth: the docs name one cluster, so every genesis_hash they print is
# the same value.
#
# docs/DECISION_RECORD.md says the recorded cluster is public devnet and that
# a record from another genesis will not confirm. A record printed in that
# same document with a different genesis_hash is a record the document's own
# verify step rejects. Two genesis hashes in the docs means one of them is a
# cluster that no longer exists for this repo.
# No network, no cloud, no vendor CLIs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

hashes=$(grep -rhoE '"genesis_hash": *"[1-9A-HJ-NP-Za-km-z]{32,44}"' "$ROOT/README.md" "$ROOT/docs" \
    | sed -E 's/.*"([1-9A-HJ-NP-Za-km-z]{32,44})"$/\1/' | sort -u)
count=$(printf '%s\n' "$hashes" | grep -c .)

if [ "$count" -eq 0 ]; then
    bad "no genesis_hash found in README.md or docs/"
elif [ "$count" -eq 1 ]; then
    ok "docs carry one genesis_hash: $hashes"
else
    bad "docs carry $count distinct genesis_hash values; one cluster has one genesis"
    grep -rnE '"genesis_hash": *"' "$ROOT/README.md" "$ROOT/docs" | sed 's/^/    /'
fi

echo "docs genesis checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
