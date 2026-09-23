#!/usr/bin/env bash
# Critic fixture for issue 191 (docs audit), round 1. Two checks that both
# phase 1 audit comments got wrong or left unverified. Exits 1 while either
# documented claim still contradicts what the tree or a local validator shows.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

# 1. watcher/README.md:217 says `anchor idl build ... --no-docs` regenerates
#    watcher/idl/veto.json and watcher/src/idl.ts. The JSON matches such a
#    build; the committed TS still carries "docs" arrays, so that command
#    cannot have produced it. Fails until idl.ts is regenerated or the README
#    names the command that produced it.
ts_docs=$(grep -c '"docs"' "$ROOT/watcher/src/idl.ts")
json_docs=$(grep -c '"docs"' "$ROOT/watcher/idl/veto.json")
if [[ "$ts_docs" -gt 0 && "$json_docs" -eq 0 ]]; then
  echo "FAIL idl.ts has ${ts_docs} docs arrays, veto.json has ${json_docs}: not the --no-docs build watcher/README.md:217 documents"
  fail=1
else
  echo "ok   idl.ts and veto.json agree on docs (${ts_docs} / ${json_docs})"
fi

# 2. indexer/README.md:20-21 says Agave 4.1.2 solana-test-validator returns []
#    from getSignaturesForAddress. A fresh validator lists a finalized transfer.
#    Skipped when the validator binary is absent.
if ! command -v solana-test-validator >/dev/null 2>&1; then
  echo "skip solana-test-validator not on PATH"
  exit $fail
fi
if ! grep -q 'Agave 4.1.2 `solana-test-validator`' "$ROOT/indexer/README.md"; then
  echo "ok   indexer/README.md no longer names Agave 4.1.2 as returning []"
  exit $fail
fi
D=$(mktemp -d "${TMPDIR:-/tmp}/veto-191.XXXXXX")
solana-test-validator --ledger "$D/ledger" --rpc-port 8999 --faucet-port 9999 --quiet >"$D/val.log" 2>&1 &
VPID=$!
for _ in $(seq 1 60); do
  curl -s -m 2 http://127.0.0.1:8999 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"' && break
  sleep 1
done
solana-keygen new --no-bip39-passphrase -s -o "$D/payer.json" >/dev/null
solana-keygen new --no-bip39-passphrase -s -o "$D/recip.json" >/dev/null
R=$(solana-keygen pubkey "$D/recip.json")
solana airdrop 2 -k "$D/payer.json" -u http://127.0.0.1:8999 >/dev/null
solana transfer --allow-unfunded-recipient -k "$D/payer.json" -u http://127.0.0.1:8999 "$R" 0.5 >/dev/null
sleep 20
n=$(curl -s http://127.0.0.1:8999 -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$R\",{\"commitment\":\"confirmed\"}]}" \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["result"]))')
kill "$VPID" 2>/dev/null; wait "$VPID" 2>/dev/null; rm -rf "$D"
ver=$(solana-test-validator --version | awk '{print $2}')
if [[ "$n" -gt 0 ]]; then
  echo "FAIL solana-test-validator ${ver} listed ${n} signature(s) for a finalized transfer; indexer/README.md:20-21 says []"
  fail=1
else
  echo "ok   solana-test-validator ${ver} returned [] as indexer/README.md:20-21 says"
fi
exit $fail
