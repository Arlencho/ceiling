# Devnet journey

Run started: 2026-09-25T23:01:16.399Z
RPC: [redacted]
Program: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (USDC, amounts in base units)
Owner: Asq92tGg91bt1iyVJqy6bo6XjnMcTKi38goEKrgCpJC4
Agent: BHohvU2mG5mxdvLsLTrkht26Cmk5bujm1AAPhuN28jYC
Merchant: 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
Rule A: E3LoXWho4iEyiV1nrFX7XQ85UyrG5futkarGbXXEokH7
Rule B: 2DACXiUs9p4nLDRxEqavdSUz9xHv4W456d2RpSuBHTC4

| Step | Action | Signature | Result | Detail |
| --- | --- | --- | --- | --- |
| setup | fund owner and agent from deployer | 5J4YkqLLrXpwuaGb8RzpxS8JUzCaaQrD6Nniy7Hnw2ToHvuh6SuaUYaDNsa575AdTrYcawKjqdZZRgTNLdB8rGqo | pass | owner Asq92tGg91bt1iyVJqy6bo6XjnMcTKi38goEKrgCpJC4 agent BHohvU2mG5mxdvLsLTrkht26Cmk5bujm1AAPhuN28jYC, funded 3000000 USDC base units from GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
| 1 | open rule A | 5nLryaPfj8zE1TxuGy5HMjRYNTc6jM1yD4pC4g9yDCSU5YnxmapFNLwFMoCHiBuE94zZkZ3ScoygUrSFqX9tMQ5J | pass | E3LoXWho4iEyiV1nrFX7XQ85UyrG5futkarGbXXEokH7, deposited 1000000 USDC base units |
| 1 | open rule B | n3XRquWXFodtvgpE9HHrHdDZ2imQHNyCv744xh4LpRJ1TeB7LwLK8tBM7AUihvZjD5dMdfse4Nf1d9EHd15QuDg | pass | 2DACXiUs9p4nLDRxEqavdSUz9xHv4W456d2RpSuBHTC4, deposited 2000000 USDC base units |
| 2 | agent pays within rule A limit | 2DHMSP7LjgV3o239y7UEsVCzNB3KxRDHb2uwSvGPZWctugRAmcaD4hgpg9eaJe6NEYxw4tqKdQe28NEstbP5uhri | pass | paid 100000 USDC base units nonce 1 |
| 3 | agent asks above rule A per-payment limit | 2Bw8Cma8kvyco8JefAZZ6dY8TGu12ivuW7CudWrDfsKm5TRZot3AVQRQYSYu9edjUgJDxbv5nZ3MSbvCCYWTvjDR | pass | refused 300000 USDC base units nonce 2 override 300000 USDC base units |
| 4 | owner grants the recorded override | 2AecjqQ89fTMi4NyjGWURYPsJadTmNA8KaiqjPNUMQmanrrb73W1fAM3ae95krjX1Mtf54FRUz2ewVKA7uaQbiJG | pass | override 300000 USDC base units nonce 2 |
| 4 | agent retries the overridden charge | 39SRuE8D7UAsnDbzPthLU9zeusjxTJFJ784kECE5CmiqxVwx82KtCbGuScVCg9PwPR6iJdD87ekQBhiFiLA1pWMm | pass | paid 300000 USDC base units nonce 2 |
| 5 | agent pays under rule B | 4fAMQ3u8PFw4GhY8gkaGCfqqzonH4qQz81sbQWY4FcrEZ3sDPF5tkJNrJUtnLBmNNWS2ZfVDetYYjVCAoWQzJUnp | pass | paid 150000 USDC base units nonce 1 |
| 6 | revoke rule A | 4dXhTUkwKtgbgHY8B4QtrEQBHt2PsGpuT5rBmx6ncqZ49ur6j2zEHoeMRgb1P843kZ3qWmQeHjRxkzeBAL7Caukh | pass | rule A revoked, delegate cleared |
| 6 | agent charges revoked rule A | 326EAyfAPDFwqvhmxM2eZByuM2ZmDBruKAxeRBvH72qFLYyKY6rSnFvNHfpfRn8gZbkipihwUyrHMoihE9rbWDRd | pass | refused 100000 USDC base units nonce 3 reason 1 |
| 6 | agent pays under rule B after rule A is revoked | gxWoUZgLRFavoZeDCDPd2KU35N6dD9JYagVbq9MU3vWGsdSqw4YktvVZJaaDSmw86nuaNpxq1MQM5JxEQp2PwBH | pass | paid 200000 USDC base units nonce 2 |
| 8 | verify rule A within limit | 2DHMSP7LjgV3o239y7UEsVCzNB3KxRDHb2uwSvGPZWctugRAmcaD4hgpg9eaJe6NEYxw4tqKdQe28NEstbP5uhri | pass | VERDICT: CONFIRMED |
| 8 | verify rule A over per-payment limit | 2Bw8Cma8kvyco8JefAZZ6dY8TGu12ivuW7CudWrDfsKm5TRZot3AVQRQYSYu9edjUgJDxbv5nZ3MSbvCCYWTvjDR | pass | VERDICT: CONFIRMED |
| 8 | verify rule A retry after override | 39SRuE8D7UAsnDbzPthLU9zeusjxTJFJ784kECE5CmiqxVwx82KtCbGuScVCg9PwPR6iJdD87ekQBhiFiLA1pWMm | pass | VERDICT: CONFIRMED |
| 8 | verify rule A after revoke | 326EAyfAPDFwqvhmxM2eZByuM2ZmDBruKAxeRBvH72qFLYyKY6rSnFvNHfpfRn8gZbkipihwUyrHMoihE9rbWDRd | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule A decisions |  | pass | 4 records CONFIRMED |
| 8 | tamper one amount and verify again | 2DHMSP7LjgV3o239y7UEsVCzNB3KxRDHb2uwSvGPZWctugRAmcaD4hgpg9eaJe6NEYxw4tqKdQe28NEstbP5uhri | pass | VERDICT: REJECTED |
| 7 | close rule A | 3XNHS6R874Kfc36X9oX6FKv4Jv4E5Gs6CdGeYsTHRh9Mk1kB6u5Vu8E7P5QGby2pzyWtrRdhHwxFdWV9zeyN5cGC | pass | returned 600000 USDC base units and 16311880 SOL lamports, fee 5000 SOL lamports |
| 8 | verify rule B within limit | 4fAMQ3u8PFw4GhY8gkaGCfqqzonH4qQz81sbQWY4FcrEZ3sDPF5tkJNrJUtnLBmNNWS2ZfVDetYYjVCAoWQzJUnp | pass | VERDICT: CONFIRMED |
| 8 | verify rule B after rule A revoked | gxWoUZgLRFavoZeDCDPd2KU35N6dD9JYagVbq9MU3vWGsdSqw4YktvVZJaaDSmw86nuaNpxq1MQM5JxEQp2PwBH | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule B decisions |  | pass | 2 records CONFIRMED |
| 9 | close rule B | 5StDF882WeXGADEv9JnVYuYC6niNRj3AEohqoHrrxGxJr9HRGpLSsXmzU2psCwz6hUu5J6Ro6qqBRMSyozAhEyHW | pass | returned 1650000 USDC base units and 16311880 SOL lamports, fee 5000 SOL lamports |
| cleanup | return remaining tokens to funder and SOL to deployer | jSWEcLG88EQWYubWME7EQ1w1gMBS98NoL3MrkCioZWYywrwXgQGhYkyporJro6BQAiYA2XAiRRr7m7jxHxzDFtr | pass | returned 2250000 USDC base units to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1, 399970000 owner SOL lamports, 49970000 agent SOL lamports, 1488440 token-account SOL lamports, to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
