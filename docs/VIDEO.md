# The three-minute video

Shot list for the submission video. Every beat below is what the current app and program do on the quoted rule. Completion is judged from this, and the brief is explicit that it has to run on a device: a video nobody can install is not a submission. The app's tabs are Overview, Rules, Agents, and Decisions. This shot list uses Overview, Rules, and Decisions. The quoted refusal is the 18:00 Stockholm window on mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`, confirmed at 2026-09-20 20:58:12 UTC. The card opens from Decisions, not Overview. Overview's latest decisions are today only. Hold is live on devnet. The app screens exist, and a device check with a real vault follows. This shot list stays on the quoted spending rule.

Two phones on a desk, both visibly phones. Both stay in frame.

The demo pays a bill repriced by a public index, on Solana devnet, in our token, to our counterparty. It buys no electricity.

## What must be true before recording

- Program on **devnet**, not a local validator. Every explorer link in this video has to open on a judge's laptop, and nobody can click localhost.
- The narration says what the payment is: a bill repriced by a public price index, unattended, against the on-chain rule. Solana devnet, our token, our counterparty. The price is the only input we do not control. It buys no electricity. The mint and the counterparty account come from [scripts/devnet-setup.sh](../scripts/devnet-setup.sh). [tools/produce.ts](../tools/produce.ts) mints further supply of that same mint. When the rule allows the bill, the program executes an SPL transfer of that token to the account we created.
- The quoted rule is cap 100, per-payment maximum 0.5, purpose "SE3 home charging". Its signatures run from the open at 2026-09-20 20:57:50 UTC through the refusal at 2026-09-21 22:00:11 UTC: three paid (0.446, 0.2145, 0.0055) and six refused. There is no later signature on this mandate.
- That rule's source is the owner token account `FbhygYPyFk5PeiFppCezmMkqPqywTdAZxhkqxw79FBBE`. The delegate on that account is mandate `GVwLhzvRNqa5PnKcLakdocC3czQfYrBXGpbHb7HLPEjG` (id 3). A charge inside the limits against the quoted rule today is reason 7 once the delegation is withdrawn; the limits are checked first, so a bill over the per-payment limit is reason 5. The recorded rows stay readable.
- The explorer shot and the verify shot are that recorded refusal, not a new charge. Signature: `3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib`.
- The on-chain ring holds 32 entries. The agent can push a paid row out of that window with refusals. If the quoted row is no longer on the ring, the phone will not still show it. Explorer and verify do not need the ring. Do not replace the quoted card, log, or verify line with a different decision.
- Decisions stamps each row with the time the decision was recorded, not the SE3 price window it priced. The four 20 September decision rows (paid and refused; the open is not listed) were written from 20:58:03 to 21:00:50 UTC, so their clock labels cluster. Find those rows by the amount (0.2145 paid, 6.2325 refused).
- The yes beat is the recorded paid row of 0.2145 on this rule. The merchant terminal serves a quote and a page. It does not submit `charge`. A live charge is the watcher's `once --window`, or `sdk/examples/pay-once.ts`, and on this rule that charge is reason 5 when the bill is over the per-payment limit and reason 7 when it is inside the limits once the delegation is withdrawn.
- Revoke and a following payment are shot on rules that each have their own token account (`veto-rule-<mandate id>`), not on the quoted rule. `revoke_mandate` clears the delegate on that rule's source. On the shared owner token account, that delegate is rule id 3.

## Shot list

**00:00 to 00:12. Cold open on the refusal.**

No logo, no title card, no team slide. The refusal card for the 18:00 Stockholm decision the [README](../README.md) already links. If that row is still on the ring, open it from Decisions (the refused row of 6.2325 on 20 September). Overview is today only, so on recording day that row is not there. If the ring has wrapped, hold a still of this same card copy. Do not quote a different amount.

The card, as the app renders this decision:

> Your rule held.
> No payment made.
> Asked for 6.2325, over the 0.5 per-payment maximum. An override of 6.2325 would have cleared it.

Voice: *"This agent just decided not to spend your money. That decision is on chain, and that is the product."*

**00:12 to 00:30. What a rule is.**

The quoted rule, opened from the Rules tab. Point at the four fields as they are named on that screen: Total cap 100; Per payment, max 0.5; Expires; Payee.

Voice: *"You write a rule once. One human, several agents, one rule each. A ruleset written once is reused on the next agent. The key never leaves Seed Vault. The agent gets authority, never ownership, and it cannot widen any of these."*

**00:30 to 00:50. Connect your agent.**

Open an active rule. The rule screen shows Connect your agent: the JSON fields, Copy all, and a QR code of that same JSON. Copy all puts the block on the clipboard. The QR is the same text.

Then open a rule that is not active. Copy all and the QR are absent. The panel says: "This rule is not active, so there is no config to hand an agent."

