# Veto on Solana devnet

Recorded by `scripts/devnet-setup.sh` at 2026-09-20T20:57:14Z UTC.

This file lists **public addresses only**. Keypairs live under gitignored `keys/` and must never be committed.

## Cluster

- Name: `devnet`
- RPC: `https://api.devnet.solana.com`
- Explorer cluster query: `cluster=devnet`

## Public addresses

| Role | Address |
|---|---|
| Program | `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` |
| Test SPL mint (6 decimals) | `2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU` |
| Owner | `EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc` |
| Owner token account | `FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE` |
| Merchant | `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG` |
| Merchant token account | `2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F` |
| Agent | `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w` |
| Deployer (fee payer, upgrade authority, mint authority) | `GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1` |

Explorer:

- Program: https://explorer.solana.com/address/3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV?cluster=devnet
- Mint: https://explorer.solana.com/address/2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU?cluster=devnet
- Owner token account: https://explorer.solana.com/address/FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE?cluster=devnet
- Merchant token account: https://explorer.solana.com/address/2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F?cluster=devnet
- Agent: https://explorer.solana.com/address/6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w?cluster=devnet

## Fixtures

These bullets are written by `write_docs` in `scripts/devnet-setup.sh`. Re-running the script rewrites this file from that template.

- Test SPL mint at 6 decimals on the classic Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
- The test SPL mint is a devnet test token named Veto test token, symbol VTEST, with no value.
- Setup minted 1000000 tokens to the owner token account on 2026-09-20T20:57:14Z. Mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` paid 0.666 of that supply to the merchant across three charges on 2026-09-20 (0.446, 0.2145, 0.0055). Later rules opened in the app, and `make e2e-devnet`, pay the same merchant from other token accounts, so the live merchant balance is that 0.666 plus every later payment. Read both balances with the verify commands below. A printed figure goes stale when a charge pays.
- The owner token account is still the source for mandates id 1 and id 3. A rule opened in the app uses a different account, seed `veto-rule-<mandate id>`, derived from that rule's owner. There is not one owner token account for every rule.
- The agent was funded with 0.5 SOL. The live balance is that amount minus fees. The setup does not create an agent token account. On 2026-09-24 `getTokenAccountsByOwner` for the agent returned no accounts.

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

Reading the program on devnet does not use this section. The verify commands below, and export / verify in the README, call `https://api.devnet.solana.com` and do not need a keypair.

`make setup` and `make localnet` deploy. Both run this script. They need the maintainer backup of `keys/program.json`, the keypair for `declare_id` `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`. That file is not in git (`keys/` is gitignored). If it is missing, the script stops with `keys/program.json is missing; the program keypair must be restored from backup` and does not mint a replacement. A fresh clone cannot run either target until that backup is restored. `npx tsx produce.ts` is also not a read: it needs `keys/owner.json` from the same backup.

Toolchain named when this file was first written: anchor-cli 1.2.0, solana-cli 4.1.2. Anchor 1.2.0 is the version CI installs. The repo does not pin the Solana CLI. CI installs the stable release.

```bash
VETO_RPC=https://api.devnet.solana.com ./scripts/devnet-setup.sh
```

The script does not choose an RPC. It refuses and names `VETO_RPC` if that variable is unset.

The script:

1. Points the Solana CLI at `https://api.devnet.solana.com` and refuses to continue if the URL looks like mainnet.
2. Requires `keys/program.json` from the maintainer backup. A missing file is an error. It creates `keys/` and the other keypairs in the table when they are missing.
3. Airdrops SOL to the deployer, retrying on rate limits.
4. Builds the program. It stops if `programs/veto/src` has local edits. It copies `keys/program.json` to `target/deploy/veto-keypair.json`, deletes `target/deploy/veto.so`, runs `anchor keys sync`, then `anchor build --no-idl`, then restores `programs/veto/src` and `Anchor.toml`.
5. Runs `anchor deploy --no-idl --provider.cluster` with the `VETO_RPC` URL (not the cluster name). A failed deploy retries with `-- --with-compute-unit-price 5000`.
6. Creates the mint, owner token account, and merchant token account when they are absent. It mints 1000000 tokens only when the owner balance is below that. It transfers 0.5 SOL to the agent only when the agent holds fewer than 400000000 lamports.
7. Fetches the program account and rewrites this file.

Re-running with the same `keys/` directory keeps these addresses and upgrades the existing program.

## Exact commands

