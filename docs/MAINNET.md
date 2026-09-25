# Veto on Solana mainnet

This file lists public addresses only. Keypairs live under gitignored `keys/` and must never be committed.

Do not put funds you cannot lose under this program on mainnet

## Containment

- Own wallet only. No third-party funds.
- Mandate path only, capped at 200 SKR total and 10 SKR per payment.
- No Hold vault is ever opened on mainnet.
- The store build stays on devnet.
- Upgrade authority is held by the deployer key, `keys/deployer.json`.

These are operator containment rules. The deploy script does not configure payment limits or open mandates or vaults.

## Cluster

- Name: `mainnet-beta`
- RPC: required environment variable `VETO_MAINNET_RPC`; never record its value here.
- Genesis hash: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`

## Public addresses

| Role | Address |
|---|---|
| Program | `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV` |
| SKR mint (6 decimals) | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` |
| Classic token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Rule | TBD |
| Owner | TBD |
| Agent | TBD |
| Payee | TBD |

## Keypairs

| File | Whose key |
|---|---|
| `keys/program.json` | Backed-up program key matching `declare_id!` |
| `keys/deployer.json` | Deployer, fee payer and upgrade authority |

## Deployment gates

Deploy commit: TBD

Deployment is intentionally blocked. The script requires this line to equal the full current `git rev-parse HEAD` and the entire working tree to be clean, including untracked files. A tracked file cannot practically contain the hash of its own commit: editing this line dirties the tree, and committing it changes HEAD again. Both requested guards remain enforced. A separately approved change to the commit-attestation policy is needed before real deployment is possible; do not bypass either check.

With that policy resolved, the guarded entry points are:

```bash
./scripts/mainnet-deploy.sh --dry-run
./scripts/mainnet-deploy.sh
```

Supply `VETO_MAINNET_RPC` through the environment. The script never prints the endpoint, and suppresses CLI diagnostics that might contain query-string credentials. It does not change the local Solana CLI configuration.

Both modes require the backed-up keys, matching program identity, clean checkout, approved commit, mainnet genesis hash, at least 5 SOL in the deployer wallet, a fresh Anchor deployment build and the exact confirmation `DEPLOY`. Dry run makes read-only RPC calls, builds, reports size, rent and SHA256, and exits without deploying or changing this file. It is not an offline mode.

The build unsets `ANCHOR_BUILD_SBF_ARCH`, removes `target/deploy/veto.so` and runs `anchor build --no-idl`, as in the devnet setup. It never reuses the v0 test ELF. The script prints the rent for the program and program data accounts plus the temporary buffer; upgrades may already have rent locked. Fees are additional. Deployment sets the deployer explicitly as fee payer and upgrade authority, with a compute unit price of 5000 micro-lamports.

After deployment, `solana program show` verifies the program and authority. The script appends UTC date, deployed slot, transaction signature, binary SHA256 and commit below. Commit that public log separately. If deployment succeeds but verification or log writing fails, reconcile the chain state before retrying.

## Deploy log
