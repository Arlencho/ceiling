# Devnet journey

Run started: 2026-09-24T01:07:39.559Z
RPC: https://api.devnet.solana.com
Program: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Mint: 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU
Owner: AWpJ71CyPaaHa9UpTE1ZbPTgkJTiukADH19FiE2jrB5N
Agent: Bt1mDyCAdtrx1LG8kTUNirqtwxyM283EYbrYEDMBSwtr
Merchant: 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
Rule A: CJNEEv9vQNTbwFgDDrXtGmJsoJ4np6RFLqNp8qvE86gA
Rule B: 7ENXK8MGqtLEiWenPhUnkauarJQUpjDur6BtgmohGSyo

| Step | Action | Signature | Result | Detail |
| --- | --- | --- | --- | --- |
| setup | fund owner and agent from deployer | GTrm3D1th8GFP2n44ppcFs4QDrxkTaaiZ1r9M7keXREdQmL2Un6eny1HikGyWhvEZxnNr4cAmPv94KbF78JEDQg | pass | owner AWpJ71CyPaaHa9UpTE1ZbPTgkJTiukADH19FiE2jrB5N agent Bt1mDyCAdtrx1LG8kTUNirqtwxyM283EYbrYEDMBSwtr |
| 1 | open rule A | 3jqRDFFwAMwa15SYfrK7d2uYAL9wEwjynHwuCNTXL3aDosMLDaeHfLTW7Q862AJuhhzpwH9hqBEAjoRp3Cfk9GGM | pass | CJNEEv9vQNTbwFgDDrXtGmJsoJ4np6RFLqNp8qvE86gA |
| 1 | open rule B | 4AnmBjyfRyYPK3vkaAZDo6fhpheGhTkfMj8AFXhhass273w1XzTeictRs7AJrL2bcad5TDyyMFH5v9H1cb72dgzy | pass | 7ENXK8MGqtLEiWenPhUnkauarJQUpjDur6BtgmohGSyo |
| 2 | agent pays within rule A limit | hSiiYcfaex6wGFE1okgpJWdPCCB6FP3g9e1rKUTM9r9uU3s6dFd1qVPasWkwUin2eFiSFSAqLq1HgngNBUQTx9U | pass | paid 100000 nonce 1 |
| 3 | agent asks above rule A per-payment limit | 4A57BCzRCLQHuXMUuJZvXNAUwwDdcmzeJkrwK7v3FEXur6NUUtX1hZ1cZWDeiFBjNoW9a2eq2FmqgiVS9n6Vz3y4 | pass | refused 300000 nonce 2 override 300000 |
| 4 | owner grants the recorded override | QFaKgvoQrb7DNHEeoQYBAg75Ls1fZ8FLAuEJxGLceTgg2axGZSg1owhSecLkVXYJHYS8oBthKaJPJZXc7WS6PC1 | pass | override 300000 nonce 2 |
| 4 | agent retries the overridden charge | St7qxLHVCeeeY1Uqtkio5K3EoakXi22odCyyr71KMS9LMSr1RECh1VcagyA2gdsGTif9dTyfaqvG8bvGGCHEe8J | pass | paid 300000 nonce 2 |
| 5 | agent pays under rule B | 2WeiAEw2SCH9x1Yzo22L4AZ2jKdZeHoULzfsCPKTp6VBwuAnXDGJid1Z1bfTwK9PTqGdGR8iGFzfKgKe7GbSNJSc | pass | paid 150000 nonce 1 |
| 6 | revoke rule A | 22T7ii6miwvcG5FjfnqUdUX9u2Mn3BR3vzJvHoxYnMJRvkSLLo7cViEra19kmPSUZV7YnRMjz3STWCXPKsnJCzW9 | pass | rule A revoked, delegate cleared |
| 6 | agent charges revoked rule A | 51Q3LgfotaQszgbvFfaAM1HSgM964ebkNa12ThGViY1Q5RL7TkVEZJHBFPJEpn4PzfA7YYFXmyJaqiuJdVH2jppe | pass | refused 100000 nonce 3 reason 1 |
| 6 | agent pays under rule B after rule A is revoked | 5gH33puiyWzcQjhLeiW1P3TyJ5qmGndrP8ieghARUTTwDXbpLnph1CG7bfC9PvYDvECUPqfesr72ZmtxBWrWQr4t | pass | paid 200000 nonce 2 |
| 8 | verify rule A within limit | hSiiYcfaex6wGFE1okgpJWdPCCB6FP3g9e1rKUTM9r9uU3s6dFd1qVPasWkwUin2eFiSFSAqLq1HgngNBUQTx9U | pass | VERDICT: CONFIRMED |
| 8 | verify rule A over per-payment limit | 4A57BCzRCLQHuXMUuJZvXNAUwwDdcmzeJkrwK7v3FEXur6NUUtX1hZ1cZWDeiFBjNoW9a2eq2FmqgiVS9n6Vz3y4 | pass | VERDICT: CONFIRMED |
| 8 | verify rule A retry after override | St7qxLHVCeeeY1Uqtkio5K3EoakXi22odCyyr71KMS9LMSr1RECh1VcagyA2gdsGTif9dTyfaqvG8bvGGCHEe8J | pass | VERDICT: CONFIRMED |
| 8 | verify rule A after revoke | 51Q3LgfotaQszgbvFfaAM1HSgM964ebkNa12ThGViY1Q5RL7TkVEZJHBFPJEpn4PzfA7YYFXmyJaqiuJdVH2jppe | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule A decisions |  | pass | 4 records CONFIRMED |
| 8 | tamper one amount and verify again | hSiiYcfaex6wGFE1okgpJWdPCCB6FP3g9e1rKUTM9r9uU3s6dFd1qVPasWkwUin2eFiSFSAqLq1HgngNBUQTx9U | pass | VERDICT: REJECTED |
| 7 | close rule A | 3bSgwBkDaWRjKeyeuzjLyyBbLCdKXYBypziq3v7z3Nu3R5ZGTLdVH2YqbuTQ7dPFTuTqXGBDH4hu3zRiZeGryBUM | pass | returned 600000 tokens and 16311880 lamports, fee 5000 |
| 8 | verify rule B within limit | 2WeiAEw2SCH9x1Yzo22L4AZ2jKdZeHoULzfsCPKTp6VBwuAnXDGJid1Z1bfTwK9PTqGdGR8iGFzfKgKe7GbSNJSc | pass | VERDICT: CONFIRMED |
| 8 | verify rule B after rule A revoked | 5gH33puiyWzcQjhLeiW1P3TyJ5qmGndrP8ieghARUTTwDXbpLnph1CG7bfC9PvYDvECUPqfesr72ZmtxBWrWQr4t | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule B decisions |  | pass | 2 records CONFIRMED |
| 9 | close rule B | 54zYjEd2w8hyVXgSLKJQDVAmw6W8JzWZZQrE7Tv3CyqrGp4XPC4YVALTWXpQyEe93W8ZamqwT5oXKzLTWcGzjB9M | pass | returned 1650000 tokens and 16311880 lamports, fee 5000 |
| cleanup | return remaining SOL and tokens to deployer | priJsgT6bLaxYsqzKz7E7SN6XWfsNNC5NFgzu9nCESuFvrPVKE7od9jYsUkVgvnuknAx9q54mvJfBeh62ywxrG7 | pass | returned 4250000 tokens, 399970000 owner lamports, 49970000 agent lamports, 1488440 token-account lamports, to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
