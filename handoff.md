# Handoff

## Built

Aligned `docs/DECK.md`, `docs/VIDEO.md`, and `docs/PITCH.md` with the shipped app. Nothing else.

Three gaps only:

1. Product copy now says **rule** and **decision** wherever it used to say mandate and ledger. **mandate** remains for AP2 / prior art, and for quoted chain or tool text (`mandate not active`, `tools/verify.ts` "Mandate limits, ledger entry, and charge transaction agree.").
2. Scope (slide 10 and the matching pitch Q&A) states what the product does now: one rule type, delegate not vault, several rules one agent each, a ruleset written once and applied to the next agent, one pay path, one refusal path with a reason and an override hint, export, a real week of history.
3. Fleet folded into existing slides. No eleventh slide.

Screenshots named in the deck still exist: refusal card (Overview / Decisions), explorer log, Decisions with multi-day history. Shot list uses Overview, the rule (from Rules), Decisions, Revoke this rule.

## Decisions

Fleet teaching lives on **slide 3** (two lines: one human, several agents, one rule each; a ruleset written once and reused on the next agent). That slide defines the object, so cardinality belongs there rather than as a late footnote.

The same facts are **named** on **slide 10** as shipped inventory, not taught again. Scope had to stop saying the product is a single mandate with no multi-rule management.

Not on slide 7: Seed Vault is the only non-interchangeable why-here, and fleet would crowd it.
Not on slide 8: the real week is one charging agent against a feed.
Not a new slide: supporting material, two lines.

Video revoke voice matches the rule screen: nothing already paid changes. It no longer says the money never moved.

## Do not repeat

- Do not add an eleventh slide.
- Do not rename AP2 mandates or the prior-art table.
- Do not move the record story off slide 9 / the last thirty seconds.
- Do not claim an in-app grant of override. The card shows a hint. Grant is not on this main.
- Do not claim the ruleset file is on chain. Only name and version are stamped into purpose.
- Do not restyle a refusal as an error in the deck or the edit.
- Do not invent screenshot names. Tabs are Overview, Rules, Decisions.
- `handoff.md` is the previous fleet-console note overwritten by this beat.

## Evidence

Screens read:

```
test -f app/app/\(tabs\)/index.tsx app/app/\(tabs\)/rules.tsx app/app/\(tabs\)/decisions.tsx \
  app/app/rule/\[address\].tsx app/components/RefusalCard.tsx tools/verify.ts
```

All exist.

Refusal card copy from `app/components/RefusalCard.tsx`: "Your rule held. No payment made." plus `refusalWhyLine` in `app/lib/reasons.ts`.

Rule fields from `app/app/rule/[address].tsx`: Total cap; Per payment, max; Expires; Payee. Button: Revoke this rule.

Reason text from `app/lib/constants.ts`: `mandate not active`.

Verify success line from `tools/verify.ts`: `Mandate limits, ledger entry, and charge transaction agree.`

Relative links: `docs/VIDEO.md` -> `PITCH.md`, `docs/PITCH.md` -> `PROBLEM.md` and `PLAN.md`. All resolve.

No em dash, en dash, horizontal bar, or spaced double hyphen used as a dash in the three files.

Ten numbered slides. No slide 11.

## Open questions

Issue 20 stays open for QA. Confirm the three screenshots still match once the watcher has a real week on the Decisions tab.

## Next hint

PR against `main` on `docs/deck-refresh`, referencing issue 20. Leave 20 open for QA.
