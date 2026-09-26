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

After reviewing and committing all deployment changes, create an annotated attestation tag on the exact commit to deploy. Tags do not change HEAD or dirty the checkout:

```bash
git tag -a mainnet-deploy-YYYYMMDD-1 -m "Reviewed mainnet deployment: describe the approved changes" HEAD
git push origin mainnet-deploy-YYYYMMDD-1
```

Choose a unique tag name and replace the message with the review details. The script requires a clean tree, including untracked files, and an exact annotated tag matching `mainnet-deploy-*` on HEAD. Lightweight tags and tags on ancestor commits are rejected. It prints the selected tag and its message for operator review. Fetch the attestation tag when deploying from another checkout. An annotated tag records review intent; it is not a cryptographic signature or an identity authorization check.

The guarded entry points are:

```bash
./scripts/mainnet-deploy.sh --dry-run
./scripts/mainnet-deploy.sh
```

Supply `VETO_MAINNET_RPC` through the environment. The script never prints the endpoint, and suppresses CLI diagnostics that might contain query-string credentials. It does not change the local Solana CLI configuration.

Both modes require the backed-up keys, matching program identity, clean checkout, annotated attestation tag, mainnet genesis hash, at least 5 SOL in the deployer wallet, a fresh Anchor deployment build and the exact confirmation `DEPLOY`. Dry run makes read-only RPC calls, builds, reports size, rent and SHA256, and exits without deploying or changing this file. It is not an offline mode.

The build unsets `ANCHOR_BUILD_SBF_ARCH`, removes `target/deploy/veto.so` and runs `anchor build --no-idl`, as in the devnet setup. It never reuses the v0 test ELF. The script prints the rent for the program and program data accounts plus the temporary buffer; upgrades may already have rent locked. Fees are additional. Deployment sets the deployer explicitly as fee payer and upgrade authority, with a compute unit price of 5000 micro-lamports.

After deployment, `solana program show` verifies the program and authority. The script appends UTC date, deployed slot, transaction signature, binary SHA256 and commit below. Commit that public log separately. If deployment succeeds but verification or log writing fails, reconcile the chain state before retrying.

If a deploy fails, inspect the program state before retrying. List buffers owned by the deployer with `solana program show --buffers --buffer-authority <deployer>`, then reclaim an identified abandoned buffer with `solana program close <buffer>`. Use the explicit mainnet RPC and the deployer signing key for these commands:

```bash
solana program show --buffers --buffer-authority <deployer> --url "$VETO_MAINNET_RPC"
solana program close <buffer> --keypair keys/deployer.json --url "$VETO_MAINNET_RPC"
```

Replace the angle-bracket placeholders with the deployer public key and the abandoned buffer address. Confirm the buffer is no longer needed before closing it. Do not close the program account. A successful deployment followed by failed verification or log writing also needs reconciliation before another attempt.

Because deployment reserves only the current binary size with `--max-len`, a larger future binary needs `solana program extend` first to increase the program data allocation, with enough SOL for the additional rent.

## Deploy log
