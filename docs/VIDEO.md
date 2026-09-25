# The three-minute video

Shot list for the submission video. Every beat below is what the current app and program do on the quoted rule. Completion is judged from this, and the brief is explicit that it has to run on a device: a video nobody can install is not a submission. The app's tabs are Overview, Rules, Agents, and Decisions. This shot list uses Overview, Rules, and Decisions. The quoted refusal is the 12:00 slot on 2026-09-25, Swedish time, on mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`, confirmed at 2026-09-25 10:00:25 UTC. The card opens from Decisions, not Overview. Overview's latest decisions are today only. Hold is live on devnet. The app screens exist, and a device check with a real vault follows. This shot list stays on the quoted spending rule.

Two phones on a desk, both visibly phones. Both stay in frame.

The demo pays a bill repriced by a public index, on Solana devnet, in our token, to our counterparty. It buys no electricity.

## What must be true before recording

- Program on **devnet**, not a local validator. Every explorer link in this video has to open on a judge's laptop, and nobody can click localhost.
- The narration says what the payment is: a bill repriced by a public price index, unattended, against the on-chain rule. Solana devnet, our token, our counterparty. The price is the only input we do not control. It buys no electricity. The mint and the counterparty account come from [scripts/devnet-setup.sh](../scripts/devnet-setup.sh). [tools/produce.ts](../tools/produce.ts) mints further supply of that same mint. When the rule allows the bill, the program executes an SPL transfer of that token to the account we created.
- The quoted rule is mandate `3hgrSbPX2VTrfnVekoL2qi2qDWNGBhWP3QgADAWz6X6N`. Purpose "Charging top-ups at the SE3 spot rate". Cap 300. At most 10 per payment. Payee `6i99pFwsoV9wBWSaNtXxpXgCWjpCkMbZ4UE6T4cSPdCG` (the screen truncates that to 6i99...PdCG). It was opened for 90 days. The open confirmed at 2026-09-24 22:48:44 UTC, and `expires_at` is 1798066105, which is 7775981 seconds later, nineteen seconds under 90 times 86400, because the block landed after the signed timestamp. The open is not listed on Decisions.
- Before 18:00 Swedish time on 2026-09-25 the chain shows one payment and four refusals. The payment is 8, nonce 1, confirmed at 2026-09-24 23:10:46 UTC. One refusal is 14, nonce 2, in that same second. Those two nonces are not SE3 window starts. The other three refusals are 12.5 kWh at the public SE3 price for the window: 00:00 Swedish at 1.35519 SEK/kWh is 16.939875, 06:00 at 1.21222 is 15.15275, and 12:00 at 1.33277 is 16.659625.
- The demo is set so that from 18:00 Swedish time on 2026-09-25 the watcher charges 6 kWh per slot. A 6 kWh bill can fall under the 10 ceiling or over it, which is how later history is meant to mix paid and refused. This shot list has not read those later rows. The quoted card stays the 12:00 refusal even if later rows are on the phone by recording day.
- That rule's source is token account `23gnGjWJMskzuFgdGs8atieGojf9oGGkF4LSfa8MaN2g`, derived from owner `GtA2Vxhomfm2WGaBcvz5oCBrqkAecKHMAL3UTn4HVFzq` with seed `veto-rule-1790290106235`. Read before 18:00 Swedish time on 2026-09-25, the delegate on that account is this mandate, for the remaining 292. A bill over the per-payment maximum is reason 5. A bill inside the limits pays while this mandate remains the delegate. The recorded rows stay readable.
- The explorer shot and the verify shot are that recorded 12:00 refusal, not a new charge. Signature: `2DAXYtVCkGPG8RdbYWJcJvZHk4F7tvkJCnqExuyg8qUrdK53DwNUBiCD1MBx3LrzHvd8YXVF7RXr5tz4EujfHo5B`. Ledger `8oMAegKZ8ySedJSqdA1GQrfxxSvU8mwvwqDEtocGEWnB` held this row before 18:00 that day (six entries written, ring capacity 32).
- The on-chain ring holds 32 entries. The agent can push a paid row out of that window with later charges. If the quoted row is no longer on the ring, the phone will not still show it. Explorer and verify do not need the ring for the log. Do not replace the quoted card, log, or verify line with a different decision.
- Decisions stamps each row with the time the decision was recorded, not the SE3 price window it priced. The 00:00 Swedish window was written at 2026-09-25 00:07:37 UTC, which is 02:07 Swedish time, so that clock is not the window. The 12:00 window was written at 10:00:25 UTC, which is 12:00:25 Swedish time. The list rounds 16.659625 to 16.66. The opened screen shows 16.659625. Find the row by that amount.
- The yes beat is the recorded paid row of 8 on this rule. The merchant terminal serves a quote and a page. It does not submit `charge`. A live charge is the watcher's `once --window`, or `sdk/examples/pay-once.ts`. On this rule that charge is reason 5 when the bill is over the per-payment maximum. It pays when the bill is inside the limits and this mandate is still the delegate.
- Revoke and a following payment are shot on rules that each have their own token account (`veto-rule-<mandate id>`), not on the quoted rule. `revoke_mandate` clears the delegate on that rule's source. The 16.659625 card stays the card the video opened on.

