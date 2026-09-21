# Build plan

Solana Mobile "Clock In" hackathon. Submissions close **2026-10-09 at 08:59 GMT+2**.
Rewritten 2026-09-20 after the competitive check. 19 days.

> Named `veto`, because the cap is the commodity half and the recorded refusal is the product.


## The claim, after the competitive check

The first version of this plan claimed bounded authority for agents. That claim is dead. Capped
on-chain agent budgets are a documented tutorial from an infrastructure vendor, Squads ships
audited and formally verified spending limits, LazorKit ships session keys with on-chain roles and
limits, and AP2 standardised signed mandates carrying limits, merchants and validity windows.

What nobody has built:

> Limits on chain already exist. Every one of them makes an overspend **impossible**. An impossible
> transaction protects your money and teaches you nothing: no artifact, no reason, no trail. We
> make the refusal **legible**. A recorded no, a one-line why, and the override that would have
> cleared it. On a phone, with the key in Seed Vault.

AP2 standardised the record of a yes. This is the missing half.

The narrowed claim, and the wording that survives contact, is in [PROBLEM.md](PROBLEM.md). The
short version: the mandate is the prior claim, the ledger is the evidence, and neither is worth
anything alone. The real competitor is a burner wallet, not Squads.

## Prior art, named on purpose

Put this in the deck. Naming it before the judges do converts the weakest question into the
strongest moment, and two of the seven judges are security researchers.

| Who | What they do | Why it is not this |
|---|---|---|
| Squads v4 spending limits | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec, Trail of Bits, two formal verifications underway | Treasury operations for humans. Overspend is impossible, never legible |
| SPL `approve` / delegate | Caps what a delegate can pull | Cap only. No purpose, no expiry, no reason, no record |
| LazorKit | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers, not a product about trust |
| SolAgent Pay | Session PDA with lifetime and per-request ceilings, merchant allowlist, TTL, revoke and sweep, audit viewer | Closest on numbers. States outright that an overspend "is not a policy violation logged after the fact, it is an impossible transaction". Opposite thesis. Also escrows into a vault; we never move the funds |
| Oculus | On-chain policy check per transaction, USDC reserve reimburses a breach within 60s | Insurance after the fact. We decline before money moves |
| x402 / AP2 | HTTP 402 settlement; signed Intent, Cart and Payment mandates as verifiable credentials | The record of a yes, held off chain as evidence for the merchant |
| Seed Vault | Hardware-held keys, human approves every signature | Correct default, and exactly why unattended agent spend has nowhere to live on this platform |

The honest summary: **the wedge is positioning and execution, not technology.** The primitive went
commodity around three months ago. This entry is won on the mobile build and the demo.

## Why Solana Mobile

Not "spend decisions happen on a phone", which is generic, and not "no agent-authority entry has
won before", which tells a judge you picked a gap in a winners list.

> Seed Vault is built so a human approves every signature. That is the right default, and it is
> exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
> Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
> it rather than a copy of the key.

Squads cannot make that argument. AP2 cannot. It is the only "why here" that is not interchangeable.

## Architecture

Three pieces. No server holds money and no server can veto anything.

```
Phone (owner + agent)            Solana devnet              Watcher (unattended)
---------------------            -------------              --------------------
Seed Vault key --MWA-->          open_mandate
                                 grant_override
                                 revoke_mandate
agent hot key  --------->        charge  ---> transfer OR refusal entry  <--- hourly decisions
                                 ledger PDA                                    against the live feed
```

### The program: frozen

Already written, compiles, and it is done being interesting. Do not add policy fields. Competing
with the prior art on policy surface is a losing race and it is not the wedge.

The one design decision the whole product rests on: **`charge` returns `Ok` when it declines.**
An error would roll back every account write, so the refusal would leave no trace and would be
indistinguishable from nothing having happened. Declining transfers nothing, writes a ledger entry
with a reason code, logs a readable line, and succeeds. Without this there is no seven days of
anything, because reverted transactions are not a record.

Four limits enforced on chain: total cap, per-payment maximum, expiry, one allowed merchant. Funds
stay in the owner's wallet under an SPL delegate; they are never escrowed into a vault. Nine reason
codes. A nonce that advances only on payment, so a settled charge cannot be replayed while a
refused one can still be retried after an override.

**One addition, and only this one:** the refusal should be actionable, not merely recorded.
"180 exceeds your 60 per-payment limit; an override of 120 would clear it." No prior art does
anything but decline. It is cheap and it is a differentiator.

### The feed: Nordic day-ahead electricity spot

`https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json`, verified 2026-09-20: HTTP 200,
no authentication, 15-minute resolution, SEK and EUR per kWh.

The agent pays for charging when power is under the ceiling the owner set.

