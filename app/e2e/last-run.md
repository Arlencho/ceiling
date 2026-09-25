# Devnet journey

Run started: 2026-09-25T17:26:17.099Z
RPC: [redacted]
Program: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (USDC, amounts in base units)
Owner: FhcMvNXTdoS53zzNtKLMGCrQsGCaHFpbXpwjjpdMsKEM
Agent: B7NMqW2iRGnWhwizGN3NZFgbnHKSZYT1nvtTUxNf9fzd
Merchant: 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
Rule A: 3h7XgnZS5YiDbkCYTHUNQiVvc2jAnRe4vqXpGnawRYi1
Rule B: 7HJNCDNzvuKtYbqrTsJTKhWtsELZpVk8FEYM7afqtd8K

| Step | Action | Signature | Result | Detail |
| --- | --- | --- | --- | --- |
| setup | fund owner and agent from deployer | 21xNZkqino3JLvqYTgrfUNPJ3L7jR5Mx4WNMYcYkactfz5327nbCUK6k856ZWFTkSMWk18BcMyxw8gMecFRABvQw | pass | owner FhcMvNXTdoS53zzNtKLMGCrQsGCaHFpbXpwjjpdMsKEM agent B7NMqW2iRGnWhwizGN3NZFgbnHKSZYT1nvtTUxNf9fzd, funded 3000000 USDC base units from GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
| 1 | open rule A | 5hFGAsTPfbtKTUrM9RrTBFKr7hAxpQjG7DciZSCu4XCitViCyX4RtEKdDuL6AnPqJPxgvWTK1txqcWyk5kvS1ZmV | pass | 3h7XgnZS5YiDbkCYTHUNQiVvc2jAnRe4vqXpGnawRYi1, deposited 1000000 USDC base units |
| 1 | open rule B | 2CciBZgkbUgc4wU3HcinvQRDcSwCK2WN5a4ZsaqTC5AWHzd6bZ2y8JBgd8tWQisWfU5C7RUnb3oNkTSnhpH5AZ66 | pass | 7HJNCDNzvuKtYbqrTsJTKhWtsELZpVk8FEYM7afqtd8K, deposited 2000000 USDC base units |
| 2 | agent pays within rule A limit | 2c9sZpBaVcvirPutYWNb1A8qDQLbEVPwfRjJ2x1PdgGKBAZTKRQ4XJZrZczMz2NfJJWTbCeamQbASoyMngNkngo8 | pass | paid 100000 USDC base units nonce 1 |
| 3 | agent asks above rule A per-payment limit | 441dfbtgGoDtoNb8WvLdbK4XA66VciGMgyPfZcdGeEys3a1GRB2kw28nfGsMMfBj938Ln6rEeRWbV64cGm8eygtH | pass | refused 300000 USDC base units nonce 2 override 300000 USDC base units |
| 4 | owner grants the recorded override | 2uYXmxAyENsDPXCioXta7447MKLfd1aQUPMr8uMvFdqWVrnYad6ayd588KUDXQp7KktL5GWFwhSH2SQn3VDdKQQC | pass | override 300000 USDC base units nonce 2 |
| 4 | agent retries the overridden charge | 5FDGvv8uvBk1pSHoSW1PM5eeD48DcBydUQjAZAm1MFXnczBgJ1VMCgEz8ZhJQehpGSNLdE4E7sQrWQo25ry6syDC | pass | paid 300000 USDC base units nonce 2 |
| 5 | agent pays under rule B | v7PEG2x13h4WwKqSZWUucc7mPG9CyKDEkUFsfx6Cf4856P67mWeruWYsRqiCjVVdbNVJ3XuTxTgMQFho1fzJs17 | pass | paid 150000 USDC base units nonce 1 |
| 6 | revoke rule A | 2qT4ZHvpdNNW3gU9ftoXF9WWvVjdUPLNT3znJSsHrptNZ8piMAmWqGzYvcf1wwXXjU9SWK74Tm7bDnofDxSqXtDK | pass | rule A revoked, delegate cleared |
| 6 | agent charges revoked rule A | Vm7mMBJzVb2n2LRM6QhcmzgBQ7gWYbv2jfd7Y4e3oWAQGFse9btaz3Bxh5ZPc9jZuJDrLukGWmAkP3Ftz2e8oHe | pass | refused 100000 USDC base units nonce 3 reason 1 |
| 6 | agent pays under rule B after rule A is revoked | 52L8fKX47garZ3Et8HMSKB4NtcScXZ3CXMCGyfnJ7zmiszzBUEvQ3LdTtMgxjWx3MWS9ez6uxmskojW4xZ5YWhE3 | pass | paid 200000 USDC base units nonce 2 |
| 8 | verify rule A within limit | 2c9sZpBaVcvirPutYWNb1A8qDQLbEVPwfRjJ2x1PdgGKBAZTKRQ4XJZrZczMz2NfJJWTbCeamQbASoyMngNkngo8 | pass | VERDICT: CONFIRMED |
| 8 | verify rule A over per-payment limit | 441dfbtgGoDtoNb8WvLdbK4XA66VciGMgyPfZcdGeEys3a1GRB2kw28nfGsMMfBj938Ln6rEeRWbV64cGm8eygtH | pass | VERDICT: CONFIRMED |
| 8 | verify rule A retry after override | 5FDGvv8uvBk1pSHoSW1PM5eeD48DcBydUQjAZAm1MFXnczBgJ1VMCgEz8ZhJQehpGSNLdE4E7sQrWQo25ry6syDC | pass | VERDICT: CONFIRMED |
| 8 | verify rule A after revoke | Vm7mMBJzVb2n2LRM6QhcmzgBQ7gWYbv2jfd7Y4e3oWAQGFse9btaz3Bxh5ZPc9jZuJDrLukGWmAkP3Ftz2e8oHe | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule A decisions |  | pass | 4 records CONFIRMED |
| 8 | tamper one amount and verify again | 2c9sZpBaVcvirPutYWNb1A8qDQLbEVPwfRjJ2x1PdgGKBAZTKRQ4XJZrZczMz2NfJJWTbCeamQbASoyMngNkngo8 | pass | VERDICT: REJECTED |
| 7 | close rule A | 58oDBF1dgausZ31B1afwpxTHwnWJhXwjQ8ZU3qXZDQGnpCCYtG9KFB1bZWWVaaQMZr9cbQUKz4CRsTyexFMCVbMj | pass | returned 600000 USDC base units and 16311880 SOL lamports, fee 5000 SOL lamports |
| 8 | verify rule B within limit | v7PEG2x13h4WwKqSZWUucc7mPG9CyKDEkUFsfx6Cf4856P67mWeruWYsRqiCjVVdbNVJ3XuTxTgMQFho1fzJs17 | pass | VERDICT: CONFIRMED |
| 8 | verify rule B after rule A revoked | 52L8fKX47garZ3Et8HMSKB4NtcScXZ3CXMCGyfnJ7zmiszzBUEvQ3LdTtMgxjWx3MWS9ez6uxmskojW4xZ5YWhE3 | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule B decisions |  | pass | 2 records CONFIRMED |
| 9 | close rule B | 2nuxssuhdZ1HkmbmfRUQeHCefCddRR8ZWdJhLgjxUdKTT1LWPPnm3ZNC2yrCjR5ccMLbxYL8D8ayDZeVUVgkUATL | pass | returned 1650000 USDC base units and 16311880 SOL lamports, fee 5000 SOL lamports |
| cleanup | return remaining tokens to funder and SOL to deployer | 4DXrNFotmdDkxru2Va7YH1PYofVEfp29Eoe82VcsaF9MtZsRQxRs9KRPpc9erJyPLXKg2JtoT1rNmQxHLMETYQD3 | pass | returned 2250000 USDC base units to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1, 399970000 owner SOL lamports, 49970000 agent SOL lamports, 1488440 token-account SOL lamports, to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
