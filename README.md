# Veto

**Limits on chain already exist. Every one of them makes an overspend impossible. We make the
refusal legible.**

An impossible transaction protects your money and teaches you nothing. No artifact, no reason, no
trail. Veto is a permission to spend where the decline is a first-class on-chain record: a
recorded no, a one-line why, and the override that would have cleared it. On a phone, with the key
in Seed Vault.

AP2 standardised the record of a yes. This is the missing half.

> Status: in development for the Solana Mobile "Clock In" hackathon, submissions close
> 2026-10-09. See [docs/PLAN.md](docs/PLAN.md) for the build plan,
> [docs/PITCH.md](docs/PITCH.md) for the positioning, and
> [docs/DECISIONS.md](docs/DECISIONS.md) for why each choice was made and what would reverse it.

## What is and is not new here

Capped agent spending on Solana is not new, and this project does not claim it. Being specific
about that is the point:

| Prior art | What it does | Why this is different |
|---|---|---|
| [Squads v4 spending limits](https://squads.xyz/blog/spending-limits) | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec and Trail of Bits, two formal verifications underway | Treasury operations for humans. An overspend is impossible, never legible |
| SPL `approve` / delegate | Caps what a delegate may pull | Cap only. No purpose, no expiry, no reason, no record |
| [LazorKit](https://github.com/lazor-kit/lazor-kit) | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers, not a product about trust |
| [SolAgent Pay](https://github.com/altaranexus-ship-it/solagent-pay) | Session PDA with lifetime and per-request ceilings, merchant allowlist, TTL, revoke and sweep | Closest on the numbers, and states outright that an overspend "is not a policy violation logged after the fact, it is an impossible transaction". Opposite thesis. It also escrows into a vault; we never move the funds |
| [Oculus](https://github.com/useoculusagent/useoculusagent) | On-chain policy check per transaction, a USDC reserve reimburses a breach within 60 seconds | Insurance after the fact. We decline before money moves, then explain |
| [x402](https://metamask.io/news/what-is-x402) / [AP2](https://www.cobo.com/post/ap2-protocol-complete-guide-to-agent-payments-for-web3-developers-2026) | HTTP 402 settlement; signed Intent, Cart and Payment mandates as verifiable credentials | The record of a yes, held off chain as the merchant's evidence |

Capped on-chain agent budgets are documented well enough that infrastructure vendors publish
tutorials on them. Treat the primitive as commodity. The claim here is narrower: **the refusal is
an artifact.**

## The refusal is the product

When `charge` declines, it does not return an error. An error would roll back every account write,
so the refusal would leave no trace and would be indistinguishable from nothing having happened.
Instead the instruction transfers nothing, writes a refusal to an on-chain ledger with a reason
code and the override that would have cleared it, logs a readable line, and returns `Ok`.

So a refusal has a signature you can open in an explorer:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=180000000 per_tx_max=60000000 remaining=158000000 override_to_clear=180000000
```

The transaction succeeded. The balance did not change. Neither party can edit the record.

That last field is the part no prior art has: a decline that tells you what would have worked.

## Why Solana Mobile

Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
it rather than a copy of the key.

Squads cannot make that argument. AP2 cannot. It is the only "why here" that is not
interchangeable.

## How authority is split

| | Owner key | Agent key |
|---|---|---|
| Lives in | Seed Vault, reached through Mobile Wallet Adapter | app secure storage on the phone |
| Can | open a mandate, override one payment, revoke, close | submit a charge |
| Cannot | be impersonated by the agent | change any limit, change the merchant, extend the expiry, or move funds outside the mandate |

Funds never leave the owner's wallet. The mandate PDA is an SPL delegate on the owner's own token
account, not a vault holding the money. The owner can revoke in one signature, and can also revoke
the SPL delegation directly without this program, which the program notices and reports as a
refusal reason rather than crashing on.

## What the chain enforces

Four limits, all on chain, checked on every charge: **cap**, **per-payment maximum**, **expiry**,
and a single allowed **merchant**. Plus replay protection: only a paid charge advances the nonce,
so a settled payment cannot be replayed while a refused one can still be retried after an override.

The human-readable purpose is stored on chain as written and cannot be edited afterwards. Be
precise about what that means: the chain does not understand the word "groceries". The purpose is
an immutable statement of intent, bound to a merchant the chain does enforce.

### Refusal reasons

| Code | Meaning |
|---|---|
| 1 | mandate not active |
| 2 | past expiry |
| 3 | nonce already settled |
| 4 | merchant not allowed |
| 5 | over per-payment maximum |
| 6 | over remaining cap |
| 7 | delegation withdrawn |
| 8 | insufficient funds |
| 9 | zero amount |

## Overrides are on the record

The owner can wave one specific payment through above the per-payment ceiling. It takes an owner
signature, applies to exactly one nonce, and is written to the ledger as an override. An override
raises the per-payment ceiling only. It can never raise the total cap, so the number the owner
committed to stays absolute.

Blind autopilot is the failure mode this removes. Overriding is allowed. Overriding silently is not.

## The demo data is real, and here is exactly how real

The agent watches [Nordic day-ahead electricity spot prices](https://www.elprisetjustnu.se/) and
pays for charging when power is under the ceiling the owner set. That feed is public, needs no key,
and anyone can verify the same numbers against the same URL.

**The counterparty is a terminal we run**, because no charge point operator accepts USDC. We are
not claiming a real merchant. What the real feed buys is the property that matters: refusals happen
because electricity got expensive, not because someone pressed a button on camera.

## Repository layout

```
programs/veto/            the Anchor program: state, policy, zero-copy ledger
app/                      the Android app: Expo, custom dev client, Seed Vault via MWA
indexer/                  rebuild Paid and Refused history from transaction logs
scripts/devnet-setup.sh   recreate the chain deploy and demo fixtures from nothing
docs/PROBLEM.md           who this is for, and why a burner wallet is not enough
docs/PLAN.md              build plan, milestones, verified event rules, prior art
docs/PITCH.md             positioning, the sixty seconds, judge Q&A
docs/DECK.md              the deck, slide by slide
docs/DECISIONS.md         architecture decisions and what would reverse them
```

## Build and run

Requires Rust, the Solana CLI and Anchor. From a fresh clone:

```bash
make test
```

That builds the program and runs the suite, including the test that matters: a
refused charge produces a transaction that confirms, moves nothing, and records why.

`make test` rather than `anchor build && cargo test` for two reasons, both documented in the
Makefile. Anchor 1.2 emits an SBPFv3 ELF that LiteSVM 0.10 cannot load, so the test build pins
SBPF v0. And `target/` is gitignored, so a fresh clone has no program keypair and Anchor needs
`--ignore-keys` rather than rewriting the program id to match a throwaway key.

To provision a chain and the demo fixtures, `make setup` for devnet or `make localnet` against a
local validator.

The history indexer lives in `indexer/`. It walks program logs rather than trusting the 32-entry
ring. `make indexer-test` typechecks and tests it. `make indexer-seed` opens a mandate and submits
one paid charge and refused charges so the CLI can compare against the ring.

## Threat model

Written out because "the agent cannot overspend" is a claim that has to survive reading rather than
be taken on faith.

- **A compromised agent key** can submit charges to the named merchant, up to the per-payment
  maximum, up to the remaining cap, until the expiry. That is the blast radius, and it is the point:
  the mandate is what the owner agreed to lose in the worst case. The owner revokes in one signature.
- **A compromised agent key cannot** change any field of the mandate, name a different merchant,
  extend the expiry, grant itself an override, or touch any other mandate. Every widening
  instruction requires the owner's signature, and `charge` requires `has_one = agent`.
- **The program cannot move funds the owner has not delegated.** The SPL delegation is the hard
  ceiling underneath the program's own accounting.
- **A malicious merchant** can only receive what the mandate allows, and cannot replay a settled
  charge, because the nonce is monotonic on payment.
- **A forged mandate account cannot be substituted.** `charge` re-derives the mandate address from
  the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA.
- **Known limit, stated rather than hidden.** The ledger records every decision the agent submits.
  It cannot record a charge the agent never attempted, and nothing on chain can. What is guaranteed
  is narrower and still worth having: no payment happens without a record, and no attempt is judged
  by the agent instead of by the chain. The alternative design records nothing in either case.

## License

Apache-2.0
