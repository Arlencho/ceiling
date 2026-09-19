# Ceiling

**A wallet that is allowed to do less, on purpose.**

AI can already decide what to buy. Crypto still offers two bad options: sign every transaction, or
hand an agent a blank check. Ceiling is the missing middle, on Solana Mobile.

You write a mandate once: what it may pay for, up to how much, and until when. An agent can act
inside that box without another tap. When a charge breaks the rule, the program refuses, records
why on chain, and moves no money.

> Status: in active development for the Solana Mobile "Clock In" hackathon. Submissions close
> 2026-10-09. This README describes what is built; see [docs/PLAN.md](docs/PLAN.md) for what is
> planned and [docs/DECISIONS.md](docs/DECISIONS.md) for why.

## The refusal is the product

Most payment programs demonstrate a transaction that succeeds. Ceiling demonstrates a transaction
that **confirms on chain and deliberately moves nothing.**

When `charge` declines, it does not return an error. Returning an error would roll back every
account write, so the refusal would leave no trace and would be indistinguishable from nothing
having happened. Instead the instruction transfers nothing, writes a refusal to an on-chain ledger
with a reason code, logs a readable line, and returns `Ok`.

So a refusal has a signature you can open in an explorer:

```
CEILING REFUSED reason=5 (over per-payment maximum) amount=180000000 per_tx_max=60000000 remaining=158000000
```

The transaction succeeded. The balance did not change. Neither party can edit the record.

## How authority is split

| | Owner key | Agent key |
|---|---|---|
| Lives in | Seed Vault, reached through Mobile Wallet Adapter | app secure storage on the phone |
| Can | open a mandate, override one payment, revoke, close | submit a charge |
| Cannot | be impersonated by the agent | change any limit, change the merchant, extend the expiry, or move funds outside the mandate |

Funds never leave the owner's wallet. The mandate PDA is an SPL delegate on the owner's own token
account, not a vault holding the money. The owner can revoke in one signature, and can also revoke
the SPL delegation directly without this program, which the program notices and reports as a
refusal reason rather than a crash.

## What the chain enforces

Four limits, all on chain, checked on every charge:

- **cap** total that may ever be spent
- **per-payment maximum** largest single payment
- **expiry** unix timestamp after which nothing moves
- **merchant** the only wallet that may receive funds

Plus replay protection: only a *paid* charge advances the nonce, so a settled payment cannot be
replayed while a refused one can still be retried after an override.

The human-readable purpose is stored on chain as written and cannot be edited afterwards. Be
precise about what that means: the chain does not understand the word "groceries". The purpose is
an immutable statement of intent, and it is bound to a merchant the chain does enforce.

## Refusal reasons

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
signature, it applies to exactly one nonce, and it is written to the ledger as an override. An
override raises the per-payment ceiling only. It can never raise the total cap, so the number the
owner committed to stays absolute.

Blind autopilot is the failure mode this removes. Overriding is allowed; overriding silently is
not.

## Repository layout

```
programs/ceiling/     the Anchor program: state, policy, ledger
docs/PLAN.md          build plan, milestones, verified event rules
docs/DECISIONS.md     architecture decisions and what would reverse them
```

The mobile app and the merchant terminal land next; see the plan for the order.

## Build

Requires Rust, the Solana CLI and Anchor.

```bash
anchor build
cargo test
```

## Threat model

Written out in full before the security pass, because "the agent cannot overspend" is a claim that
has to survive reading rather than be taken on faith.

- **A compromised agent key** can submit charges to the named merchant, up to the per-payment
  maximum, up to the remaining cap, until the expiry. That is the blast radius and it is the point:
  the mandate is what the owner agreed to lose in the worst case.
- **A compromised agent key cannot** change any field of the mandate, name a different merchant,
  extend the expiry, grant itself an override, or touch any other mandate, because every widening
  instruction requires the owner's signature and `charge` requires `has_one = agent`.
- **The program cannot move funds the owner has not delegated.** The SPL delegation is the hard
  ceiling underneath the program's own accounting.
- **A malicious merchant** can only receive what the mandate allows, and cannot replay a settled
  charge because the nonce is monotonic on payment.
- **A stale or wrong mandate account** cannot be substituted: `charge` re-derives the mandate
  address from the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA,
  so a forged account cannot be the delegate.

## License

Apache-2.0
