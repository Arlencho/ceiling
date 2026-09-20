# The three-minute video

Completion is judged from this, and the brief is explicit that it has to run on a device: a video
nobody can install is not a submission. Shot list written 2026-09-20 so the recording day is a
recording day, not a writing day.

Two phones on a desk, both visibly phones. Screen recording alone is weaker: a judge is scoring a
mobile product and needs to see hardware.

## What must be true before recording

- Program on **devnet**, not a local validator. Every explorer link in this video has to open on a
  judge's laptop, and nobody can click localhost.
- The watcher has been running for days, so the ledger is a diary rather than three rows made that
  morning. This is the only item that cannot be fixed on the day.
- Both Seekers have the release APK installed, not a dev client.
- A charge is due within the recording window, or the merchant terminal can trigger one on demand.

## Shot list

**00:00 to 00:12. Cold open on the refusal.**

No logo, no title card, no team slide. The agent screen, a refusal card already on it:

> 180 USDC to the charge point. Over your 60 per-payment limit. Not paid.

Voice: *"This agent just decided not to spend your money. That decision is on chain, and that is
the product."*

**00:12 to 00:35. What a mandate is.**

Mandate screen. Point at the four numbers as they are named: a total cap, a largest single payment,
an expiry, one allowed merchant.

Voice: *"You write it once. The key never leaves Seed Vault. The agent gets authority, never
ownership, and it cannot widen any of these."*

**00:35 to 01:00. The yes.**

Merchant phone asks for a payment at the current real electricity price. Agent phone: no tap, no
prompt. Paid. Both screens agree.

Voice: *"Inside the box it just pays. Nobody approved that."*

**01:00 to 01:35. The no, and the explorer.**

Merchant asks for an amount over the ceiling. Same agent, same mandate, no tap. It declines and
says why in one line, with the override that would have cleared it.

Then cut to a laptop, open the transaction in the explorer, and read the log line on screen:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=180000000
per_tx_max=60000000 remaining=158000000 override_to_clear=180000000
```

Voice: *"The transaction confirmed and the balance did not move. It succeeded at deciding no.
Every other design stops this too, and then leaves nothing behind: no reason, no trail, nothing an
auditor could look at. This one leaves a record."*

This is the shot the entry lives or dies on. Rehearse it most.

**01:35 to 02:00. A real week.**

Ledger screen, scroll a multi-day history. Stop on a paid row at a cheap night price and a refused
row at an evening spike.

Voice: *"The agent has been running for days against a public electricity price feed. It paid when
power was cheap and refused when the evening price spiked. The price is real and you can check it
at the same URL we do. The merchant terminal is ours, because no charge point takes USDC, and we
say so."*

Say the honesty boundary out loud. It turns the obvious objection into a credibility moment.

**02:00 to 02:20. Take one off the phone.**

Export a refusal to JSON on the laptop, run verify against devnet, and let the output land:

```
Mandate limits, ledger entry, and charge transaction agree.
```

Then change one number in the file and run it again:

```
VERDICT: REJECTED
- amount (instruction): record has 1, chain has 180000000
```

Voice: *"A refusal is portable. Anyone can check it against the chain, and a record that was
tampered with fails."*

**02:20 to 02:35. Revoke.**

One tap, one Seed Vault signature. The agent's next charge is refused with "mandate not active",
and that refusal lands on the ledger too.

Voice: *"Authority ends when you say it ends. The money never moved and never was going to."*

**02:35 to 03:00. Close.**

Voice: *"Limits on chain already exist. Squads, AP2, session keys. Every one of them stops the
overspend, and so does this. The difference is that everywhere else the block is a failed
transaction that leaves nothing behind. Here the no is recorded, with the reason and the override
that would have cleared it. AP2 standardised the record of a yes. This is the missing half."*

Last frame: the refusal card. Same image the video opened on.

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
