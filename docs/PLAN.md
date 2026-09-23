# Build plan

Solana Mobile "Clock In" hackathon. Submissions close **2026-10-09 at 08:59 GMT+2**.

The project is named veto. The recorded refusal is the product. Capped on-chain agent budgets
already exist.

## The claim

Limits on chain already exist. An overspend that is simply impossible protects the money and
leaves nothing to read: no artifact, no reason, no trail. Veto makes the refusal legible. A
recorded no, a one-line why, and the override that would have cleared it. On a phone, with the
key in Seed Vault.

AP2 standardised the record of a yes. This is the missing half.

The mandate is the prior claim, the ledger is the evidence, and neither is worth anything alone.
Who has the problem, and how a burner wallet compares, is in [PROBLEM.md](PROBLEM.md).

## Prior art

Capped agent spending is not new. The table names the limits that already exist.

| Who | What they do | Relation to this entry |
|---|---|---|
| Squads v4 spending limits | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec, Trail of Bits, two formal verifications underway | Treasury operations for humans. An overspend stops, and the stop leaves no record |
| SPL `approve` / delegate | Caps what a delegate can pull | Cap only. No purpose, no expiry, no reason, no record |
| LazorKit | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers |
| SolAgent Pay | Session PDA with lifetime and per-request ceilings, merchant allowlist, TTL, revoke and sweep, audit viewer | An overspend "is not a policy violation logged after the fact, it is an impossible transaction". Funds are escrowed into a vault. Veto records the decline and leaves the funds in the owner's wallet |
| Oculus | On-chain policy check per transaction, USDC reserve reimburses a breach within 60s | Reimburses a breach after the fact. Veto declines before money moves |
| x402 / AP2 | HTTP 402 settlement; signed Intent, Cart and Payment mandates as verifiable credentials | The record of a yes, held off chain as evidence for the merchant |
| Seed Vault | Hardware-held keys, human approves every signature | The default on this platform. Unattended agent spend needs a bound beside that key |

By the time this plan was written, capped on-chain agent budgets were already commodity, including
tutorials from infrastructure vendors. The entry is the mobile build, the recorded refusal, and
the demo.

## Solana Mobile

Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
it rather than a copy of the key.

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

### The program

The program enforces the limits on chain and records the refusal. New policy fields are out of
scope.

`charge` returns `Ok` when it declines. An error would roll back every account write, so the
refusal would leave no trace. Declining transfers nothing, writes a ledger entry with a reason
code, logs a readable line, and succeeds. The refusal reason codes are listed in the
[README](../README.md).

Four limits enforced on chain: total cap, per-payment maximum, expiry, one allowed merchant.
Funds stay in the owner's wallet under an SPL delegate. They are not escrowed into a vault. A
nonce advances only on payment, so a settled charge cannot be replayed, and a refused one can
still be retried after an override.

The refusal carries the override that would have cleared it. The live devnet line is in the
README: an amount, the per-payment maximum, the remaining cap, and `override_to_clear`.

### The feed

`https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json`, verified 2026-09-20: HTTP 200,
no authentication, 15-minute resolution, SEK and EUR per kWh.

The agent pays for charging when power is under the ceiling the owner set.

The price is a public spot for a purchase. A DEX price is a trade. Energy is the feed with a real
moving price for something a person buys.

The price is real, public, and independently verifiable against the same URL. The counterparty is
a terminal this repository runs, because no charge point operator accepts USDC. Calling that
terminal a real merchant would be false, and the hackathon rules disqualify misleading submission
materials.

### The watcher

The cloud project for that job is [GCP_SETUP.md](GCP_SETUP.md). The deploy script has been run.
The Cloud Run jobs, scheduler, bucket, secret, and registry are listed there.
`scripts/gcp-verify.sh` checks that document against the live project. Its absence checks fail
because those resources exist.

### History

The on-chain `Ledger` is a 32-entry ring. A week of activity will wrap it. The ring is the
authoritative recent window. The full trail is reconstructed by indexing `Paid` and `Refused`
events from transaction logs. The decision cadence stays to a handful per day so the ledger reads
as a diary.

### The app

One APK, in `app/`. Connect through Mobile Wallet Adapter against Seed Vault. Write a mandate. A
today view of what the agent did and declined. A ledger with explorer links. Revoke in one tap. A
local notification on every decision, raised by an on-device background read
(`app/lib/decisionNotifyTask.ts`), because the agent acts while the owner is not looking.

The agent key is generated in the app and held in `expo-secure-store`. It signs `charge` and
nothing else. It owns no funds and cannot widen any limit.

### The model

Two jobs, both above the program: turn a sentence into the four mandate numbers, and write the
one-line why from the reason code. Enforcement does not use the model. Declining on purpose
grounds, rather than on the numeric limits, waits until the charge path is in place.

## Milestones

The watcher has to start early. A week of history cannot be backfilled. Dates below are the
hackathon calendar.

| By | Must be true | Cut line |
|---|---|---|
| **Sep 23** | Program deployed to devnet. Watcher running against the live feed, paying and refusing unattended. First real ledger entries accumulating. | None. This is the gate that makes the demo possible at all |
| **Sep 27** | Watcher stable and logging a clean daily rhythm. Indexer reading full history from tx logs. Dev client runs on both Seekers, MWA authorize works against Seed Vault. | If the watcher restarts, the seven-day window slips to five and the pitch says five |
| **Oct 1** | Mandate opened from the phone with one signature. Today view and ledger reading real history. Revoke works. | Open the mandate from a desktop signer, keep MWA for sign-in only |
| **Oct 4** | Override path with the actionable suggestion. Local notifications from an on-device background read. Export and off-phone verify working. Polish. Release APK installs clean on a wiped device. Deck drafted. Security pass on the program. | Drop the model, ship the structured form |
| **Oct 6** | Three-minute video shot on device. Deck done. | Re-shoot day is Oct 7 |
| **Oct 8** | Submitted on Align. | True cutoff is 08:59 the next morning; the night is reserve |

## Scoring

| Criterion | Where the repo stands |
|---|---|
| Innovation 25% | The program records a refusal with a reason and the override that would have cleared it |
| Presentation 25% | The deck and the video script are in the repo. The week of history they are written for is not on chain yet |
| UX 25% | The Android app is in `app/`. Mobile Wallet Adapter and Seed Vault have not been checked on a Seeker. This is the largest open risk |
| Stickiness 25% | The weakest criterion. The watcher decides on a cadence against the live feed, and the ledger is that history. It holds only if that history is real |

## Risks

1. **Mobile Wallet Adapter and Seed Vault still have to be checked on a Seeker.** The unit tests
   do not cover `authorize` or the Seed Vault signatures. That check is on the Seekers.
2. **The seven-day history needs the watcher running from Sep 23.** A later start shortens the
   window the pitch can describe. This is the deliverable with a start date.
3. **A refusal has to confirm.** The balance is unchanged and the ledger entry exists in the same
   confirmed transaction. That is what the refusal test asserts.
4. **A charge the agent never submits has no record.** Nothing on chain can provide one. The
   record is every decision the agent submits. [PROBLEM.md](PROBLEM.md) states that limit.
5. **SolAgent Pay ships ceilings and describes an overspend as an impossible transaction.** It
   escrows into a vault. The difference recorded here is the refusal, on a phone.

## House rules

Small conventional commits from day one, because commit history is scored. No invented prices or
fabricated counterparties on any surface. Amounts as integer base units, never floats. Secrets
never in git. No em dash anywhere.
