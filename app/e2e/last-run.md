# Devnet journey

Run started: 2026-09-25T07:24:21.561Z
RPC: https://api.devnet.solana.com
Program: 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
Mint: 2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU
Owner: HriFUaFXSReaswuAF3JPuMgKBbXAWy1R6CMZqPEPffmb
Agent: FiC3afxuufs9Sy8gdg1gfoufdvQQ1y5QsSoAYMrTcGt1
Merchant: 6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG
Rule A: 4cUDMXVzBSWybyreZ9VwxAe8LZek5ftXf8DTV35SchQM
Rule B: 2BkVnqAW4Wr8TLjqParVnqKYzPtBrFbDfWwXtzceYSuk

| Step | Action | Signature | Result | Detail |
| --- | --- | --- | --- | --- |
| setup | fund owner and agent from deployer | 223xkC51tnESJA5EY4SZ59NQzwQtkC3LEMC7z6xELnt4kwtc26ZmDg7Cot8g49vFqCcD2EDGR5NPDiKDUTQTa56g | pass | owner HriFUaFXSReaswuAF3JPuMgKBbXAWy1R6CMZqPEPffmb agent FiC3afxuufs9Sy8gdg1gfoufdvQQ1y5QsSoAYMrTcGt1 |
| 1 | open rule A | 44FQyoVF3jzvJYFa5GP3mEQDr9Qpt8uCbRJiYyNKkzeMELbg3s1Dzk6wXQaqpjRtSiFEGiJutMpMLZR1TKJ8Hwwe | pass | 4cUDMXVzBSWybyreZ9VwxAe8LZek5ftXf8DTV35SchQM |
| 1 | open rule B | MKMdf3bRjtFPbxwUQzvngnWA8bQW62pAqyBTkp2rLrpUaMkjgUdHB2BnWPniP5bv7C1wHQ3USLWCvQ4JAohuLFF | pass | 2BkVnqAW4Wr8TLjqParVnqKYzPtBrFbDfWwXtzceYSuk |
| 2 | agent pays within rule A limit | hgpdW7aDcdsnDhnZdGnFwHdFCaY26EoxhpHT6qgmpSeTBHaWDawm2gznqhCs2hTAu22Yo7e4kbSrhacYiHnnNoM | pass | paid 100000 nonce 1 |
| 3 | agent asks above rule A per-payment limit | 4R4M6MEKVB1pSqzrjkejKcyLMyBuWLCJ7mmVWkptzJcFftbNPFj7pwP4NPUCtSHdhjv78bCCFnuM3jgSmr9BQcCh | pass | refused 300000 nonce 2 override 300000 |
| 4 | owner grants the recorded override | 3KzibR5CvtJipDMfLhSsb2JUHPHRKdaXkNWCubLLcoeLp6enhfkWLuEZ6EMLEJtmvYT9aVbTfqJTMJsfQowYi28t | pass | override 300000 nonce 2 |
| 4 | agent retries the overridden charge | 22kRxZW1WL1mTdBmta1eeyXpVtwURQ4KTkZqHZEZd22gRJtwFYQJp2zdefBcBpX8f64VHndS7i9xMDPJNCxBYnoq | pass | paid 300000 nonce 2 |
| 5 | agent pays under rule B | 5utLc9QBmxbfAnSy3X7b5eBaoefNi56Fhi976QUbfSUA46oMe75t3o3KMCGWswMySZk8pWCJQcE6QGDsv5bX4QWW | pass | paid 150000 nonce 1 |
| 6 | revoke rule A | 2TXw7yuZn6rpXFHSaLYvckxc28r7pYWim23X7wTrrHEkEYZN98pCJ2bAXQq17uMDSLnY3BD4WpeDakmzt3Mru3vL | pass | rule A revoked, delegate cleared |
| 6 | agent charges revoked rule A | 2UHnW4EXP87zaFaGHfjpyUXDsefoocWKiY4pR4wsLDCuCmtdsE6iDP2q5X1BstZnHpZbnUsGk3jYAuy8Xavu5eRe | pass | refused 100000 nonce 3 reason 1 |
| 6 | agent pays under rule B after rule A is revoked | 9k6Ju9UGuTG8ShFm4EGrimUtcLsuEebpVCRxmgJZkV7HEXbeAcMEoihLMfMXrTDDnck7yGYFb65daYPDzodKG9G | pass | paid 200000 nonce 2 |
| 8 | verify rule A within limit | hgpdW7aDcdsnDhnZdGnFwHdFCaY26EoxhpHT6qgmpSeTBHaWDawm2gznqhCs2hTAu22Yo7e4kbSrhacYiHnnNoM | pass | VERDICT: CONFIRMED |
| 8 | verify rule A over per-payment limit | 4R4M6MEKVB1pSqzrjkejKcyLMyBuWLCJ7mmVWkptzJcFftbNPFj7pwP4NPUCtSHdhjv78bCCFnuM3jgSmr9BQcCh | pass | VERDICT: CONFIRMED |
| 8 | verify rule A retry after override | 22kRxZW1WL1mTdBmta1eeyXpVtwURQ4KTkZqHZEZd22gRJtwFYQJp2zdefBcBpX8f64VHndS7i9xMDPJNCxBYnoq | pass | VERDICT: CONFIRMED |
| 8 | verify rule A after revoke | 2UHnW4EXP87zaFaGHfjpyUXDsefoocWKiY4pR4wsLDCuCmtdsE6iDP2q5X1BstZnHpZbnUsGk3jYAuy8Xavu5eRe | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule A decisions |  | pass | 4 records CONFIRMED |
| 8 | tamper one amount and verify again | hgpdW7aDcdsnDhnZdGnFwHdFCaY26EoxhpHT6qgmpSeTBHaWDawm2gznqhCs2hTAu22Yo7e4kbSrhacYiHnnNoM | pass | VERDICT: REJECTED |
| 7 | close rule A | 3s94mdrsfdupFFT9iXa8DxCkGmmfozDTqh2qHbFRo6LqFkhufrfxW3AQP7ThjijqvzB8XRGR6D1u4nXoFbN26746 | pass | returned 600000 tokens and 16311880 lamports, fee 5000 |
| 8 | verify rule B within limit | 5utLc9QBmxbfAnSy3X7b5eBaoefNi56Fhi976QUbfSUA46oMe75t3o3KMCGWswMySZk8pWCJQcE6QGDsv5bX4QWW | pass | VERDICT: CONFIRMED |
| 8 | verify rule B after rule A revoked | 9k6Ju9UGuTG8ShFm4EGrimUtcLsuEebpVCRxmgJZkV7HEXbeAcMEoihLMfMXrTDDnck7yGYFb65daYPDzodKG9G | pass | VERDICT: CONFIRMED |
| 8 | export and verify rule B decisions |  | pass | 2 records CONFIRMED |
| 9 | close rule B | 3pJmDDtTuBj7qpL3vMByBzykjXxJ7r9a4S3XLpdEbfXkqeN99JGPHrXWnHSyGgcrkGu3YshXhauJgZ7EzYYiDdXY | pass | returned 1650000 tokens and 16311880 lamports, fee 5000 |
| cleanup | return remaining SOL and tokens to deployer | 398Qqa8fC7QmxpSSSAvdzpaKwhqS5tAN2zghEgSywQLs6LR2oEwVg79WJGefejRK5heWPAxNbiQtfmDGLs2a6VjR | pass | returned 4250000 tokens, 399970000 owner lamports, 49970000 agent lamports, 1488440 token-account lamports, to GYus8c91vyc7XDrgqfDaYcmVTERb4hQWcf6fLr2SyR1 |
