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

### Trade upgrade, 2026-09-25

On 2026-09-25T22:58:50Z the program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` was upgraded on devnet in slot 504196958. This completes the 2026-09-25T22:21:37Z attempt, which had stopped before deployment because `VETO_RPC` was unset in the run environment.

- Upgrade signature: `3VWb3pABFZYSeYdNnQaG6bbKvLUFpyJgFcicNV81RAdas6s2TcWgp6SBWbev6vWR41kU1MzLM2puFRkrwmaWLqJ6`
- Transaction: https://explorer.solana.com/tx/3VWb3pABFZYSeYdNnQaG6bbKvLUFpyJgFcicNV81RAdas6s2TcWgp6SBWbev6vWR41kU1MzLM2puFRkrwmaWLqJ6?cluster=devnet
- Program data account: `7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM`. The upgrade first extended it by 152568 bytes because the new binary is larger than the 440152 bytes the account held, then wrote the program into it. The account itself is 592765 bytes, which includes the loader header.
- Program data account: https://explorer.solana.com/address/7KhczbWwnrJYLF2YA3oyxosZLoqaPZDXh64tQJmsAAcM?cluster=devnet
- Program data: 592720 bytes, SHA-256 `7b96751bf3cad17225a46f21c951bd04c9b4f30be0f00ec092a8999cab8255e9`. `solana program dump` of the upgraded program is byte-identical to the build below.
- The binary is a deploy-arch build of main at `b7aac4a3806b67b872e35407acede5e1d1246199` (`b7aac4a`), from a clean checkout with `rm -f target/deploy/veto.so` then `anchor build --ignore-keys` and no v0 flag. Main CI on that commit: [successful run 36198015670](https://github.com/Arlencho/veto/actions/runs/36198015670). Main advanced to `992a0fbd104e248117b4f5b828f0c8213a7830c3` during the run without touching `programs/`, so the binary still matches the program source on main; main CI stayed green ([run 36200818637](https://github.com/Arlencho/veto/actions/runs/36200818637)).
- `make test` from the same commit: 127 passed, 0 failed. Counts: unit 2, Hold 19, Hold red-team 18, payment red-team 20, refusal recording 6, SKR mint 2, token-swap fixture 3, trade 27, trade red-team 30; doc-tests 0.
- The trade rule (`open_trade_rule`, `trade`, `grant_trade_override`, `revoke_trade_rule`, `close_trade_rule`) is in this binary; its red-team suite is `programs/veto/tests/trade_red_team.rs`.
- `make e2e-devnet` passed on the upgraded program: `devnet journey opens two rules, pays, refuses, overrides, revokes, closes, and verifies every decision`; tests 1, pass 1, fail 0.
- `make hold-e2e-devnet` passed on the upgraded program: `a Hold vault pays a known everyday withdrawal at once, holds a big one, and lets the guardian stop, freeze, and recover`; tests 1, pass 1, fail 0. Vault `9HAAoskDkZj1RE1QHm7i9RZEaMNpeo7uphCA6wi2NrdQ`: everyday withdrawal paid at once, big withdrawal held and refused before unlock, guardian stop, freeze, recover while frozen, unfreeze with both keys, loosening waits, tightening applies at once.
- `anchor idl build` from the same commit matches the deployed program's interface, and `diff` against each committed consumer copy is empty: `watcher/idl/veto.json`, `tools/idl/veto.json`, `sdk/idl/veto.json`.

### Hold upgrade, 2026-09-25

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

Opened 2026-09-25 on the upgraded program with the owner key `keys/owner.json` (the recorded owner `EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc`, not a fresh key) on the wSOL and USDC demo pool above: per trade 0.002 SOL, per day 0.01 SOL, cap 0.05 SOL, floor 90 percent of the spot at open, 30 days. The trade rule's own account holds the wrapped cap; the pool accounts come from the `TOKEN_SWAP_*` values in `keys/devnet-addresses.env`, matching the Demo pool table.

Just before the open the deployer deposited matching liquidity into the pool at the unchanged rate (signature `5jv4CftALiPxcRv8b5Qf8B35YncsYN1xQ2xNGkBkfuTCdNQfe7ysoRvsFGUSBvSoMB9pgxMkiNdArcnQuCRED2Lm`), doubling the vaults from 83999994 lamports and 9881306 USDC base units to 167999988 and 19762612, so the journey's full daily volume clears the 90 percent floor.

- Rule: `91D7FjbUXcsZ6a1rAnS2u4XHd7rFhc1Y7zxiApV7w3jY`; ledger `HLTTzfMHiKtE8onBg3F9fsdCXo7P9gByih2n8hPo9H6b`; source `ArFd2g8VF4jz1q9ZSRXr4thncJt74KNfXGxgKy4qAGa7`; destination `HcyMqQuodBgL9RzMMbEwAM6zYZhoFrSnoPuVbqVh6wgg`; agent `6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w`; floor 14821959/139999990; expires_at 1792970226.
- Rule: https://explorer.solana.com/address/91D7FjbUXcsZ6a1rAnS2u4XHd7rFhc1Y7zxiApV7w3jY?cluster=devnet
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
   `HoldVault.recover({ authority, owner, vaultId, destination, mint })`, signed
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
