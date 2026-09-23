#!/usr/bin/env bash
# Ground Truth: the commands the README and docs/DEVNET.md print run on a
# fresh clone, and the Makefile targets `make help` advertises do too.
#
# Issue 158 path 3 (a judge with a fresh clone of main) found five places
# where a printed command dies before it reaches the chain. Each check below
# is one of them, in the file and line the issue names. They are red on
# 68d372f on purpose; a fix closes them one by one.
# No network, no cloud, no vendor CLIs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

# #174: scripts/devnet-setup.sh dies when keys/program.json is absent
# (require_backed_up_program_keypair), so the DEVNET.md step that says the
# script creates the keypairs above when they are missing is wrong for
# that file.
if grep -qE 'Creates `keys/` and the keypairs above when they are missing' "$ROOT/docs/DEVNET.md"; then
    bad "#174 docs/DEVNET.md step 2 says the script creates every keypair; it dies on a missing keys/program.json"
else
    ok "#174 docs/DEVNET.md does not claim the script creates keys/program.json"
fi

# #175: the indexer-seed recipe passes neither VETO_RPC nor VETO_PROGRAM_ID,
# and the README prints `make indexer-seed` bare.
recipe=$(awk '/^indexer-seed:/{getline; print}' "$ROOT/Makefile")
if printf '%s' "$recipe" | grep -q 'VETO_RPC=' && printf '%s' "$recipe" | grep -q 'VETO_PROGRAM_ID='; then
    ok "#175 indexer-seed recipe names VETO_RPC and VETO_PROGRAM_ID"
else
    bad "#175 indexer-seed recipe is '$recipe'; it names neither VETO_RPC nor VETO_PROGRAM_ID"
fi

# #176: every export, verify and produce command printed in the README and
# in docs/DECISION_RECORD.md sets VETO_RPC on the line or passes --rpc.
bare=$(grep -nE '^\s*npx tsx (produce|export|verify)\.ts' "$ROOT/README.md" "$ROOT/docs/DECISION_RECORD.md" \
    | grep -vE 'VETO_RPC=|--rpc' || true)
if [ -z "$bare" ]; then
    ok "#176 every printed npx tsx command sets VETO_RPC or passes --rpc"
else
    bad "#176 printed npx tsx commands with no VETO_RPC and no --rpc:"
    printf '%s\n' "$bare" | sed 's/^/    /'
fi

# #177: the DEVNET.md verify command must not require a gitignored keypair
# for a read-only lookup.
if grep -E '^solana program show ' "$ROOT/docs/DEVNET.md" | grep -q -- '-k keys/deployer.json'; then
    bad "#177 docs/DEVNET.md solana program show carries -k keys/deployer.json, which a fresh clone does not have"
else
    ok "#177 docs/DEVNET.md solana program show runs without a key file"
fi

# #182: terminal typechecks against ../../watcher/src, so the terminal-test
# recipe has to install watcher deps the way ci.yml does.
trecipe=$(awk '/^terminal-test:/{getline; print}' "$ROOT/Makefile")
if printf '%s' "$trecipe" | grep -qE 'watcher.*npm (ci|install)'; then
    ok "#182 terminal-test recipe installs watcher deps"
else
    bad "#182 terminal-test recipe is '$trecipe'; it never installs watcher deps, so tsc fails on ../watcher/src"
fi

echo "journey 158 path 3 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
