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

These bullets are written by `write_docs` in `scripts/devnet-setup.sh`. Re-running the script rewrites this file from that template.

- Test SPL mint at {decimals} decimals on the classic Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
- The test SPL mint is a devnet test token named Veto test token, symbol VTEST, with no value.
- Setup minted {fund} tokens to the owner token account on 2026-09-20T20:57:14Z. Mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` paid 0.666 of that supply to the merchant across three charges on 2026-09-20 (0.446, 0.2145, 0.0055). Later rules opened in the app, and `make e2e-devnet`, pay the same merchant from other token accounts, so the live merchant balance is that 0.666 plus every later payment. Read both balances with the verify commands below. A printed figure goes stale when a charge pays.
- The owner token account is still the source for mandates id 1 and id 3. A rule opened in the app uses a different account, seed `veto-rule-<mandate id>`, derived from that rule's owner. There is not one owner token account for every rule.
- The agent was funded with {agent_sol} SOL. The live balance is that amount minus fees. The setup does not create an agent token account. On 2026-09-24 `getTokenAccountsByOwner` for the agent returned no accounts.

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

Reading the program on {cluster} does not use this section. The verify commands below, and export / verify in the README, call `{rpc}` and do not need a keypair.

`make setup` and `make localnet` deploy. Both run this script. They need the maintainer backup of `keys/program.json`, the keypair for `declare_id` `{program_id}`. That file is not in git (`keys/` is gitignored). If it is missing, the script stops with `keys/program.json is missing; the program keypair must be restored from backup` and does not mint a replacement. A fresh clone cannot run either target until that backup is restored. `npx tsx produce.ts` is also not a read: it needs `keys/owner.json` from the same backup.

Toolchain named when this file was first written: anchor-cli 1.2.0, solana-cli 4.1.2. Anchor 1.2.0 is the version CI installs. The repo does not pin the Solana CLI. CI installs the stable release.

```bash
VETO_RPC={rpc} ./scripts/devnet-setup.sh
```

The script does not choose an RPC. It refuses and names `VETO_RPC` if that variable is unset.

The script:

1. Points the Solana CLI at `{rpc}` and refuses to continue if the URL looks like mainnet.
2. Requires `keys/program.json` from the maintainer backup. A missing file is an error. It creates `keys/` and the other keypairs in the table when they are missing.
3. Airdrops SOL to the deployer, retrying on rate limits.
4. Builds the program. It stops if `programs/veto/src` has local edits. It copies `keys/program.json` to `target/deploy/veto-keypair.json`, deletes `target/deploy/veto.so`, runs `anchor keys sync`, then `anchor build --no-idl`, then restores `programs/veto/src` and `Anchor.toml`.
5. Runs `anchor deploy --no-idl --provider.cluster` with the `VETO_RPC` URL (not the cluster name). A failed deploy retries with `-- --with-compute-unit-price 5000`.
6. Creates the mint, owner token account, and merchant token account when they are absent. It mints {fund} tokens only when the owner balance is below that. It transfers {agent_sol} SOL to the agent only when the agent holds fewer than 400000000 lamports.
7. Fetches the program account and rewrites this file.

Re-running with the same `keys/` directory keeps these addresses and upgrades the existing program.

## Exact commands

Cluster and wallet:

```bash
solana config set --url {rpc} --keypair keys/deployer.json --commitment confirmed
solana config get
```

Build and deploy (the wrapper script is the supported path; these are the core commands it runs, after it has refused to continue when `programs/veto/src` is dirty):

```bash
mkdir -p target/deploy
cp keys/program.json target/deploy/veto-keypair.json
rm -f target/deploy/veto.so
anchor keys sync --program-name veto
anchor build --no-idl
git checkout -- programs/veto/src Anchor.toml
anchor deploy --no-idl --provider.cluster {rpc} --provider.wallet keys/deployer.json --program-name veto --program-keypair keys/program.json
```

If that deploy exits non-zero, the script retries the same command with `-- --with-compute-unit-price 5000`.

Demo fixtures (each command runs only when the account is missing, the owner balance is under {fund} tokens, or the agent holds fewer than 400000000 lamports):

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
solana program show {program_id} -u {rpc}
spl-token balance --address {owner_ata} -u {rpc}
spl-token balance --address {merchant_ata} -u {rpc}
spl-token accounts --owner {agent} -u {rpc}
solana balance {agent} -u {rpc}
```

