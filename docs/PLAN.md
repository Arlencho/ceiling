# Ceiling: build plan

Solana Mobile "Clock In" hackathon. Submissions close **2026-10-09 at 08:59 GMT+2**. Plan written
2026-09-20, so 19 days and the last one is a night shift.

Working name `ceiling`. Rename is one command if a better one lands.

## The one sentence

A mandate is a permission to spend that a Solana program enforces: a ceiling, a per-payment
maximum, an expiry, and one allowed merchant. An agent acts inside it without another tap, and
when a charge breaks the rule the program refuses, records why on chain, and moves no money.

## What is different about this entry

Every other payments entry demonstrates a transaction succeeding. This one demonstrates a
transaction that confirms on chain, is visible in the explorer, and deliberately moves nothing.
The refusal is a first-class on-chain artifact, not the absence of a transaction.

## Decisions taken (2026-09-20)

| Question | Decision |
|---|---|
| Product | Fully standalone. No Olympus coupling, no Spilios gate, no `olympus-platform` changes. |
| Enforcement | On-chain Anchor program. Cap, per-payment max, expiry and merchant are all chain-enforced. |
| Custody | Funds never leave the user's wallet. The mandate PDA is an SPL delegate on the user's ATA. |
| Keys | Owner key stays in Seed Vault, reached through Mobile Wallet Adapter. The agent holds a separate hot key with authority and zero spending power of its own. |
| Network | Devnet throughout. One mainnet run recorded for the video if stable by Oct 4. |
| Backend | None for money. One tiny serverless function for the language model, which touches no funds. |
| Hardware | Two Seeker phones. One runs the agent, one runs the merchant terminal. One APK, two modes. |

## The demo

Two phones, side by side, on camera.

1. **Phone A, the agent.** Write the mandate in plain language: "transport and food, up to 200 USDC,
   no single payment over 60, until Friday." The model turns it into the four numbers. One Seed
   Vault signature. The mandate is now on chain.
2. **Phone B, the merchant terminal.** Charge 42 USDC. QR appears.
3. **Phone A scans.** No tap, no prompt. The agent decides, signs with its own key, the program
   transfers. Both phones show PAID, with the signature.
4. **Phone B charges 180 USDC.** Same agent, same mandate, same scan.
5. **Phone A refuses.** One line: "180 is over your 60 per-payment limit." The transaction still
   confirms. Open the explorer: the refusal is recorded, the balance is unchanged.
6. **The ledger screen.** Every decision, paid and refused, read back from the chain.
7. **Revoke.** One tap, one signature, the delegate is gone.

Close on: everyone else showed you a wallet that can do more. This one is allowed to do less, and
that is enforced by the chain, not by our word.

## Architecture

Three pieces. No server holds money and no server can veto anything.

```
Phone A (agent)                  Solana devnet                 Phone B (merchant)
-------------                    -------------                 ------------------
Seed Vault key  --MWA sign-->    open_mandate  ----.
                                                   |
agent hot key   --sign------->   charge(amount) ---+--> transfer OR refusal entry
                                                   |
                                 ledger PDA  <-----'   <---- polled for the outcome
```

### The program (Anchor, Rust)

Two accounts.

`Mandate` PDA, seeds `["mandate", owner, mandate_id]`:
owner, agent, mint, source ATA, cap, spent, per_tx_max, expires_at, purpose hash,
allowed_merchant, status, spend_count, refusal_count, override_amount, override_nonce, bump.

`Ledger` PDA, seeds `["ledger", mandate]`: a fixed ring of 32 entries
`{ ts, amount, merchant, kind, reason, nonce }` plus a running total.

Five instructions.

1. **`open_mandate`** signed by the owner. Initialises both PDAs and, in the same transaction,
   CPIs `token::approve` so the mandate PDA becomes the delegate on the owner's ATA for `cap`.
   One wallet prompt for the whole thing.
2. **`charge(amount, nonce, merchant)`** signed by the agent. Evaluates, in order: status,
   expiry against `Clock`, merchant allowlist, per-payment max (or a matching one-shot override),
   remaining cap, available balance. On pass it CPIs `transfer_checked` with the PDA as delegate
   authority and increments `spent`. On any failure it transfers nothing and writes a refusal
   entry. **Either way it returns `Ok` and writes a ledger entry.** Returning an error would roll
   back the log, so the refusal would leave no trace. That is the design decision the whole pitch
   rests on.
