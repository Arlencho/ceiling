#!/usr/bin/env bash
# Recreate the Veto Solana devnet deploy and demo fixtures from nothing.
# Re-running with the same keys/ directory keeps the same public addresses.
# Refuses to run against mainnet. Keypairs stay under gitignored keys/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# A deploy uses the Anchor default arch. The v0 build is for LiteSVM only and a
# validator refuses to execute it. See the Makefile header.
unset ANCHOR_BUILD_SBF_ARCH

export PATH="${HOME}/.cargo/bin:${HOME}/.avm/bin:${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

# Endpoint must be set. The script does not choose an RPC for the operator.
# Public devnet: VETO_RPC=https://api.devnet.solana.com ./scripts/devnet-setup.sh
# Localnet:      VETO_RPC=http://127.0.0.1:8899 VETO_CLUSTER=localnet ./scripts/devnet-setup.sh
RPC=""
CLUSTER_NAME="${VETO_CLUSTER:-devnet}"
KEYS="${ROOT}/keys"
DEPLOYER_KP="${KEYS}/deployer.json"
PROGRAM_KP="${KEYS}/program.json"
MINT_KP="${KEYS}/mint.json"
OWNER_KP="${KEYS}/owner.json"
MERCHANT_KP="${KEYS}/merchant.json"
AGENT_KP="${KEYS}/agent.json"
ADDRESSES_FILE="${KEYS}/devnet-addresses.env"
ACCOUNT_DUMP="${KEYS}/program-account.txt"

# Upgradeable deploy needs a buffer plus the program data account at the same
# time. A 232KiB .so is about 1.18 SOL rent-exempt, so peak is just over 2 SOL.
MIN_DEPLOYER_LAMPORTS=3000000000
AIRDROP_MAX_TRIES=40
OWNER_FUND_TOKENS="1000000"
AGENT_SOL="0.5"
MINT_DECIMALS=6

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_rpc() {
  if [[ -z "${VETO_RPC:-}" ]]; then
    die "missing VETO_RPC"
  fi
  RPC="$VETO_RPC"
}

# The committed program id. Bundled consumers (watcher, indexer, tools, app)
# point at this value. A deploy under any other id looks like it succeeded
# and then nothing talks to the program that was just built.
declared_program_id() {
  local src="${ROOT}/programs/veto/src/lib.rs"
  [[ -f "$src" ]] || die "missing ${src}"
  local id
  id="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)");/\1/p' "$src" | head -n1)"
  [[ -n "$id" ]] || die "could not read declare_id from ${src}"
  printf '%s\n' "$id"
}

# Fail before build or deploy when keys/program.json is not the committed id.
# Naming both ids is the whole point: the operator must restore the backed-up
# program keypair rather than minting a new one and rewriting source.
assert_program_keypair_matches_declare_id() {
  local key_id="$1"
  local declared
  declared="$(declared_program_id)"
  if [[ "$key_id" != "$declared" ]]; then
    die "program keypair pubkey ${key_id} does not match declare_id ${declared}; the program keypair must be restored from backup"
  fi
}

