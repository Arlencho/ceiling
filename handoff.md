# Handoff

## Built

Closed the round 2 review on PR 70 (`docs/deck-refresh`). The quoted refusal is
no longer the `tools/produce.ts` fixture (180 over 60, remaining 450). It is the
live 18:00 SE3 decision the README already links:

```
Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

Signature:
`3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib`

Hero slide, cold open card, explorer log, README example, and verify reject
output all describe that one decision. Dependent figures are derived from it,
not carried over from the fixture.

Files:

- `docs/DECK.md`
- `docs/VIDEO.md`
- `README.md`

No eleventh slide. No program source change. No app source change. No test
change.

## Decisions

The plan picked the live watcher rule, not the fixture. Cap 100, per-payment
maximum 0.5. Amount 6.2325 (6232500). Remaining 99.3395 (99339500) after the
00:00 and 06:00 payments that landed before this refusal. Override 6.2325
(6232500), because 6232500 > 500000 and 6232500 <= 99339500.

Phone copy from `refusalWhyLine` / `formatBaseUnits` at 6 decimals:

```
Asked for 6.2325, over the 0.5 per-payment maximum. An override of 6.2325 would have cleared it.
```

Cold open moved off Overview. Overview is today only. The quoted row is
20 September.

Verify against public devnet, amount tampered to 1, while the ring still holds
the row:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 6232500
- amount (ledger): record has 1, chain has 6232500
```

The genuine file prints `Mandate limits, ledger entry, and charge transaction agree.`

## Do not repeat

- Do not quote 180 over 60, remaining 450, or `chain has 180000000` in the deck,
  the video, or the README. That is the produce.ts fixture, a different rule.
- Do not put the quoted card on Overview on recording day. Overview is today.
- Do not invent a live "mandate not active" explorer line. None is recorded on
  this rule yet. The revoke beat is a recording-day action on this same rule.
- Do not add an eleventh slide.
- Do not restyle a refusal as an error.
- Do not touch code or tests this round. The round 1 tests still lock a
  180-over-60 emit path. That path is real and is no longer the quoted decision.

## Evidence

Live tx (err null, token balances unchanged):

```
Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

Sibling paid log on the same rule:

```
Program log: VETO PAID amount=214500 spent=660500 of cap=100000000 remaining=99339500
```

Export plus verify of that signature against `https://api.devnet.solana.com`:
`kind=refused amount=6232500 per_tx_max=500000 cap=100000000 suggested_override=6232500`
purpose `SE3 home charging`. Genuine verify CONFIRMED. Tamper amount to 1:
both instruction and ledger lines name `chain has 6232500`.

## Open questions

Issue 20 stays open for QA.

`docs/PLAN.md` still says an override of 120 would clear a 180-over-60 charge.
That cannot happen. Left it: not on the deck, the video, or the README.

The 12:00 payment in the README table landed after the 18:00 refusal
(blockTime 1789938050 vs 1789937892). Remaining 99339500 excludes it. The
quoted remaining is what the program logged.

If the 32-entry ring wraps past 20 September by recording day, the phone will
not still show that row. Explorer and verify do not need the ring.

## Next hint

PR 70 against `main` on `docs/deck-refresh`. Leave issue 20 open.