Cluster and wallet:

```bash
solana config set --url https://api.devnet.solana.com --keypair keys/deployer.json --commitment confirmed
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
anchor deploy --no-idl --provider.cluster https://api.devnet.solana.com --provider.wallet keys/deployer.json --program-name veto --program-keypair keys/program.json
```

If that deploy exits non-zero, the script retries the same command with `-- --with-compute-unit-price 5000`.

Demo fixtures (each command runs only when the account is missing, the owner balance is under 1000000 tokens, or the agent holds fewer than 400000000 lamports):

```bash
spl-token create-token --decimals 6 --mint-authority GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 --fee-payer keys/deployer.json -u https://api.devnet.solana.com -- keys/mint.json
spl-token create-account 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU --owner EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc --fee-payer keys/deployer.json -u https://api.devnet.solana.com
spl-token create-account 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU --owner 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG --fee-payer keys/deployer.json -u https://api.devnet.solana.com
spl-token mint 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU 1000000 --mint-authority keys/deployer.json --fee-payer keys/deployer.json -u https://api.devnet.solana.com -- FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE
solana transfer --from keys/deployer.json --fee-payer keys/deployer.json --allow-unfunded-recipient -u https://api.devnet.solana.com 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w 0.5
```

Verify:

```bash
solana account 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u https://api.devnet.solana.com
solana program show 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u https://api.devnet.solana.com
spl-token balance --address FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE -u https://api.devnet.solana.com
spl-token balance --address 2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F -u https://api.devnet.solana.com
spl-token accounts --owner 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w -u https://api.devnet.solana.com
solana balance 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w -u https://api.devnet.solana.com
```

`solana program show` answers this read without a signer. Passing `-k keys/deployer.json` fails on a fresh clone, because that file is gitignored, and the CLI then tells you to generate a new key. The upgrade authority it prints is the Deployer row above.

## Program account (verification)

```
solana account 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u https://api.devnet.solana.com
```

```
Public Key: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Balance: 0.00083312 SOL
Owner: BPFLoaderUpgradeab1e11111111111111111111111
Executable: true
Rent Epoch: 18446744073709551615
Length: 36 (0x24) bytes
0000:   02 00 00 00  5d f0 81 85  a6 81 c7 0b  57 44 c3 e4   ....].......WD..
0010:   29 b2 c7 9c  e0 62 69 81  32 e6 5c 0f  b4 36 a6 d3   )....bi.2.\..6..
0020:   7b 95 7f 0e                                          {...
```

## Upgrades

On 2026-09-25T12:18:23Z the program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` was upgraded on devnet in slot 503984132.

- Upgrade signature: `5papvME2orZuY6PxEmmwymmkHzwyquCnHgpygCbCdV2qUKJSg5D1HpVGpz5pY2FrpeuEZ5ZKDLsyNLifyC9k4RT`
- Transaction: https://explorer.solana.com/tx/5papvME2orZuY6PxEmmwymmkHzwyquCnHgpygCbCdV2qUKJSg5D1HpVGpz5pY2FrpeuEZ5ZKDLsyNLifyC9k4RT?cluster=devnet
- Program data: 440152 bytes, the binary inside account `7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM` (the account itself is 440197 bytes, which includes the loader header).
- Program data account: https://explorer.solana.com/address/7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM?cluster=devnet
- The on-chain binary is byte-identical to a build of main at `7c580cb78b04f89b8d4f85f91bdb41988b75de9d` (`7c580cb`).
- The Hold vault in that binary includes the red-team fixes from [PR 270](https://github.com/Arlencho/veto/pull/270).
- `make hold-e2e-devnet` then passed on devnet. Vault `2Tk8Qfd23udSkHZAQvx8x1TXU166n26HtjzCjaSeoqaU`: everyday withdrawal paid at once, big withdrawal held and refused before unlock, guardian stop, freeze, recover while frozen, unfreeze with both keys, loosening waits, tightening applies at once.
- Vault: https://explorer.solana.com/address/2Tk8Qfd23udSkHZAQvx8x1TXU166n26HtjzCjaSeoqaU?cluster=devnet

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

## Notes

- This script never deploys to mainnet and never prints private keys.
- `declare_id!` in `programs/veto/src/lib.rs` is left as committed. The live program address is the Program row above. A later program-side change can sync `declare_id!` in its own PR.
- The agent must keep holding zero tokens. Do not mint to it and do not create an agent token account.
