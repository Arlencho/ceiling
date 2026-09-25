# Compute units per decision


LiteSVM 0.10 single-threaded compute units per decision. Cost per instruction, not throughput.
mandates=5000 charges_per_mandate=40 total_charges=200000 unexpected_outcomes=0

| instruction   | kind    | reason                   | count | min CU | p50 CU | p95 CU | max CU | mean CU |
| ------------- | ------- | ------------------------ | ----- | ------ | ------ | ------ | ------ | ------- |
| open_mandate  | opened  | ok                       | 5000 | 23074 | 26074 | 32074 | 47074 | 26081.5 |
| charge        | paid    | ok                       | 100000 | 20156 | 20186 | 26162 | 44165 | 21650.8 |
| charge        | refused | over per-payment maximum | 100000 | 12392 | 12417 | 18392 | 36396 | 13881.7 |

CU is the transaction total reported by LiteSVM. Within one kind the spread is the PDA bump search (1500 CU per searched bump), not state size: the min column is a mandate whose bumps resolved on the first try.
veto-only consumed (veto line minus the SPL token CPI line): paid p50 13906 CU, refused p50 12417 CU

ring wrap (capacity 32, paired per mandate):
  paid    mean per-mandate delta (after wrap minus before wrap) -0.94 CU over 5000 mandates, largest |delta| 0.94 CU
  refused mean per-mandate delta (after wrap minus before wrap) -3.20 CU over 5000 mandates, largest |delta| 3.20 CU
  ring wrap does not change compute units

devnet cross-check (veto-only CU against the devnet figures):
  paid    LiteSVM veto-only p50 13906 CU, devnet 14011 CU, delta -105
  refused LiteSVM veto-only p50 12417 CU, devnet 12417 CU, delta +0
  (transaction totals, SPL token CPI included: paid p50 20186 CU, refused p50 12417 CU)

run wall time 38.0s (setup plus measurement, informational only)