require_backed_up_program_keypair() {
  if [[ ! -f "$PROGRAM_KP" ]]; then
    die "keys/program.json is missing; the program keypair must be restored from backup (declare_id $(declared_program_id))"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

is_mainnet_url() {
  printf '%s' "$1" | grep -Eqi 'mainnet'
}

assert_devnet() {
  local url="$1"
  if is_mainnet_url "$url"; then
    die "refusing to run against mainnet (url=${url})"
  fi
  # Devnet or a local validator. Anything else is refused on purpose: this
  # script mints, funds and deploys, and none of that belongs on a network
  # nobody intended to touch.
  printf '%s' "$url" | grep -Eqi 'devnet|127\.0\.0\.1|localhost' \
    || die "refusing to run against a url that is neither devnet nor local: ${url}"
}

ensure_keypair() {
  local path="$1"
  if [[ -f "$path" ]]; then
    log "reusing $(basename "$path") $(solana-keygen pubkey "$path")"
    chmod 600 "$path" 2>/dev/null || true
    return
  fi
  solana-keygen new --no-bip39-passphrase --silent -o "$path"
  chmod 600 "$path"
  log "created $(basename "$path") $(solana-keygen pubkey "$path")"
}

lamports_of() {
  local pk="$1"
  local out
  out="$(solana balance "$pk" -u "$RPC" --lamports 2>/dev/null || true)"
  if [[ -z "$out" ]]; then
    printf '0'
    return
  fi
  awk '{print $1}' <<<"$out"
}

airdrop_once() {
  local pk="$1"
  local amount="$2"
  solana airdrop "$amount" "$pk" -u "$RPC" --commitment confirmed
}

airdrop_until() {
  local pk="$1"
  local min_lamports="$2"
  local tries=0
  local amount
  local wait_s
  local bal
  bal="$(lamports_of "$pk")"
  if [[ "$bal" -ge "$min_lamports" ]]; then
    log "balance for ${pk} already ${bal} lamports"
    return
  fi
  while [[ "$(lamports_of "$pk")" -lt "$min_lamports" ]]; do
    tries=$((tries + 1))
    if [[ "$tries" -gt "$AIRDROP_MAX_TRIES" ]]; then
      die "devnet airdrop failed after ${AIRDROP_MAX_TRIES} tries for ${pk} (have $(lamports_of "$pk") lamports, need ${min_lamports})"
    fi
    if [[ "$tries" -le 4 ]]; then
      amount="2"
    elif [[ "$tries" -le 10 ]]; then
      amount="1"
    else
      amount="0.5"
    fi
    wait_s=120
    log "airdrop ${amount} SOL to ${pk} (try ${tries}/${AIRDROP_MAX_TRIES})"
    if airdrop_once "$pk" "$amount"; then
      sleep 2
      continue
    fi
    log "airdrop rate limited or failed, waiting ${wait_s}s then retrying"
    sleep "$wait_s"
  done
  log "funded ${pk} to $(lamports_of "$pk") lamports"
}

account_exists() {
  local pk="$1"
  solana account "$pk" -u "$RPC" >/dev/null 2>&1
}

json_field() {
  python3 -c 'import json,sys
d=json.load(sys.stdin)
o=d.get("commandOutput", d) if isinstance(d, dict) else {}
if not isinstance(o, dict):
    o=d if isinstance(d, dict) else {}
keys=sys.argv[1:]
cur=o
for k in keys:
    if isinstance(cur, dict) and k in cur:
        cur=cur[k]
    else:
        cur=d.get(k) if isinstance(d, dict) else None
        break
if cur is None:
    sys.exit(1)
print(cur)
' "$@"
}

ata_of() {
  local mint="$1"
  local owner="$2"
  spl-token address --token "$mint" --owner "$owner" --verbose --output json -u "$RPC" \
    | json_field associatedTokenAddress
}

upsert_devnet_program_id() {
  local pid="$1"
  python3 - "$pid" <<'PY'
import sys
from pathlib import Path
pid = sys.argv[1]
path = Path("Anchor.toml")
text = path.read_text()
lines = text.splitlines(True)
out = []
in_devnet = False
wrote = False
has_section = False
for line in lines:
    if line.startswith("[programs.devnet]"):
        in_devnet = True
        has_section = True
        out.append(line)
        continue
    if in_devnet and line.startswith("["):
        if not wrote:
            out.append(f'veto = "{pid}"\n')
            wrote = True
        in_devnet = False
    if in_devnet and line.startswith("veto"):
        out.append(f'veto = "{pid}"\n')
        wrote = True
        continue
    out.append(line)
if in_devnet and not wrote:
    out.append(f'veto = "{pid}"\n')
if not has_section:
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    out.append(f'\n[programs.devnet]\nveto = "{pid}"\n')
path.write_text("".join(out))
PY
}

write_docs() {
  local program_id="$1"
  local mint="$2"
  local owner="$3"
  local owner_ata="$4"
  local merchant="$5"
  local merchant_ata="$6"
  local agent="$7"
  local deployer="$8"
  local when
  when="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$when" "$RPC" "$program_id" "$mint" "$owner" "$owner_ata" "$merchant" "$merchant_ata" "$agent" "$deployer" "$ACCOUNT_DUMP" "$OWNER_FUND_TOKENS" "$MINT_DECIMALS" "$AGENT_SOL" "$CLUSTER_NAME" <<'PY'
import sys
from pathlib import Path
when, rpc, program_id, mint, owner, owner_ata, merchant, merchant_ata, agent, deployer, dump_path, fund, decimals, agent_sol, cluster = sys.argv[1:]
dump = Path(dump_path).read_text().rstrip() if Path(dump_path).exists() else "(program account dump missing)"
md = f"""# Veto on Solana {cluster}

Recorded by `scripts/devnet-setup.sh` at {when} UTC.

This file lists **public addresses only**. Keypairs live under gitignored `keys/` and must never be committed.

## Cluster

- Name: `{cluster}`
- RPC: `{rpc}`
- Explorer cluster query: `cluster={cluster}`

## Public addresses

| Role | Address |
|---|---|
| Program | `{program_id}` |
| Test SPL mint ({decimals} decimals) | `{mint}` |
| Owner | `{owner}` |
| Owner token account | `{owner_ata}` |
| Merchant | `{merchant}` |
| Merchant token account | `{merchant_ata}` |
| Agent | `{agent}` |
| Deployer (fee payer, upgrade authority, mint authority) | `{deployer}` |

Explorer:

- Program: https://explorer.solana.com/address/{program_id}?cluster={cluster}
- Mint: https://explorer.solana.com/address/{mint}?cluster={cluster}
- Owner token account: https://explorer.solana.com/address/{owner_ata}?cluster={cluster}
- Merchant token account: https://explorer.solana.com/address/{merchant_ata}?cluster={cluster}
- Agent: https://explorer.solana.com/address/{agent}?cluster={cluster}

## Fixtures

- Test SPL mint at {decimals} decimals on the classic Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
- Owner token account funded with {fund} tokens (a round number, not a dust amount).
- Merchant token account created and holding zero tokens.
- Agent funded with {agent_sol} SOL for fees and holding **zero tokens**. The setup does not create an agent token account.

## Keypairs (secrets, not in git)

All files under `keys/` are gitignored. Re-running the script reuses them when present.

| File | Whose key |
|---|---|
| `keys/deployer.json` | Deployer, upgrade authority, mint authority, fee payer |
| `keys/program.json` | Program address |
| `keys/mint.json` | Mint address |
| `keys/owner.json` | Owner |
| `keys/merchant.json` | Merchant |
| `keys/agent.json` | Agent (SOL only) |
| `keys/devnet-addresses.env` | Public addresses echoed for local use |

Confirm they are ignored before every commit:

```bash
git check-ignore -v keys/deployer.json keys/program.json keys/agent.json
git status --ignored -- keys
```

## Recreate from nothing

Reading the program on this cluster does not use this section. The verify commands below call `{rpc}` and do not need a keypair.

`make setup` and `make localnet` deploy. Both run this script. They need the maintainer backup of `keys/program.json`, the keypair for `declare_id` `{program_id}`. That file is not in git (`keys/` is gitignored). If it is missing, the script stops with `keys/program.json is missing; the program keypair must be restored from backup` and does not mint a replacement. A fresh clone cannot run either target until that backup is restored. `npx tsx produce.ts` is also not a read: it needs `keys/owner.json` from the same backup.

Toolchain used when this file was written: anchor-cli 1.2.0, solana-cli 4.1.2.

```bash
VETO_RPC={rpc} ./scripts/devnet-setup.sh
```

The script does not choose an RPC. It refuses and names `VETO_RPC` if that variable is unset.

The script:

1. Points the Solana CLI at `{rpc}` and refuses to continue if the URL looks like mainnet.
2. Requires `keys/program.json` from the maintainer backup. A missing file is an error. It creates `keys/` and the other keypairs in the table when they are missing.
3. Airdrops SOL to the deployer, retrying on rate limits.
4. Builds the program. It copies `keys/program.json` to `target/deploy/veto-keypair.json`, runs `anchor keys sync` so the bytecode ID check matches the deploy address, then restores `programs/veto/src` so program source is not left dirty and is not committed.
5. Runs `anchor deploy --provider.cluster {cluster}`.
6. Creates the mint, owner token account, merchant token account, funds the owner, and funds the agent with SOL only.
7. Fetches the program account and rewrites this file.

Re-running with the same `keys/` directory keeps these addresses and upgrades the existing program.

## Exact commands

Cluster and wallet:

```bash
solana config set --url {rpc} --keypair keys/deployer.json --commitment confirmed
solana config get
```

Build and deploy (the wrapper script is the supported path; these are the commands it runs):

```bash
mkdir -p target/deploy
cp keys/program.json target/deploy/veto-keypair.json
anchor keys sync --program-name veto
anchor build --no-idl
git checkout -- programs/veto/src
anchor deploy --no-idl --provider.cluster {cluster} --provider.wallet keys/deployer.json --program-name veto --program-keypair keys/program.json
```

Demo fixtures:

```bash
spl-token create-token --decimals {decimals} --mint-authority {deployer} --fee-payer keys/deployer.json -u {rpc} -- keys/mint.json
spl-token create-account {mint} --owner {owner} --fee-payer keys/deployer.json -u {rpc}
spl-token create-account {mint} --owner {merchant} --fee-payer keys/deployer.json -u {rpc}
spl-token mint {mint} {fund} --mint-authority keys/deployer.json --fee-payer keys/deployer.json -u {rpc} -- {owner_ata}
solana transfer --from keys/deployer.json --fee-payer keys/deployer.json --allow-unfunded-recipient -u {rpc} {agent} {agent_sol}
```

Verify:

```bash
solana account {program_id} -u {rpc}
solana program show {program_id} -u {rpc} -k keys/deployer.json
spl-token balance --address {owner_ata} -u {rpc}
spl-token balance --address {merchant_ata} -u {rpc}
spl-token accounts --owner {agent} -u {rpc}
solana balance {agent} -u {rpc}
```

## Program account (verification)

```
solana account {program_id} -u {rpc}
```

```
{dump}
```

## Notes

- This script never deploys to mainnet and never prints private keys.
- `declare_id!` in `programs/veto/src/lib.rs` is left as committed. The live program address is the Program row above. A later program-side change can sync `declare_id!` in its own PR.
- The agent must keep holding zero tokens. Do not mint to it and do not create an agent token account.
"""
Path("docs/DEVNET.md").write_text(md)
print("wrote docs/DEVNET.md")
PY
}

restore_after_build() {
  git checkout -- programs/veto/src Anchor.toml
}

main() {
  require_rpc
  need_cmd solana
  need_cmd solana-keygen
  need_cmd spl-token
  need_cmd anchor
  need_cmd cargo
  need_cmd python3
  need_cmd git

  if is_mainnet_url "${SOLANA_CLUSTER:-}" || is_mainnet_url "${CLUSTER:-}"; then
    die "SOLANA_CLUSTER/CLUSTER points at mainnet; refusing to run"
  fi

  mkdir -p "$KEYS" docs
  chmod 700 "$KEYS"
  local old_umask
  old_umask="$(umask)"
  umask 077

  ensure_keypair "$DEPLOYER_KP"
  require_backed_up_program_keypair
  ensure_keypair "$PROGRAM_KP"
  ensure_keypair "$MINT_KP"
  ensure_keypair "$OWNER_KP"
  ensure_keypair "$MERCHANT_KP"
  ensure_keypair "$AGENT_KP"
  umask "$old_umask"

  local deployer program_id mint owner merchant agent
  deployer="$(solana-keygen pubkey "$DEPLOYER_KP")"
  program_id="$(solana-keygen pubkey "$PROGRAM_KP")"
  mint="$(solana-keygen pubkey "$MINT_KP")"
  owner="$(solana-keygen pubkey "$OWNER_KP")"
  merchant="$(solana-keygen pubkey "$MERCHANT_KP")"
  agent="$(solana-keygen pubkey "$AGENT_KP")"

  assert_program_keypair_matches_declare_id "$program_id"
  log "program keypair matches declare_id ${program_id}"

  solana config set --url "$RPC" --keypair "$DEPLOYER_KP" --commitment confirmed >/dev/null
  local cfg_url
  # `solana config get` prints ANSI; read the yaml instead.
  cfg_url="$(awk '/^json_rpc_url:/{print $2}' "${HOME}/.config/solana/cli/config.yml" | tr -d '[:space:]')"
  assert_devnet "$cfg_url"
  assert_devnet "$RPC"
  log "solana config RPC=${cfg_url} keypair=${DEPLOYER_KP}"

  airdrop_until "$deployer" "$MIN_DEPLOYER_LAMPORTS"

  mkdir -p target/deploy
  cp "$PROGRAM_KP" target/deploy/veto-keypair.json

  if ! git diff --quiet -- programs/veto/src; then
    die "programs/veto/src has local edits; refusing to run anchor keys sync"
  fi

  # keys sync is belt-and-braces for the build now that the keypair has
  # already been checked against declare_id. Restore source afterwards.
  # Program source is not part of the commit from this script.
  trap restore_after_build EXIT
  log "anchor keys sync for program id ${program_id}"
  anchor keys sync --program-name veto
  log "anchor build --no-idl"
  # IDL generation compiles workspace tests; those live outside this task
  # and currently fail to compile. The .so is what we deploy.
  # Delete the artifact first. The test path builds this same file at SBPF v0
  # for LiteSVM, and anchor would otherwise treat it as up to date, relink
  # nothing, and deploy a binary the validator refuses to execute.
  rm -f "${ROOT}/target/deploy/veto.so"
  anchor build --no-idl
  restore_after_build
  trap - EXIT
  if ! git diff --quiet -- programs/veto/src; then
    die "programs/veto/src was left dirty after restore"
  fi

  log "anchor deploy --provider.cluster ${CLUSTER_NAME} --no-idl"
  if ! anchor deploy \
      --no-idl \
      --provider.cluster "$RPC" \
      --provider.wallet "$DEPLOYER_KP" \
      --program-name veto \
      --program-keypair "$PROGRAM_KP"; then
    log "deploy failed, retrying with a compute unit price"
    anchor deploy \
      --no-idl \
      --provider.cluster "$RPC" \
      --provider.wallet "$DEPLOYER_KP" \
      --program-name veto \
      --program-keypair "$PROGRAM_KP" \
      -- --with-compute-unit-price 5000
  fi

  upsert_devnet_program_id "$program_id"

  if account_exists "$mint"; then
    log "mint already on chain ${mint}"
  else
    log "creating mint ${mint} decimals=${MINT_DECIMALS}"
    spl-token create-token --decimals "$MINT_DECIMALS" \
      --mint-authority "$deployer" \
      --fee-payer "$DEPLOYER_KP" \
      -u "$RPC" \
      -- "$MINT_KP"
  fi

  local owner_ata merchant_ata
  owner_ata="$(ata_of "$mint" "$owner")"
  merchant_ata="$(ata_of "$mint" "$merchant")"

  if account_exists "$owner_ata"; then
    log "owner token account exists ${owner_ata}"
  else
    log "creating owner token account"
    spl-token create-account "$mint" --owner "$owner" --fee-payer "$DEPLOYER_KP" -u "$RPC"
  fi

  if account_exists "$merchant_ata"; then
    log "merchant token account exists ${merchant_ata}"
  else
    log "creating merchant token account"
    spl-token create-account "$mint" --owner "$merchant" --fee-payer "$DEPLOYER_KP" -u "$RPC"
  fi

  local owner_bal
  owner_bal="$(spl-token balance --address "$owner_ata" -u "$RPC" --output json 2>/dev/null \
    | json_field uiAmount || printf '0')"
  local need_mint=1
  if python3 - "$owner_bal" "$OWNER_FUND_TOKENS" <<'PY'
import sys
have = float(sys.argv[1] or 0)
want = float(sys.argv[2])
sys.exit(0 if have >= want else 1)
PY
  then
    need_mint=0
  fi
  if [[ "$need_mint" -eq 1 ]]; then
    log "minting ${OWNER_FUND_TOKENS} tokens to owner"
    spl-token mint "$mint" "$OWNER_FUND_TOKENS" \
      --mint-authority "$DEPLOYER_KP" \
      --fee-payer "$DEPLOYER_KP" \
      -u "$RPC" \
      -- "$owner_ata"
  else
    log "owner already funded (${owner_bal} tokens)"
  fi

  local agent_lamports
  agent_lamports="$(lamports_of "$agent")"
  if [[ "$agent_lamports" -lt 400000000 ]]; then
    log "funding agent with ${AGENT_SOL} SOL for fees"
    solana transfer --from "$DEPLOYER_KP" --fee-payer "$DEPLOYER_KP" \
      --allow-unfunded-recipient -u "$RPC" "$agent" "$AGENT_SOL"
  else
    log "agent already has ${agent_lamports} lamports"
  fi

  log "checking agent holds zero tokens"
  local agent_token_total
  agent_token_total="$(spl-token accounts --owner "$agent" -u "$RPC" --output json 2>/dev/null \
    | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(0)
    sys.exit(0)
o=d.get("commandOutput", d) if isinstance(d, dict) else {}
accts=[]
if isinstance(o, dict):
    accts=o.get("accounts") or o.get("tokens") or []
if not isinstance(accts, list):
    print(0)
    sys.exit(0)
total=0.0
for a in accts:
    if not isinstance(a, dict):
        continue
    amt=a.get("tokenAmount") or a.get("amount") or {}
    if isinstance(amt, dict):
        total += float(amt.get("uiAmount") or amt.get("uiAmountString") or 0)
    else:
        try:
            total += float(amt or 0)
        except Exception:
            pass
print(total)
if total > 0:
    sys.exit(2)
' || printf '0')"
  log "agent token total=${agent_token_total}"

  solana account "$program_id" -u "$RPC" | tee "$ACCOUNT_DUMP"
  grep -qi 'Executable: *true' "$ACCOUNT_DUMP" || die "deployed program account is not executable"

  cat > "$ADDRESSES_FILE" <<EOF
CLUSTER=${CLUSTER_NAME}
RPC=${RPC}
PROGRAM_ID=${program_id}
MINT=${mint}
OWNER=${owner}
OWNER_TOKEN_ACCOUNT=${owner_ata}
MERCHANT=${merchant}
MERCHANT_TOKEN_ACCOUNT=${merchant_ata}
AGENT=${agent}
DEPLOYER=${deployer}
EOF
  chmod 600 "$ADDRESSES_FILE"

  write_docs "$program_id" "$mint" "$owner" "$owner_ata" "$merchant" "$merchant_ata" "$agent" "$deployer"

  log "git ignore check:"
  git check-ignore -v "$DEPLOYER_KP" "$PROGRAM_KP" "$MINT_KP" "$OWNER_KP" "$MERCHANT_KP" "$AGENT_KP" "$ADDRESSES_FILE" || true

  log "DEVNET SETUP COMPLETE"
  log "program ${program_id}"
  log "mint ${mint}"
  log "owner token account ${owner_ata}"
  log "merchant token account ${merchant_ata}"
  log "agent ${agent}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
