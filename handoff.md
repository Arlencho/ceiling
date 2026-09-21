# Handoff

## Built

Closed the PR 70 review on `docs/deck-refresh`. The quoted refusal log was
arithmetically impossible: amount 180 exceeded remaining 158, so
`suggested_override` is 0 and the phone says no override would have cleared
it. The slide wants a charge over the per-payment maximum that an override
can still clear. That is 180 over 60 after 50 already paid against a 500
cap (remaining 450). Same figures in the deck, the video, the README, and
the phone copy.

Files:

- `docs/DECK.md`
- `docs/VIDEO.md`
- `README.md`
- `programs/veto/tests/refusal_is_recorded.rs` (test that prints the line)
- `app/lib/reasons.test.ts` (test that prints the phone copy)

No eleventh slide. No program source change. No app source change.

## Decisions

Keep the 180-over-60 scenario. Fix remaining, do not invent a new story.

`suggested_override` is `amount` when reason is over per-payment maximum
and `amount <= remaining`. Otherwise 0. Evaluate reports over per-payment
maximum first, so a charge that also exceeds remaining still gets reason 5
and override 0.

Figures from `tools/produce.ts` / `docs/DECISION_RECORD.md`: cap 500,
per_tx_max 60, paid 50, refuse 180. Remaining 450. Override 180.

VIDEO verify reject output now has the blank line `tools/verify.ts` prints
between `VERDICT: REJECTED` and the field line.

## Do not repeat

- Do not quote remaining 158 with override_to_clear 180. The program will
  not emit that.
- Do not quote an override of 120 for a 180 charge. The suggestion is the
  amount, not amount minus per_tx_max. That line is still in `docs/PLAN.md`.
- Do not add an eleventh slide.
- Do not restyle a refusal as an error.
- Do not claim an in-app grant of override.

## Evidence

Program log, from LiteSVM:

```
cargo test --manifest-path programs/veto/Cargo.toml --test refusal_is_recorded -- --nocapture the_quoted_refusal_log
```

```
Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=180000000 per_tx_max=60000000 remaining=450000000 override_to_clear=180000000
test the_quoted_refusal_log_is_over_per_payment_max_and_an_override_still_clears_it ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out
```

Whole `refusal_is_recorded` file: 5 passed.

Phone copy:

```
cd app && npx tsx --test lib/reasons.test.ts
```

```
the quoted refusal card is 180 over 60 with an override that would have cleared it
Asked for 180, over the 60 per-payment maximum. An override of 180 would have cleared it.
tests 7, pass 7
```

Live README explorer refusal (a different decision, same kind) is real:

```
Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

SE3 prices for 2026-09-20 match the table. 0.12465 * 50 kWh = 6.2325.

## Open questions

Issue 20 stays open for QA.

`docs/PLAN.md` still says an override of 120 would clear a 180-over-60
charge. That cannot happen. Left it, because this beat was the quoted line
on the deck, the video, and the README.

The live 18:00 refusal remaining is 99339500 because the 12:00 payment
landed after it (blockTime 1789938050 vs 1789937892). The table is labeled
by feed windows, not submit order. The quoted remaining is what the
program logged.

## Next hint

PR 70 against `main` on `docs/deck-refresh`. Paste the cargo test output
in the PR. Leave issue 20 open.