## Shot list

**00:00 to 00:12. Cold open on the refusal.**

No logo, no title card, no team slide. The refusal for the 12:00 Swedish decision. If that row is still on the ring, open it from Decisions (the refused row of 16.659625 on 25 September; the list rounds it to 16.66). Overview is today only, so on recording day that row is not there. If the ring has wrapped, hold a still of this same screen. Do not quote a different amount. If later rows sit above it, the day may be behind Show older decisions.

The decision screen, as the app renders this refusal:

> Refused
> No money moved.
> Your agent asked to pay 16.659625. Your rule allows 10 per payment, so the program refused.

On that same screen: Your agent asked 16.659625. Your limit per payment 10. Money moved 0. Why it was refused: Over your per-payment limit of 10. Needed to allow it: 16.659625. That last figure is the override that would have cleared it.

Voice: *"This agent just decided not to spend your money. That decision is on chain, and that is the product."*

**00:12 to 00:30. What a rule is.**

The quoted rule, opened from the Rules tab. Point at the four fields as they are named on that screen: Total cap 300; Per payment, max 10; Expires; Payee 6i99...PdCG.

Voice: *"You write a rule once. One human, several agents, one rule each. A ruleset written once is reused on the next agent. The key never leaves Seed Vault. The agent gets authority, never ownership, and it cannot widen any of these."*

**00:30 to 00:50. Connect your agent.**

Open an active rule. The rule screen shows Connect your agent: the JSON fields, Copy all, and a QR code of that same JSON. Copy all puts the block on the clipboard. The QR is the same text.

Then open a rule that is not active. Copy all and the QR are absent. The panel says: "This rule is not active, so there is no config to hand an agent."

The block is what `loadAgentConfig` reads and what `VetoAgent.fromConfig` checks. The program id has to be the program bundled with the SDK. Decimals are read from the mint. The cluster has to match the endpoint's genesis hash. A connection passed in code is the endpoint instead of `rpcUrl`.

Voice: *"An active rule hands the agent one block: Copy all, or the QR. The same block is what the example charges with. A rule that is not active has nothing to hand over."*

**00:50 to 01:10. The yes.**

The paid row of 8 on the quoted rule, recorded at 2026-09-24 23:10:46 UTC. The list titles it Paid 8 to 6i99...PdCG. Agent phone: the row is already there. No tap. The terminal, if it is on screen, shows payments that arrived. It does not start the charge. On this transaction the source went from 300 to 292 and the merchant token account gained 8.

Voice: *"Inside the box it pays. That row is 8, under the 10 ceiling. Nobody approved that payment."*

**01:10 to 01:40. The no, and the explorer.**

Cut back to the same 12:00 refusal the video opened on. Same rule. The window reprices a bill of 12.5 kWh at 1.33277 SEK/kWh, which is 16.659625, over the 10 per-payment maximum. The phone already said why, and the figure that would have allowed it. The transaction confirmed at 2026-09-25 10:00:25 UTC. On that transaction the source stayed 292 and the merchant token account did not gain these tokens.