3. **`grant_override(amount, nonce)`** signed by the owner. Raises the ceiling once, for one
   specific pending charge. Logged as an override, so "I let it through" is on the record too.
4. **`revoke`** signed by the owner. Sets the status and CPIs `token::revoke`. Immediate.
5. **`close_mandate`** signed by the owner. Reclaims rent.

Reason codes: `0 ok, 1 over_per_tx_max, 2 over_cap, 3 expired, 4 revoked, 5 merchant_not_allowed,
6 insufficient_funds, 7 mint_mismatch`.

What is honestly on chain: the ceiling, the per-payment maximum, the expiry, the allowed merchant,
every decision. The human-readable purpose is hashed into the mandate so it cannot be edited after
the fact, and it is bound to the merchant allowlist. Say it exactly that way to judges. Do not
claim the chain understands the word "groceries."

### The app (Expo, Android, one APK, two modes)

Agent mode: Connect (MWA authorize against Seed Vault), Write a mandate, Agent (live decision
cards), Ledger (read back from chain, explorer links), Revoke.

Merchant mode: amount and item in, QR out, then poll the ledger for the outcome and show PAID or
REFUSED with the reason.

The charge request is a QR carrying `{ merchant, amount, mint, item, nonce, expires }`, signed by
the merchant key. No network between the phones, so nothing to fail on stage.

The agent key is generated in the app and held in `expo-secure-store`. It can sign `charge` and
nothing else. It owns no funds and cannot move funds outside the mandate. This is the literal
form of "the agent gets authority, not ownership."

### The language model

Used for exactly two things: turning a sentence into the four mandate numbers (the user confirms
the parse before signing), and writing the one-line refusal explanation from the reason code.

Enforcement never touches the model. The model writes the rule, the chain enforces it. The key
lives in a small serverless function, never in the APK, and a deterministic fallback handles both
jobs if the call fails, so the demo cannot break on a network hiccup.

## Milestones and cut lines

Dates are "must be true by", not effort estimates.

| By | Must be true | Cut line if it slips |
|---|---|---|
| Sep 22 | Toolchain installed. Program compiles, `open_mandate` / `charge` / `revoke` pass tests on a local validator, including the refusal path. Repo public with real commit history. | None. This one cannot slip. |
| Sep 25 | Program deployed to devnet. Dev client runs on both Seekers, MWA authorize works against Seed Vault, mandate opens from the phone with one signature. | Fall back to a desktop signer for the opening signature and keep MWA for the demo only. |
| Sep 29 | Full loop on hardware: merchant QR, agent scans, pays under the ceiling, refuses over it, both outcomes on the ledger screen with explorer links. | Merchant mode becomes a web page on a laptop instead of the second phone. |
| Oct 2 | Override path, revoke, expiry, mandate authoring through the model, ledger polish, README with a judge-runnable quickstart. | Drop the model and ship the structured form. The pitch survives it. |
| Oct 4 | Hardening done. Signed release APK from EAS installs clean on a wiped device. Optional mainnet run recorded. | Devnet only, stated plainly in the README. |
| Oct 6 | Three-minute video shot on the two phones. Deck done. | Re-shoot day is Oct 7. |
| Oct 8 | Everything submitted on Align: APK, public repo, video, deck. | The true cutoff is 08:59 the next morning, so Oct 8 evening is the target and the night is the reserve. |

Publishing on the dApp Store is required of winners within 30 days of results, not at submission.
It is not on the critical path.

## Event facts, read from the official site on 2026-09-20

These supersede the Sep 10 notes. The deadline in particular had moved.

**Dates.** Registration and submissions opened Sep 8 18:00 GMT+2. **Submissions close Oct 9 at
08:59 GMT+2.** Judging opens Oct 10 09:00. Results Nov 10. No late entries. A submission can be
edited any time while it is still a draft, but once submitted it is locked.

**Required of the build.** Android only, must produce a functional APK. Must integrate the Solana
Mobile Stack and Mobile Wallet Adapter. Must be designed for mobile from the ground up, since
direct ports and PWA wrappers score poorly. Must interact meaningfully with the Solana network.

**Required of the submission.** Functional APK, a GitHub repo judges can clone and run, a demo
video of three minutes, and a pitch deck. The brief is explicit that it has to run on a device
rather than only in a simulator: a video nobody can install is not a submission.

