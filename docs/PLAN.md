# Build plan

This file is the internal build plan. Product claims live in the [README](../README.md), [PITCH.md](PITCH.md), and [PROBLEM.md](PROBLEM.md).

Solana Mobile "Clock In" hackathon. Submissions close October 8, 2026 at 23:59 Pacific, which is October 9, 2026 at 08:59 in Stockholm. The organizer's page names October 8, 2026.

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
| SolAgent Pay | An overspend "is not a policy violation logged after the fact, it is an impossible transaction". Funds are escrowed into a vault | Veto records the decline and leaves the funds in an account the owner controls |
| Oculus | On-chain policy check per transaction, a USDC reserve reimburses a breach after the fact | Reimburses a breach after the fact. Veto declines before money moves |
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
                                 close_mandate
agent hot key  --------->        charge  ---> transfer OR refusal entry  <--- four decisions a Stockholm day
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
The program does not escrow into a vault. `open_mandate` approves the mandate as delegate of
the source it is given. A rule opened in the app moves the cap into a token account derived
from the owner (`veto-rule-<mandate id>`). Close rule returns that balance and the rent.
Revoking one of those rules does not clear another rule's account. A nonce advances only on
payment, so a settled charge cannot be replayed, and a refused one can still be retried after
an override.

The refusal carries the override that would have cleared it. The live devnet line is in the
README: an amount, the per-payment maximum, the remaining cap, and `override_to_clear`.

### The feed

`https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json`, verified 2026-09-20: HTTP 200,
no authentication, 15-minute resolution, SEK and EUR per kWh.

The demo pays a bill repriced by that index, on devnet, in our token, to a terminal this
repository runs. It buys no electricity. The bill is paid when the repriced amount is inside
the rule.

The price is a public spot. A DEX price is a trade.

The price is real, public, and independently verifiable against the same URL. The counterparty
is a terminal this repository runs, because no charge point operator accepts this mint
(`2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU`). Calling that terminal a real merchant would
be false. This repository does not describe it as one.

### The watcher

The cloud project for that job is [GCP_SETUP.md](GCP_SETUP.md). The deploy script has been run.
The Cloud Run jobs, scheduler, bucket, secret, and registry are listed there.
`scripts/gcp-verify.sh` checks that document against the live project. Its absence checks fail
because those resources exist.

### History

The on-chain `Ledger` is a 32-entry ring. Four decisions a day is 28 entries in a week, inside
the ring. More than a week wraps it (the 33rd entry). The ring is the authoritative recent
window. The full trail is reconstructed by indexing `Paid` and `Refused` events from transaction
logs. The agent can also fill the window with refusals and push a paid row out of it.

### The app

One APK, in `app/`. A first launch shows four introduction cards before Connect. Connect through
Mobile Wallet Adapter against Seed Vault. With no rule, Overview shows Open your first rule.
Write a mandate. A today view of what the agent did and declined. A ledger with explorer links.
On an active rule, Connect your agent (Copy all and a QR). Revoke in one tap. Close rule returns
the remaining budget on a per-rule token account. A local notification on every decision, raised
by an on-device background read (`app/lib/decisionNotifyTask.ts`), because the agent acts while
the owner is not looking.

The agent key is generated in the app and held in `expo-secure-store`. It signs `charge` and
nothing else. It owns no funds and cannot widen any limit.

### The form

No model is involved. The four numbers are typed or taken from a template in `app/lib/templates.ts`.
The why is a fixed sentence per reason code in `app/lib/reasons.ts`. The charge path is in the
program. A refusal is one of the numeric reason codes. Declining on the meaning of the purpose
is not in the program. Issue 24 is still open. The purpose is stored as written, at most 64
characters.

## Milestones

Dates below are the hackathon calendar. The cut lines and the old self-score live in
[internal/BUILD_NOTES.md](internal/BUILD_NOTES.md).

| By | Must be true |
|---|---|
| **Sep 23** | Program deployed to devnet. Watcher running against the live feed. First real ledger entries on chain. |
| **Sep 27** | Watcher logging on the six-hour cadence. Indexer reading history from transaction logs. |
| **Oct 1** | Mandate opened from the phone with one signature. Today view and ledger reading real history. Revoke works. |
| **Oct 4** | Override path. Local notifications from an on-device background read. Export and off-phone verify. Release APK. |
| **Oct 6** | Three-minute video shot on device. Deck done. |
| **Oct 8** | Submitted. The deadline is October 8, 2026 at 23:59 Pacific (October 9, 2026 at 08:59 in Stockholm). |

On 2026-09-24 the program is on devnet. Mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g` has three paid charges and six refusals from 2026-09-20 20:57:50 UTC through 2026-09-21 22:00:11 UTC. That span is not a week, and it cannot be backfilled. Mobile Wallet Adapter `authorize` and the Seed Vault signatures have not been checked on a Seeker.

## Risks

1. **Mobile Wallet Adapter and Seed Vault have not been checked on a Seeker.** The unit tests do not cover `authorize` or the Seed Vault signatures. Nothing in the repo is a device log of that check.
2. **The quoted rule's history is the span above.** A later charge on that mandate does not turn the existing rows into a week.
3. **A refusal has to confirm.** The balance is unchanged and the ledger entry exists in the same confirmed transaction. That is what the refusal test asserts.
4. **A charge the agent never submits has no record.** Nothing on chain can provide one. The record is every decision the agent submits. [PROBLEM.md](PROBLEM.md) states that limit.
5. **SolAgent Pay describes an overspend as an impossible transaction and escrows into a vault.** The record here is the refusal, on a phone.

## House rules

Small conventional commits from day one, because commit history is scored. No invented prices or
fabricated counterparties on any surface. Amounts as integer base units, never floats. Secrets
never in git. No em dash anywhere.
