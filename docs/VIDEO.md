# The three-minute video

Completion is judged from this, and the brief is explicit that it has to run on a device: a video
nobody can install is not a submission. Shot list written 2026-09-20 so the recording day is a
recording day, not a writing day. Aligned 2026-09-21 to the shipped screens: Overview, Rules,
Decisions. The quoted refusal is the 18:00 SE3 decision the README already links. The card
opens from Decisions, not Overview. Overview is today only.

Two phones on a desk, both visibly phones. Screen recording alone is weaker: a judge is scoring a
mobile product and needs to see hardware.

## What must be true before recording

- Program on **devnet**, not a local validator. Every explorer link in this video has to open on a
  judge's laptop, and nobody can click localhost.
- The watcher has been running for days, so the Decisions screen is a diary rather than three rows
  made that morning. This is the only item that cannot be fixed on the day.
- Both Seekers have the release APK installed, not a dev client.
- One charging rule throughout: cap 100, per-payment maximum 0.5. That is the watcher rule behind
  the 18:00 SE3 refusal the README already links. Do not open a second rule for the demo.
- The explorer shot and the verify shot are that recorded refusal, not a new charge. Signature:
  `3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib`.
- The on-chain ring holds 32 entries. If it has wrapped past 20 September by recording day, the
  phone will not still show that row. Explorer and verify do not need the ring. Do not replace
  the quoted card, log, or verify line with a different decision.
- For the yes beat, a payment under this same 0.5 maximum: either a cheap-window row already on
  the diary, or a live in-limit charge the merchant terminal can trigger on demand. Do not stage
  an over-ceiling amount on a different rule.

## Shot list

**00:00 to 00:12. Cold open on the refusal.**

No logo, no title card, no team slide. The refusal card for the 18:00 SE3 decision the
[README](../README.md) already links. If that row is still on the ring, open it from Decisions
(the evening refused row on 20 September). Overview is today only, so on recording day that row
is not there. If the ring has wrapped, hold a still of this same card copy. Do not quote a
different amount.

The card, as the app renders this decision:

> Your rule held.
> No payment made.
> Asked for 6.2325, over the 0.5 per-payment maximum. An override of 6.2325 would have cleared it.

Voice: *"This agent just decided not to spend your money. That decision is on chain, and that is
the product."*

**00:12 to 00:35. What a rule is.**

The same charging rule, opened from the Rules tab. Point at the four fields as they are named on
that screen, with the numbers this rule actually holds: Total cap 100; Per payment, max 0.5;
Expires; Payee.

Voice: *"You write a rule once. One human, several agents, one rule each. A ruleset written once
is reused on the next agent. The key never leaves Seed Vault. The agent gets authority, never
ownership, and it cannot widen any of these."*

**00:35 to 01:00. The yes.**

A payment under this same rule, under the 0.5 per-payment maximum, at a real cheap-window
electricity price. The 06:00 row on this rule paid 0.2145. Agent phone: no tap, no prompt.
Paid. Both screens agree.

Voice: *"Inside the box it just pays. Nobody approved that."*

**01:00 to 01:35. The no, and the explorer.**

Cut back to the same 18:00 refusal the video opened on. Same agent, same rule, no tap. The evening
window priced 50 kWh at 0.12465 SEK/kWh, which is 6.2325, over the 0.5 per-payment maximum. The
phone already said why, with the override that would have cleared it.

Then cut to a laptop, open that transaction in the explorer (the signature in the README), and
read the log line on screen:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500
per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

Remaining 99339500 is 99.3395 of the 100 cap, after the two cheap payments that landed before
this refusal. Override 6232500 is the amount, because 6.2325 is over 0.5 and still under the
remaining cap.

Voice: *"The transaction confirmed and the balance did not move. It succeeded at deciding no.
Every other design stops this too, and then leaves nothing behind: no reason, no trail, nothing an
auditor could look at. This one leaves a record."*

This is the shot the entry lives or dies on. Rehearse it most.

**01:35 to 02:00. A real week.**

Decisions screen, scroll a multi-day history under this same charging rule. Stop on a paid row at
a cheap night price and the refused evening spike the video already opened on.

Voice: *"The agent has been running for days against a public electricity price feed. It paid when
power was cheap and refused when the evening price spiked. The price is real and you can check it
at the same URL we do. The merchant terminal is ours, because no charge point takes USDC, and we
say so."*

Say the honesty boundary out loud. It turns the obvious objection into a credibility moment.

**02:00 to 02:20. Take one off the phone.**

Export that same 18:00 refusal to JSON on the laptop (`export.ts --signature` of the README
transaction), run verify against public devnet, and let the output land:

```
Mandate limits, ledger entry, and charge transaction agree.
```

That sentence is what `tools/verify.ts` prints. It still uses the on-chain names.

Then change the amount in the file to 1 and run it again. While the ring still holds this
row, verify prints both of these lines:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 6232500
- amount (ledger): record has 1, chain has 6232500
```

Voice: *"A refusal is portable. Anyone can check it against the chain, and a record that was
tampered with fails."*

**02:20 to 02:35. Revoke.**

The same charging rule. One tap on Revoke this rule, one Seed Vault signature. The agent's next
charge is refused with the recorded reason "mandate not active", and that refusal lands on
Decisions too.

There is no already-recorded "mandate not active" decision on this rule to quote. This beat
is a live action on recording day, on this rule, not a different rule.

Voice: *"Authority ends when you say it ends. Nothing already paid changes. The next charge is
refused, and that refusal is recorded too."*

**02:35 to 03:00. Close.**

Voice: *"Limits on chain already exist. Squads, AP2, session keys. Every one of them stops the
overspend, and so does this. The difference is that everywhere else the block is a failed
transaction that leaves nothing behind. Here the no is recorded, with the reason and the override
that would have cleared it. AP2 standardised the record of a yes. This is the missing half."*

Last frame: the refusal card. Same 6.2325-over-0.5 card the video opened on.

## Rules for the edit

- **A refusal is never styled as an error.** Not in the app, not in the edit, no red flash, no
  error sound. It is the product working.
- **No claim the repo does not make.** No "first ever", no "credential", no "proof of restraint"
  unqualified. The banned list is in [PITCH.md](PITCH.md).
- Real device, visible. No simulator frames.
- Under three minutes, hard.
- No background music under the explorer shot; let the log line be read.

## The reshoot budget

Record Oct 6, keep Oct 7 free. The refusal path is the one that must never fail on camera, so shoot
it first while everything is fresh, and shoot it twice.