`solana program show` answers this read without a signer. Passing `-k keys/deployer.json` fails on a fresh clone, because that file is gitignored, and the CLI then tells you to generate a new key. The upgrade authority it prints is the Deployer row above.

## Program account (verification)

```
solana account {program_id} -u {rpc}
```

```
{dump}
```

## Upgrades

### Trade upgrade, 2026-09-25

On 2026-09-25T22:58:50Z the program `{program_id}` was upgraded on devnet in slot 504196958. This completes the 2026-09-25T22:21:37Z attempt, which had stopped before deployment because `VETO_RPC` was unset in the run environment.

- Upgrade signature: `3VWb3pABFZYSeYdNnQaG6bbKvLUFpyJgFcicNV81RAdas6s2TcWgp6SBWbev6vWR41kU1MzLM2puFRkrwmaWLqJ6`
- Transaction: https://explorer.solana.com/tx/3VWb3pABFZYSeYdNnQaG6bbKvLUFpyJgFcicNV81RAdas6s2TcWgp6SBWbev6vWR41kU1MzLM2puFRkrwmaWLqJ6?cluster={cluster}
- Program data account: `7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM`. The upgrade first extended it by 152568 bytes because the new binary is larger than the 440152 bytes the account held, then wrote the program into it. The account itself is 592765 bytes, which includes the loader header.
- Program data account: https://explorer.solana.com/address/7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM?cluster={cluster}
- Program data: 592720 bytes, SHA-256 `7b96751bf3cad17225a46f21c951bd04c9b4f30be0f00ec092a8999cab8255e9`. `solana program dump` of the upgraded program is byte-identical to the build below.
- The binary is a deploy-arch build of main at `b7aac4a3806b67b872e35407acede5e1d1246199` (`b7aac4a`), from a clean checkout with `rm -f target/deploy/veto.so` then `anchor build --ignore-keys` and no v0 flag. Main CI on that commit: [successful run 36198015670](https://github.com/Arlencho/veto/actions/runs/36198015670). Main advanced to `992a0fbd104e248117b4f5b828f0c8213a7830c3` during the run without touching `programs/`, so the binary still matches the program source on main; main CI stayed green ([run 36200818637](https://github.com/Arlencho/veto/actions/runs/36200818637)).
- `make test` from the same commit: 127 passed, 0 failed. Counts: unit 2, Hold 19, Hold red-team 18, payment red-team 20, refusal recording 6, SKR mint 2, token-swap fixture 3, trade 27, trade red-team 30; doc-tests 0.
- The trade rule (`open_trade_rule`, `trade`, `grant_trade_override`, `revoke_trade_rule`, `close_trade_rule`) is in this binary; its red-team suite is `programs/veto/tests/trade_red_team.rs`.
- `make e2e-devnet` passed on the upgraded program: `devnet journey opens two rules, pays, refuses, overrides, revokes, closes, and verifies every decision`; tests 1, pass 1, fail 0.
- `make hold-e2e-devnet` passed on the upgraded program: `a Hold vault pays a known everyday withdrawal at once, holds a big one, and lets the guardian stop, freeze, and recover`; tests 1, pass 1, fail 0. Vault `9HAAoskDkZj1RE1QHm7i9RZEaMNpeo7uphCA6wi2NrdQ`: everyday withdrawal paid at once, big withdrawal held and refused before unlock, guardian stop, freeze, recover while frozen, unfreeze with both keys, loosening waits, tightening applies at once.
- `anchor idl build` from the same commit matches the deployed program's interface, and `diff` against each committed consumer copy is empty: `watcher/idl/veto.json`, `tools/idl/veto.json`, `sdk/idl/veto.json`.

### Hold upgrade, 2026-09-25

On 2026-09-25T12:18:23Z the program `{program_id}` was upgraded on devnet in slot 503984132.

- Upgrade signature: `5papvME2orZuY6PxEmmwymmkHzwyquCnHgpygCbCdV2qUKJSg5D1HpVGpz5pY2FrpeuEZ5ZKDLsyNLifyC9k4RT`
- Transaction: https://explorer.solana.com/tx/5papvME2orZuY6PxEmmwymmkHzwyquCnHgpygCbCdV2qUKJSg5D1HpVGpz5pY2FrpeuEZ5ZKDLsyNLifyC9k4RT?cluster={cluster}
- Program data: 440152 bytes, the binary inside account `7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM` (the account itself is 440197 bytes, which includes the loader header).
- Program data account: https://explorer.solana.com/address/7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM?cluster={cluster}
- The on-chain binary is byte-identical to a build of main at `7c580cb78b04f89b8d4f85f91bdb41988b75de9d` (`7c580cb`).
- The Hold vault in that binary includes the red-team fixes from [PR 270](https://github.com/Arlencho/veto/pull/270).
- `make hold-e2e-devnet` then passed on devnet. Vault `2Tk8Qfd23udSkHZAQvx8x1TXU166n26HtjzCjaSeoqaU`: everyday withdrawal paid at once, big withdrawal held and refused before unlock, guardian stop, freeze, recover while frozen, unfreeze with both keys, loosening waits, tightening applies at once.
- Vault: https://explorer.solana.com/address/2Tk8Qfd23udSkHZAQvx8x1TXU166n26HtjzCjaSeoqaU?cluster={cluster}

The app screens for Hold exist. A device check with a real vault follows.

## USDC

Circle devnet USDC uses the classic Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and 6 decimals.

| Role | Address |
|---|---|
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Merchant USDC token account | `GDb2L2oQc6LP4nii8ahUX3pqDUNVUn36nPNVafhhtZ7i` |
| Deployer USDC token account | `8fhPw3vpLmxcVFfsUpqC7g2wHMYc7egw9fJi6ydcHAjz` |

Devnet USDC is Circle's test token. It has no value.

The founder gets it from https://faucet.circle.com by pasting the Seeker owner `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` and the deployer `GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1`. Nobody can mint this token. `scripts/devnet-usdc.sh` creates the merchant and deployer accounts when they are absent, and re-running it is a no-op.

## Demo pool

Constant-product pool on the token-swap program `SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8`. The pair is wrapped SOL (`So11111111111111111111111111111111111111112`, 9 decimals) and Circle devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals).

| Role | Address |
|---|---|
| Pool | `DTFPL7GmcFN9yc6Yv2FZrq158gRhM8JG1v6svgcNNjxL` |
| Authority | `8bMBGNZf9L1h2cFQMVPmqkZzUMbdfB549q27UioGTknS` |
| wSOL vault | `HUUHvdSrsADyuXbkL5Q9Lu72Ybek4oNpFyBajaKmLfnp` |
| USDC vault | `HejE81VKyAmThbTBBR6mxaPmkmk2qFJnZy2SC7whd4nL` |
| Pool mint | `6j9w4Gh2XNNoFsqtCcxGJkPENUvCrc8P7hQCMdwvgMdV` |
| Fee account | `9ZxbMsqrUQLiWrTAvSFToZZK3Yfs7UMAP7WP1QfeCe2i` |
| Fee owner | `HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN` |

the exchange takes 0.30 percent of each trade's input, of which 0.05 percent goes as pool tokens to a fee account owned by a key compiled into the exchange, not held by us

Seeded with 10 USDC and 0.083 SOL. 0.083 SOL is what 10 USD bought at 120.58 USD per SOL on 2026-09-25, from https://api.coinbase.com/v2/prices/SOL-USD/spot.

our pool, devnet, the rate is whatever our own trades make it

`DLKNn8KPGf9EYWTpVtVxQ4tfott91pTFJYDFkKCnNRoa` and `6TddoWn8yPVjedBesZqESBB8zEw7UHb7jUbbVkjowUD7` are unused mints left by the gate run, not pools.

## Trade rule on devnet

Opened 2026-09-25 on the upgraded program with the owner key `keys/owner.json` (the recorded owner `{owner}`, not a fresh key) on the wSOL and USDC demo pool above: per trade 0.002 SOL, per day 0.01 SOL, cap 0.05 SOL, floor 90 percent of the spot at open, 30 days. The trade rule's own account holds the wrapped cap; the pool accounts come from the `TOKEN_SWAP_*` values in `keys/devnet-addresses.env`, matching the Demo pool table.

Just before the open the deployer deposited matching liquidity into the pool at the unchanged rate (signature `5jv4CftALiPxcRv8b5Qf8B35YncsYN1xQ2xNGkBkfuTCdNQfe7ysoRvsFGUSBvSoMB9pgxMkiNdArcnQuCRED2Lm`), doubling the vaults from 83999994 lamports and 9881306 USDC base units to 167999988 and 19762612, so the journey's full daily volume clears the 90 percent floor.

- Rule: `91D7FjbUXcsZ6a1rAnS2u4XHd7rFhc1Y7zxiApV7w3jY`; ledger `HLTTzfMHiKtE8onBg3F9fsdCXo7P9gByih2n8hPo9H6b`; source `ArFd2g8VF4jz1q9ZSRXr4thncJt74KNfXGxgKy4qAGa7`; destination `HcyMqQuodBgL9RzMMbEwAM6zYZhoFrSnoPuVbqVh6wgg`; agent `{agent}`; floor 14821959/139999990; expires_at 1792970226.
- Rule: https://explorer.solana.com/address/91D7FjbUXcsZ6a1rAnS2u4XHd7rFhc1Y7zxiApV7w3jY?cluster={cluster}
- Open signature: `BH5ktZxaxdm1NkgJQrfYmhEmbkw5tfcV22QdUxJmjNJUiphRhGXmuVpArxT8X25rYGoC44Vp8145iZRdjaMKVgF`

`make trade-demo-devnet` with `TRADE_DEMO_AMOUNT=1000000` (0.001 SOL), the agent key `keys/agent.json`, and a fresh funded second-trader key (`DPBKyrBHxtfvcrtAQpM23vgeD4FN8h1iJLZaT8jiEco`, created for this run and funded with 0.25 SOL by the deployer, signature `58D9Yr64wLKxzitGtXokxCubVataYpuuhLxiiuR3dvM5sLwUjZDL8ybLWR1H88MgfoTzBjNj2AQeurFjhg6NsZ3E`) passed. The hostile-agent demo builds a decoy pool that needs one USDC base unit in the agent's associated account, so the deployer also sent 0.001 USDC there (signature `2NTw7RkdBs7MAzBVk62oYxSbn8yUc4rtqHucJK4kLxKP5CKFfkhzjBprWX5zo13oko1XGUC22mi7vouYcD6d9T6P`). That transfer, not the setup script, is the one exception to the agent zero-token note below. Every row, with the reason recorded in its trade decision:

| Row | Recorded reason | Signature |
|---|---|---|
| trade-once | traded (0 ok, in 999994, out 116589) | `v2yMjbcksnMK3aAFPbivhRq46yXUA5v3nWUPT59VAeTL9j8tkDk6dGw5tJoYKkwhtt5GAbTyFkaRNv8HAuegc56` |
| a.destination | refused 11 output account not allowed | `qSTEfyGEiQv1kzAD2jwWSYksdhZaEoTFZ5UtD1Ygu6KYmgrq8NMTH8B16Lm7CJDwD7YnP8Z8B2i7K1Y6L9pfoZq` |
| b.pool | refused 12 pool not allowed | `4aUygak4EfPE5WM6zoLKXa6RGg4WeZhUcpRAtD4eC3nyQUyFxSNGaVA8h2GNYGjP2MhVYfEhDp9mFVP4zPdmwL8V` |
| c.per_trade | refused 5 over per-payment maximum, suggested override 2000001 | `xC1TJJC9uwsZvWhP9ex16fXURkT2hF4sDB6NZ1TNjvjuLZZv7Z4vAuDsyQ36zJZ6gResvXk1X6vZas6WRtrMKbv` |
| d.floor | refused 14 quote below floor | `28KjYSzCBtGaR9FuofNmWjp7NxGB3VAXV2Eh1WWDZpVoh4bE4KxqmySmaVRAgeFTAmnRjPPXvaSYcDA1Y38oio9T` |
| e.honest | traded (0 ok, in 1000000, out 114877) | `3rMKiGykqp9j8xPVdiFpMREtyZUr9CtFj2jqzTwAdoJqGxEkyGq81eFEscSAbZw9bJ75X26QPJdXaiFicUVDspKB` |
| f.fill | traded (0 ok, in 1999996, out 225766) | `2hqvE5UkkZfQo6jLPhK42ApH3FnMGX6e2Er7T2NiXGy7ZzZomB9MUSwevvpjDuCq7NFAUb3mAJHp6JivGpWN1oXQ` |
| f.fill | traded (0 ok, in 1999999, out 220599) | `5gZsDjcbrLwjCXp5AZgP5M2udb1cMEbecdRtooLMXbNAQE2S1XqVcJyFXqP1Ee7DQzgX3Yv48M41EWsfDRNZ6YD5` |
| f.fill | traded (0 ok, in 1999998, out 215607) | `2JJig6JqkYh8Vcakr3J7YDnSzTiv7FmGTSDd546S2fA4G7tZJY2S1yPPxFs9fdMDrnHTWeyt978P3koxRhch59JE` |
| f.fill | traded (0 ok, in 1000006, out 105984) | `etMD1E6HeHQD2ruoQn2Kw6m9GkHPuQaHatbcSZfgQLxS1M94qTDmj4gtzmZ3YEsfC2onPRHt3jPsyLUTyMjQ3Te` |
| f.daily | refused 13 over daily limit | `4yNk5CX5S8b7gyVSasD27zg1h3v5VRCYB7dR31N2MsvT5xgYKgLFaAbXSGYBnLCvYWQfF8EbX1syEtW4rjiEuSzE` |

Export and verify of one refused and one traded row (`tools/export.ts --signature <tx> | tools/verify.ts`):

- Refused f.daily `4yNk5CX5S8b7gyVSasD27zg1h3v5VRCYB7dR31N2MsvT5xgYKgLFaAbXSGYBnLCvYWQfF8EbX1syEtW4rjiEuSzE`: `VERDICT: CONFIRMED` (trade rule limits, ledger entry, and trade transaction agree).
- Traded e.honest `3rMKiGykqp9j8xPVdiFpMREtyZUr9CtFj2jqzTwAdoJqGxEkyGq81eFEscSAbZw9bJ75X26QPJdXaiFicUVDspKB`: `VERDICT: CONFIRMED` (trade rule limits, ledger entry, and trade transaction agree).

## Notes

- This script never deploys to mainnet and never prints private keys.
- `declare_id!` in `programs/veto/src/lib.rs` is left as committed. The live program address is the Program row above. A later program-side change can sync `declare_id!` in its own PR.
- The agent must keep holding zero tokens apart from the trade-demo amount recorded under Trade rule on devnet. The setup does not mint to it and does not create an agent token account.

## Hold rolling daily limit upgrade (issue 322)

The next upgrade changes HoldVault from 1291 to 1691 bytes. It appends 25
hourly buckets, shared with the trade rule's rolling counter. Every release
in the last 24 hours counts, including the whole oldest hour. Daily allowance
can therefore take up to 25 hours to return. The original fixed counter now
serves only the unchanged big-door share calculation. Execute and Skip still
count releases without imposing the everyday limit on those doors.

The decision for demo vault `8n9EcgXwSWVbQgnunw6oin8hYcpRDr1CkkvozhpiAyVj`
is to retire it and reopen after the next upgrade, with no realloc migration.
There is **no Hold close instruction** in the existing program. Neither the
old nor the new binary can reclaim its account rent. Here, retiring means
recovering all tokens to the configured safe address, leaving the old empty
accounts, and opening a new vault with a different vault ID. Do not try to
initialize the existing PDA again.

Recovery procedure for the release operator:

1. Before upgrading, retain the actual currently deployed program binary and
   its matching IDL/client. Read the demo vault with that client and record its
   owner, vault ID, mint, safe address, guardian, daily limit, delay and share.
   Derive a token account for the same mint owned by that safe address and
   create it if absent. Verify its mint and owner on chain.
2. While the old binary is still deployed, call the SDK's
   `HoldVault.recover({{ authority, owner, vaultId, destination, mint }})`, signed
   by the vault owner or guardian, with that safe token account as destination.
   Recover works while frozen and clears pending withdrawals. Confirm the
   transaction and verify the vault token balance is zero and the destination
   received the full previous balance. Keep the old vault empty thereafter.
3. Upgrade the program. The new binary rejects old 1291-byte vaults during
   account deserialization, including Recover. If step 2 was missed, the
   upgrade authority must temporarily restore the saved pre-upgrade binary,
   perform step 2 using its matching client, then deploy the new binary again.
   Do not send funds to the old PDA or attempt a direct owner token transfer;
   its token authority is the program PDA.
4. With the new client, call `initVault` with the recorded rules and a fresh
   vault ID, then deposit from a token account controlled by the funding signer.
   If the safe address differs from the owner, its signer must first return the
   recovered tokens to the owner's funding account. Verify the new vault is
   1691 bytes, its buckets are empty, and its owner, guardian, safe address and
   rules match. Replace the demo address in app/watch configuration and these
   docs with the confirmed new address. Known destinations must be learned
   again through the normal delayed withdrawal flow.

These are release steps, not actions performed by this code change. No devnet
upgrade, token movement or account retirement is part of its test run.
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