The block is what `loadAgentConfig` reads and what `VetoAgent.fromConfig` checks. The program id has to be the program bundled with the SDK. Decimals are read from the mint. The cluster has to match the endpoint's genesis hash. A connection passed in code is the endpoint instead of `rpcUrl`.

Voice: *"An active rule hands the agent one block: Copy all, or the QR. The same block is what the example charges with. A rule that is not active has nothing to hand over."*

**00:50 to 01:10. The yes.**

The paid row of 0.2145 on the quoted rule, recorded at 2026-09-20 20:58:03 UTC. The amount is 50 kWh times the public spot for that window, in our token, paid to the merchant token account this repository created. Agent phone: the row is already there. No tap. The terminal, if it is on screen, shows payments that arrived. It does not start the charge.

Voice: *"Inside the box it pays the bill. That row is 0.2145, under the 0.5 ceiling. Nobody approved that payment."*

**01:10 to 01:40. The no, and the explorer.**

Cut back to the same 18:00 refusal the video opened on. Same rule. The window reprices a bill of 50 kWh at 0.12465 SEK/kWh, which is 6.2325, over the 0.5 per-payment maximum. The phone already said why, with the override that would have cleared it. The transaction confirmed at 2026-09-20 20:58:12 UTC.

Then cut to a laptop, open that transaction in the explorer (the signature in the README), and read the log line on screen:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500
per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

Remaining 99339500 is 99.3395 of the 100 cap, after the 0.446 and 0.2145 payments that landed before this refusal. The 0.0055 payment landed after it. Override 6232500 is the amount, because 6.2325 is over 0.5 and still under the remaining cap.

Voice: *"The transaction confirmed and the balance did not move. It succeeded at deciding no. The log line is the record: the reason, and the override that would have cleared it."*

**01:40 to 02:05. The diary on this rule.**

Decisions for the quoted rule. Scroll the rows from 20 September 20:57 UTC through 21 September 22:00 UTC. Stop on the paid row of 0.2145 and the refused row of 6.2325.

Voice: *"On this rule the diary runs from the evening of 20 September through 22:00 UTC on 21 September. Three bills under the ceiling were paid. Six over it were refused. Nothing on this rule has been charged since. The price is the public index, and you can check it at the same URL. Solana devnet, our token, our counterparty. No electricity was bought."*

**02:05 to 02:25. Take one off the phone.**

Export that same 18:00 refusal to JSON on the laptop (`export.ts --signature` of the README transaction, `--out` a file), run verify against public devnet, and let the output land:

```
Mandate limits, ledger entry, and charge transaction agree.
```

That sentence is what `tools/verify.ts` prints. It still uses the on-chain names.

Then change the amount in the file to 1 and run it again. While the ring still holds this row, verify prints both of these lines:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 6232500
- amount (ledger): record has 1, chain has 6232500
```

Voice: *"A refusal is portable. Anyone can check it against the chain, and a record that was tampered with fails."*

**02:25 to 02:45. Revoke one rule, leave the other.**

Not the quoted rule. Open two rules in the app. Each gets a token account derived from the owner, seed `veto-rule-<mandate id>`, and the cap moves into that account. On one of them, tap Revoke this rule. One Seed Vault signature. That signature clears the delegate on that rule's token account only. The agent's next charge on that rule is refused with the recorded reason "mandate not active", and that refusal lands on Decisions. The other rule's token account still has its own delegate, and a charge inside its limits still pays.

Close rule on a dedicated account returns the remaining tokens to the owner and closes the token account, so the rent comes back with the mandate rent and the ledger rent.

The devnet journey `make e2e-devnet` has already done this shape once: revoke one rule, the next charge on it is reason 1, and the other rule still pays. Those two accounts were closed at the end of that run. Shoot the beat on a new pair. The 6.2325 card stays the card the video opened on. It is a different rule.

Voice: *"Authority ends on the rule you revoke. The other rule is a different account, and it keeps paying. Nothing already paid changes. The next charge on the revoked rule is refused, and that refusal is recorded too."*

**02:45 to 03:00. Close.**

Voice: *"The decline is recorded, with the reason and the override that would have cleared it. AP2 standardised the record of a yes. This is the missing half."*

Last frame: the refusal card. Same 6.2325-over-0.5 card the video opened on.

## Rules for the edit

- **A refusal is never styled as an error.** Not in the app, not in the edit, no red flash, no error sound. It is the product working.
- A row labeled Agent declined (advisory) is the agent's own purpose-check memo: the operator supplied the check, a decline submits no charge and the memo is signed by the agent's key and names the rule, whoever runs the agent can skip the check, the program still enforces every number, and verify does not treat it as a program refusal.
- **No claim the repo does not make.** The words the entry does not use are in [internal/WORDS.md](internal/WORDS.md).
- Real device, visible. No simulator frames.
- Under three minutes, hard.
- No background music under the explorer shot; let the log line be read.

Recording notes for the day are in [internal/RECORDING.md](internal/RECORDING.md).