Then cut to a laptop, open this transaction in the explorer, and read the log line on screen:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=16659625
per_tx_max=10000000 remaining=292000000 override_to_clear=16659625
```

https://explorer.solana.com/tx/2DAXYtVCkGPG8RdbYWJcJvZHk4F7tvkJCnqExuyg8qUrdK53DwNUBiCD1MBx3LrzHvd8YXVF7RXr5tz4EujfHo5B?cluster=devnet

Remaining 292000000 is 292 of the 300 cap, after the payment of 8. The refusals did not change that remaining figure. Override 16659625 is the amount, because 16.659625 is over 10 and still under the remaining cap.

Voice: *"The transaction confirmed and the balance did not move. It succeeded at deciding no. The log line is the record: the reason, and the override that would have cleared it."*

**01:40 to 02:05. The diary on this rule.**

Decisions for the quoted rule. If the 25 September day is behind Show older decisions, open it. Stop on the paid row of 8 and the refused row of 16.659625 (16.66 on the list).

Voice: *"On this rule, before 18:00 Swedish time on 25 September, one payment under the ceiling is on the chain and four charges over it were refused. From 18:00 the watcher charges 6 kWh a slot, so a later bill can pay or refuse as the spot moves. The price is the public index, and you can check it at the same URL. Solana devnet, our token, our counterparty. No electricity was bought."*

**02:05 to 02:25. Take one off the phone.**

Export that same 12:00 refusal to JSON on the laptop (`export.ts --signature` of the transaction above, `--out` a file), run verify against public devnet, and let the output land:

```
Mandate limits, ledger entry, and charge transaction agree.
```

That sentence is what `tools/verify.ts` prints. It still uses the on-chain names.

Then change the amount in the file to 1 and run it again. While the ring still holds this row, verify prints both of these lines:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 16659625
- amount (ledger): record has 1, chain has 16659625
```

Voice: *"A refusal is portable. Anyone can check it against the chain, and a record that was tampered with fails."*

**02:25 to 02:45. Revoke one rule, leave the other.**

Not the quoted rule. Open two rules in the app. Each gets a token account derived from the owner, seed `veto-rule-<mandate id>`, and the cap moves into that account. On one of them, tap Revoke this rule. One Seed Vault signature. That signature clears the delegate on that rule's token account only. The agent's next charge on that rule is refused with the recorded reason "mandate not active", and that refusal lands on Decisions. The other rule's token account still has its own delegate, and a charge inside its limits still pays.

Close rule on a dedicated account returns the remaining tokens to the owner and closes the token account, so the rent comes back with the mandate rent and the ledger rent.

The devnet journey `make e2e-devnet` has already done this shape once: revoke one rule, the next charge on it is reason 1, and the other rule still pays. Those two accounts were closed at the end of that run. Shoot the beat on a new pair. The 16.659625 card stays the card the video opened on. It is a different rule.

Voice: *"Authority ends on the rule you revoke. The other rule is a different account, and it keeps paying. Nothing already paid changes. The next charge on the revoked rule is refused, and that refusal is recorded too."*

**02:45 to 03:00. Close.**

Voice: *"The decline is recorded, with the reason and the override that would have cleared it. AP2 standardised the record of a yes. This is the missing half."*

Last frame: the refusal screen. Same 16.659625-over-10 refusal the video opened on.

## Rules for the edit

- **A refusal is never styled as an error.** Not in the app, not in the edit, no red flash, no error sound. It is the product working.
- A row labeled Agent declined (advisory) is the agent's own purpose-check memo: the operator supplied the check, a decline submits no charge and the memo is signed by the agent's key and names the rule, whoever runs the agent can skip the check, the program still enforces every number, and verify does not treat it as a program refusal.
- **No claim the repo does not make.** The words the entry does not use are in [internal/WORDS.md](internal/WORDS.md).
- Real device, visible. No simulator frames.
- Under three minutes, hard.
- No background music under the explorer shot; let the log line be read.

Recording notes for the day are in [internal/RECORDING.md](internal/RECORDING.md).