Why this feed and not a DEX price: a bot buying a dip is a trading app, which is the crowded
category the brief contrasts with, and a token purchase is a trade rather than a purchase, so the
refusal loses its force. Energy is a recognisable thing to buy, legible to a judge who has never
touched crypto.

**State the honesty boundary out loud, in the README and in the video.** The price is real, public
and independently verifiable against the same URL. The counterparty is a terminal we run, because
no charge point operator accepts USDC. What this buys is the property that matters: refusals happen
because the real price crossed the ceiling, not because anyone pressed a button. Claiming a real
merchant would be false and §15 disqualifies for misleading submission materials.

### The watcher, unattended

The hourly job runs in the cloud project described in [GCP_SETUP.md](GCP_SETUP.md).
`scripts/gcp-verify.sh` checks that document against the live project.

### History: ring plus logs

The on-chain `Ledger` is a 32-entry ring. A week of activity will wrap it. The ring is the
authoritative recent window; the full trail is reconstructed by indexing `Paid` and `Refused`
events from transaction logs. Say that out loud rather than discovering it on Oct 5. Keep the
decision cadence to a handful per day so the ledger reads as a diary and not a firehose.

### The app

One APK. Connect through Mobile Wallet Adapter against Seed Vault. Write a mandate. Today view of
what the agent did and declined. Ledger with explorer links. Revoke in one tap. Push on every
decision, because the habit is the agent acting while you are not looking.

The agent key is generated in the app and held in `expo-secure-store`. It signs `charge` and
nothing else. It owns no funds and cannot widen any limit. That is the literal form of "the agent
gets authority, not ownership."

### The model: thin, and above the program only

Two jobs: turn a sentence into the four mandate numbers, and write the one-line why from the reason
code. Enforcement never touches it. Semantic refusal, declining on purpose grounds rather than
numeric ones, is genuinely unclaimed territory and is the second-most differentiating thing here,
but it ships only after the happy path is green.

## Milestones

The reordering is the point: the watcher and the feed move to this week, because seven days of
history has a hard start date. The program is done; the phone has not started.

| By | Must be true | Cut line |
|---|---|---|
| **Sep 23** | Program deployed to devnet. Watcher running against the live feed, paying and refusing unattended. First real ledger entries accumulating. | None. This is the gate that makes the demo possible at all |
| **Sep 27** | Watcher stable and logging a clean daily rhythm. Indexer reading full history from tx logs. Dev client runs on both Seekers, MWA authorize works against Seed Vault. | If the watcher restarts, the seven-day window slips to five and the pitch says five |
| **Oct 1** | Mandate opened from the phone with one signature. Today view and ledger reading real history. Revoke works. | Open the mandate from a desktop signer, keep MWA for sign-in only |
| **Oct 4** | Override path with the actionable suggestion. Push notifications. Export and off-phone verify working. Polish. Release APK installs clean on a wiped device. Deck drafted. Security pass on the program. | Drop the model, ship the structured form. The pitch survives it |
| **Oct 6** | Three-minute video shot on device. Deck done. | Re-shoot day is Oct 7 |
| **Oct 8** | Submitted on Align. | True cutoff is 08:59 the next morning; the night is reserve |

## Scoring, honestly

| Criterion | Where we stand |
|---|---|
| Innovation 25% | Banked. The recorded refusal is the differentiator and the program already does it |
| Presentation 25% | Open. Won by the prior-art slide, the two-path demo and the real week of history |
| UX 25% | Not started. This is now the largest single risk |
| Stickiness 25% | Weakest. The answer is that the agent acts daily and the ledger is a trust dashboard. It only works if the history is real |

## Risks

1. **Nothing on the phone exists yet and 50% of the score is UX and presentation.** Expo plus MWA
   plus Seed Vault on a real Seeker is where hackathons die. Build the dev client first, test only
   on the Seekers, never an emulator.
2. **The watcher must start by Sep 23 or the seven-day claim shrinks.** It is the only deliverable
   with a hard start date rather than a hard end date.
3. **Someone reframes the program as a revert.** It must succeed and record. Guard it with a test
   that asserts the balance is unchanged and the ledger entry exists in the same confirmed
   transaction.
4. **A judge asks where the record is for a charge the agent never submitted.** There is none, and
   nothing on chain can provide one. Answer it before they ask; see the pitch.
5. **SolAgent Pay appeared three days before this plan** with a hackathon-shaped demo script. Assume
   it is an entry somewhere. Mobile and legible refusal are both things it does not do.

## House rules

Small conventional commits from day one, because commit history is scored. No invented prices or
fabricated counterparties on any surface. Amounts as integer base units, never floats. Secrets never
in git. No em dash anywhere.
