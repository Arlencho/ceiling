# Devnet journey

Run started: 2026-09-24T00:25:27.366Z
RPC: https://api.devnet.solana.com
Program: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Mint: 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU
Owner: 3NaYWpfiMYh8Zhic6rFceXX4ntpSXN5A3SXvrLP5RSJd
Agent: HvUn78F1Sxa1QvfEQD7gpYM28NkkMtKfWxhqroqcQptD
Merchant: 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
Rule A: AL7uNcQvFbvttwoaHmo23B4AiFi2FvNm963egKuFuU5q
Rule B: DZfGPL68NPhupMkM67wa4P57dpsiMY45unwv1DPmurzS

| Step | Action | Signature | Result | Detail |
| --- | --- | --- | --- | --- |
| setup | fund owner and agent from deployer | 2nQ2KbCr7WNq5NmHTyGAeQbDmhRLiLgcnAwrALR83v9f59SLqoJPkzCGPqT9x1zKCsmhguBvLkwudMdSyvhsbuEF | pass | owner 3NaYWpfiMYh8Zhic6rFceXX4ntpSXN5A3SXvrLP5RSJd agent HvUn78F1Sxa1QvfEQD7gpYM28NkkMtKfWxhqroqcQptD |
| 1 | open rule A | qTZgcU7vx1sm1ytJ5bUhHKWyw3nqHSuPreDcxfgczaD1EfStXv8kHtHWA9m3VLwwSdd2C6NtZQFuTtHRkeVcz9T | pass | AL7uNcQvFbvttwoaHmo23B4AiFi2FvNm963egKuFuU5q |
| 1 | open rule B | 5BsTtxPzu81974F84fDiPHGog4JvebvTmdGjigffD5rfCf9NYqkMQYhhXBMPVvppBG5xBaqPFvdzd4mqNCEQWkxq | pass | DZfGPL68NPhupMkM67wa4P57dpsiMY45unwv1DPmurzS |
| 2 | agent pays within rule A limit | 2Ne7ax7qp1i4JN1U2N3J7HqWNwPJpPdXBaBJfu2MMbjRuat4VR4PLHyjkkh2owJ6LtvgDADbXEAEw3KX4sYtchG1 | pass | paid 100000 nonce 1 |
| 3 | agent asks above rule A per-payment limit | EfxjSUs2Z9sVpztPnXF54rVa4jG8QEkvBxFBadTwvSWpXAMkJFbixdK5ztHJrPoR1U9rk1Y3Myvp6uAYe34crsd | pass | refused 300000 nonce 2 override 300000 |
| 4 | owner grants the recorded override | 2oq87KSaz796KHTExK8jKd2QpVPaS6Mi16FRzXeqSJSUMYpraQ7gAMycwQn6AFcGY2BQnQYhLjPSfiUdMiJataBy | pass | override 300000 nonce 2 |
| 4 | agent retries the overridden charge | 2WoUQv34J594m7VKAPMjqPfehQujhi11b6udCGdYHQhiSbkqfxiXrWYnBzVvYQHDGF7eVrFv1hHBcXRS2VpXWYZi | pass | paid 300000 nonce 2 |
| 5 | agent pays under rule B | 3wP6FgEWJexf7KwkXSN2nx2iaMw77pVfGrjbwrmVNNTRVygfqgCNw7VwfLo1wfooWWfVipTPGLypxxsK1NDnpwVo | pass | paid 150000 nonce 1 |
| 6 | revoke rule A | 2kKuBofRV6tk1XA6uiiGCyaiRSS8VcaMm2WEfEUvThzsNszU2pE8QL23xfUJFo6Cn6f6FQQbafGeNGj8Jp2tXwWa | pass | rule A revoked, delegate cleared |
| 6 | agent pays under rule B after rule A is revoked | 4gR9RZbjPpK2oefvBVetU9DWs4jrHh9mgkFxzkRYNUV9ijd4C336rCjAaddFm2tzcb3iNEXJrbgYGdpsZj2voZqE | pass | paid 200000 nonce 2 |
| 7 | close rule A | 2Kqy6DtokyzCFSdKusWr4hppe4tBZeHLJxd9e3xUsmjy7NNy61dUXFbGwC9dmWYJo6MSH6SrR2PZzFhbsSzHQNxi | pass | returned 600000 tokens and 16311880 lamports, fee 5000 |
| 8 | export and verify every decision |  | fail | export rule A within limit failed: (node:32069) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set. (Use `node --trace-warnings ...` to show where the warning was created) (node:32104) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set. (Use `node --trace-warnings ...` to show where the warning was created) (node:32105) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set. (Use `node --trace-warnings ...` to show where the warning was created) export failed: mandate account not found: AL7uNcQvFbvttwoaHmo23B4AiFi2FvNm963egKuFuU5q |