**Prizes.** $135,000 total. First $30,000 plus a Seeker for each team member, then $25,000,
$20,000, $15,000, $10,000, and $5,000 each for sixth through tenth. A separate $10,000 in SKR for
the best SKR integration. Extras: featured dApp Store placement, marketing support, and a call
with Anatoly Yakovenko.

**Judged as a single category.** No tracks. Four criteria at 25% each: stickiness and product
market fit with the Seeker community, user experience, innovation and X-factor, presentation and
demo quality. The evaluation process weighs completion from the video, technical depth from the
GitHub commits, mobile-optimised UX and use of mobile features, interaction with the Solana
network, and clarity of vision from the presentation.

**Judges.** Anatoly Yakovenko (Solana Labs), Mert (Helius), Chase (Solana Foundation), Akshay
(Solana Mobile), Beeman (Solana Mobile), and **two security researchers from Ethelsec, Voynich
and A2nkF**. Winners face a technical review with code verification and follow-up questions.

**Eligibility.** Project must have been started within three months of the Sep 8 launch date, so a
fresh repo is the safe answer. Only teams without VC or angel funding are eligible for the USDC
prizes; Pelops AI AB has none. One submission per contestant. Sweden is on the eligible countries
list. 18 or over, KYC and AML through Sumsub, BVI law. Vibe-coding is explicitly allowed as long
as the work is your own.

**Not required at submission.** dApp Store publishing. Winners have 30 days after results.

**Community touchpoints.** Office hours Wednesdays and Thursdays 20:30 GMT+2 and Rad sessions
Mondays 18:30 GMT+2, both on the Radiants Discord. Remaining before the deadline: Sep 22, Sep 24,
Sep 29, Oct 1, Oct 6, Oct 8.

## What the event facts change about this build

**Two security researchers are judging, and winners get a code review.** That is unusually good
news for a product whose entire claim is bounded authority, and it also sets the bar. The Anchor
program has to survive a real read: every signer checked, every PDA constraint explicit, no
unchecked arithmetic, no way for the agent key to widen its own authority. Budget for a proper
security pass on the program before Oct 4 and write the threat model into the README. If the
program is sound, those two judges become the entry's strongest advocates rather than its risk.

**Stickiness is our weakest criterion, so answer it deliberately.** Nobody opens a mandate app
daily. The habit is the agent acting daily on your behalf, so the app has to show that: a Today
view of what the agent paid and what it refused, and a push notification on every decision. The
honest pitch line is that the product earns attention by doing things while you are not looking,
and the ledger is the reason you come back. Build the Today view, do not leave it to the deck.

**The SKR prize is $10,000 for something we nearly get for free.** The mandate is mint-agnostic by
construction, so governing SKR is configuration rather than a feature bolted on. Ship a second
demo mandate denominated in SKR and say plainly what it is: the same enforcement, a different
asset. Do not dress it up as more than that. Stretch goal, after the core loop is on hardware.

**"Interacts meaningfully with the Solana network" is satisfied by the refusal itself,** which is
the opposite of most entries where the chain is a payment rail bolted to an app. Say that in the
deck: the chain is not where the money moves, it is where the authority lives.

## Risks

1. **Anchor plus SPL delegate plus PDA signer is the one hard part.** It is also day one, so a
   failure surfaces with 16 days left, not two. If delegation fights us, the fallback is a vault
   PDA that holds the funds. Weaker custody story, identical demo.
2. **MWA on an Expo dev client.** Polyfill order and the router entry file are the known traps.
   Build the dev client on day one and test only on the Seekers, never an emulator.
3. **Returning `Ok` on refusal.** Needs a test that asserts the balance is unchanged and the
   ledger entry exists in the same confirmed transaction. This is the product, so it gets the
   most thorough test in the repo.
4. **Demo reliability.** Both phones, both paths, rehearsed end to end on Oct 4 and again Oct 6.
   The refusal path is the one that must never fail, so it is the one rehearsed most.
5. **"Isn't this just a spending limit?"** Answered by the explorer, not by argument. A bank limit
   is a rule the customer executes. This is an agent that acts, a chain that stops it, and a
   record either way that neither party can edit.

## House rules for this repo

Small conventional commits from day one, because commit history is scored. No AI vendor names in
commits, PR text or issues. No em dash anywhere. Amounts as integer base units, never floats.
No invented prices or fake balances on any surface. Secrets never in git.
