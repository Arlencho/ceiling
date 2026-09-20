# Veto on Solana devnet

Recorded by `scripts/devnet-setup.sh` at 2026-09-20T02:13:49Z UTC.

This file lists **public addresses only**. Keypairs live under gitignored `keys/` and must never be committed.

## Cluster

- Name: `devnet`
- RPC: `http://127.0.0.1:8999`
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

- Test SPL mint at 6 decimals on the classic Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
- Owner token account funded with 1000000 tokens (a round number, not a dust amount).
- Merchant token account created and holding zero tokens.
- Agent funded with 0.5 SOL for fees and holding **zero tokens**. The setup does not create an agent token account.

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

Toolchain used when this file was written: anchor-cli 1.2.0, solana-cli 4.1.2.

```bash
./scripts/devnet-setup.sh
```

The script:

1. Points the Solana CLI at `http://127.0.0.1:8999` and refuses to continue if the URL looks like mainnet.
2. Creates `keys/` and the keypairs above when they are missing.
3. Airdrops SOL to the deployer, retrying on rate limits.
4. Builds the program. It copies `keys/program.json` to `target/deploy/veto-keypair.json`, runs `anchor keys sync` so the bytecode ID check matches the deploy address, then restores `programs/veto/src` so program source is not left dirty and is not committed.
5. Runs `anchor deploy --provider.cluster devnet`.
6. Creates the mint, owner token account, merchant token account, funds the owner, and funds the agent with SOL only.
7. Fetches the program account and rewrites this file.

Re-running with the same `keys/` directory keeps these addresses and upgrades the existing program.

## Exact commands

Cluster and wallet:

```bash
solana config set --url http://127.0.0.1:8999 --keypair keys/deployer.json --commitment confirmed
solana config get
```

Build and deploy (the wrapper script is the supported path; these are the commands it runs):

```bash
mkdir -p target/deploy
cp keys/program.json target/deploy/veto-keypair.json
anchor keys sync --program-name veto
anchor build --no-idl
git checkout -- programs/veto/src
anchor deploy --no-idl --provider.cluster devnet --provider.wallet keys/deployer.json --program-name veto --program-keypair keys/program.json
```

Demo fixtures:

```bash
spl-token create-token --decimals 6 --mint-authority GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 --fee-payer keys/deployer.json -u http://127.0.0.1:8999 -- keys/mint.json
spl-token create-account 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU --owner EGQdANFMq6xVjKcSrij4gWiH91q8TvhdY5e87KjjF2yc --fee-payer keys/deployer.json -u http://127.0.0.1:8999
spl-token create-account 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU --owner 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG --fee-payer keys/deployer.json -u http://127.0.0.1:8999
spl-token mint 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU 1000000 --mint-authority keys/deployer.json --fee-payer keys/deployer.json -u http://127.0.0.1:8999 -- FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE
solana transfer --from keys/deployer.json --fee-payer keys/deployer.json --allow-unfunded-recipient -u http://127.0.0.1:8999 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w 0.5
```

Verify:

```bash
solana account 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u http://127.0.0.1:8999
solana program show 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u http://127.0.0.1:8999 -k keys/deployer.json
spl-token balance --address FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE -u http://127.0.0.1:8999
spl-token balance --address 2bt9HMQbNy6t2J4hnw15QF8iUesPrgJoNDvf99HNay7F -u http://127.0.0.1:8999
spl-token accounts --owner 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w -u http://127.0.0.1:8999
solana balance 6YwqYUj4Kyy8dnPss34jMWgKAtLGAghmA1dRgYUGSV5w -u http://127.0.0.1:8999
```

## Program account (verification)

```
solana account 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV -u http://127.0.0.1:8999
```

```

Public Key: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Balance: 0.00114144 SOL
Owner: BPFLoaderUpgradeab1e11111111111111111111111
Executable: true
Rent Epoch: 18446744073709551615
Length: 36 (0x24) bytes
0000:   02 00 00 00  5d f0 81 85  a6 81 c7 0b  57 44 c3 e4   ....].......WD..
0010:   29 b2 c7 9c  e0 62 69 81  32 e6 5c 0f  b4 36 a6 d3   )....bi.2.\..6..
0020:   7b 95 7f 0e                                          {...
```

## Notes

- This script never deploys to mainnet and never prints private keys.
- `declare_id!` in `programs/veto/src/lib.rs` is left as committed. The live program address is the Program row above. A later program-side change can sync `declare_id!` in its own PR.
- The agent must keep holding zero tokens. Do not mint to it and do not create an agent token account.
