# Veto

**Everyone stops the overspend. Only this one can prove it stopped.**

Veto enforces a spending rule on chain: when a charge breaks it, the transfer is never executed
and no tokens move. That much is table stakes, and every serious design does it.

What nothing else does is leave anything behind. Elsewhere a blocked overspend is a failed
transaction: no artifact, no reason, no trail, nothing to audit. Here the decline is a first-class
on-chain record, with a one-line why and the override that would have cleared it. On a phone, with
the key in Seed Vault.

AP2 standardised the record of a yes. This is the missing half.

> Status: in development for the Solana Mobile "Clock In" hackathon, submissions close
> 2026-10-09. See [docs/PLAN.md](docs/PLAN.md) for the build plan,
> [docs/PITCH.md](docs/PITCH.md) for the positioning, and
> [docs/internal/DECISIONS.md](docs/internal/DECISIONS.md) for why each choice was made and what would reverse it.

## Prior art

Capped agent spending on Solana is not new, and this project does not claim it.

| Prior art | What it does | What Veto adds |
|---|---|---|
| [Squads v4 spending limits](https://squads.xyz/blog/spending-limits) | Pre-approved allowances, roles, per-member caps. Audited by Neodyme, OtterSec and Trail of Bits, two formal verifications underway | Treasury operations for humans. An overspend stops, and the stop leaves no record |
| SPL `approve` / delegate | Caps what a delegate may pull | Cap only. No purpose, no expiry, no reason, no record |
| [LazorKit](https://github.com/lazor-kit/lazor-kit) | Passkey smart wallet, session keys with slot-height expiry, on-chain RBAC and spending limits | Wallet infrastructure for app developers |
| [SolAgent Pay](https://github.com/altaranexus-ship-it/solagent-pay) | Session PDA with lifetime and per-request ceilings, merchant allowlist, TTL, revoke and sweep | An overspend "is not a policy violation logged after the fact, it is an impossible transaction". Funds are escrowed into a vault. Veto records the decline and leaves the funds in the owner's wallet |
| [Oculus](https://github.com/useoculusagent/useoculusagent) | On-chain policy check per transaction, a USDC reserve reimburses a breach within 60 seconds | Reimburses a breach after the fact. Veto declines before money moves, and the decline is a record |
| [x402](https://metamask.io/news/what-is-x402) / [AP2](https://www.cobo.com/post/ap2-protocol-complete-guide-to-agent-payments-for-web3-developers-2026) | HTTP 402 settlement; signed Intent, Cart and Payment mandates as verifiable credentials | The record of a yes, held off chain as the merchant's evidence |

Capped on-chain agent budgets are documented well enough that infrastructure vendors publish
tutorials on them. The claim here is narrower: **the refusal is an artifact.**

## The refusal is the product

When a rule fails, the token transfer instruction is never executed, so zero tokens move. The SPL
delegation underneath is a second ceiling the program itself cannot exceed.

When `charge` declines it does not return an error. An error would roll back every account write,
and the refusal would leave no trace. The instruction transfers nothing, writes a refusal to an
on-chain ledger with a reason code and the override that would have cleared it, logs a readable
line, and returns `Ok`.

A refusal has a signature you can open in an explorer. This is the 18:00 SE3 refusal linked below:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

The **transaction** succeeded: it succeeded at deciding no. The **payment** did not happen: the
balance is unchanged. A refusal is a transaction that worked and a payment that did not, and
neither party can edit the record of it.

The last field is the override that would have cleared the charge.

## See it on devnet

Live on Solana devnet. Open this transaction:

**[A refusal, recorded](https://explorer.solana.com/tx/3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib?cluster=devnet)**

Three things to look at, in this order: the transaction **succeeded**, the token balances are
**unchanged**, and the program log says why.

```
Program log: VETO REFUSED reason=5 (over per-payment maximum)
             amount=6232500 per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

The bill was 6.2325 tokens because 50 kWh was repriced at 0.12465 SEK/kWh. That price is the
only input we do not control. The
mandate allows 0.5 per payment. It did not pay, it said why, and it said what would have cleared
it. That transaction is the record. Solana devnet, our token, our counterparty: when a rule
allows a bill, the program executes an SPL transfer of that token to a token account we created.

Four later decisions on the same mandate confirmed on the six-hour cadence. Each was refused.
The per-payment maximum is 0.5, and each charge was over it. Token balances are unchanged on
all four.

| Recorded (UTC) | Stockholm hour on 2026-09-21 | Spot price | Charge | Decision |
|---|---|---|---|---|
| 2026-09-20 22:00:00 | 00:00 | 0.16326 SEK/kWh | 8.163 | [refused](https://explorer.solana.com/tx/5MJLtM92foysaWgfqs6x6oBYxyES2Ra2st8UK47dRX8h1F2wo43qQxJt4GFycEWiLSKJQjWbUBhotHMhkHymLoBU?cluster=devnet) |
| 2026-09-21 04:00:08 | 06:00 | 0.43085 SEK/kWh | 21.5425 | [refused](https://explorer.solana.com/tx/47PZmcRp85U5s3S9GjKekJ7BYcfLeCvY3MKhcDyhyn8Rt5YRdLL5MviymKfFKBeiswn3owx8P6VianW4MRLfU97N?cluster=devnet) |
| 2026-09-21 10:00:00 | 12:00 | 0.15807 SEK/kWh | 7.9035 | [refused](https://explorer.solana.com/tx/5HTd7nhtGvz2zpxxbszgVBhRAjcv52MTBRLvVoxRt98LXJvaVsEDRcLSbsAzx1SMdRoxekzhTBtmx6T6xTfDVMdr?cluster=devnet) |
| 2026-09-21 16:00:09 | 18:00 | 1.27877 SEK/kWh | 63.9385 | [refused](https://explorer.solana.com/tx/59ePBRRBGdu51J7aURacABWNtzqhvpWLFzsSfEcFA5eJd4Zn2y2gtY9MtG6fF6dgG8CdFKbWDzvnKGJRSmZKngyq?cluster=devnet) |

The recorded time is the block time. The Stockholm hour is the SE3 window the price belongs to,
the 15-minute window that starts at that hour. Those prices are the Nordic day-ahead spot for
SE3 on 2026-09-21, on the [same public URL the agent reads](https://www.elprisetjustnu.se/).
Each charge is that price times 50 kWh, the kWh figure the bill is repriced against. The program
log on each transaction is `reason=5 (over
per-payment maximum)` with `per_tx_max=500000` and these base-unit amounts: 8163000, 21542500,
7903500, 63938500.

To take one off chain and check it independently:

```bash
cd indexer && npm ci
cd ../tools && npm ci
VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature 3rTpyrHEScEPhjHL3cUDYSGwGAxU6JVzbdWVZbr4YMHt3wAM7ad9JGPC26R8aQMH9aqYVzrFqbEogX1CquNcWqib --out refusal.json
VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts refusal.json
# Program 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV on https://api.devnet.solana.com.
# Mandate limits, ledger entry, and charge transaction agree.
```

Change the amount in that file to 1 and run verify again. While the ring still holds this row:

```
VERDICT: REJECTED

- amount (instruction): record has 1, chain has 6232500
- amount (ledger): record has 1, chain has 6232500
```

## Why Solana Mobile

Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside
it rather than a copy of the key.

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

The human-readable purpose is stored on chain as written and cannot be edited afterwards. The
chain does not understand the word "groceries". The purpose is an immutable statement of intent,
bound to a merchant the chain does enforce.

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
| 10 | account frozen |

## Overrides are on the record

The owner can wave one specific payment through above the per-payment ceiling. It takes an owner
signature, applies to exactly one nonce, and is written to the ledger as an override. An override
raises the per-payment ceiling only. It can never raise the total cap, so the number the owner
committed to stays absolute.

## The demo

An agent pays a bill repriced by a public index, unattended, against an on-chain rule. The index
is the [Nordic day-ahead electricity spot](https://www.elprisetjustnu.se/). The feed is public,
needs no key, and anyone can verify the same numbers against the same URL. The price is the only
input we do not control, which is why the refusal counts.

Solana devnet. Our token. Our counterparty. [scripts/devnet-setup.sh](scripts/devnet-setup.sh)
creates the mint, mints the supply the watcher spends, and creates the counterparty token
account. [tools/produce.ts](tools/produce.ts) mints further supply of that same mint into a
separate source account. When the rule allows the bill, the program executes an SPL transfer of
that token to the account we created. The counterparty is a terminal we run. Public addresses
are in [docs/DEVNET.md](docs/DEVNET.md).

## A second mint

The second mandate on devnet (`7Bns2EMrzw9T8apGLRGynean4mkFMwHsEWoXbeTGnNtj`) is not an SKR
integration. Solana Mobile's SKR mint is `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`. That
account is on mainnet, and the same address is absent on devnet, which is the only cluster this
program is deployed to. The second mandate is open against
`Dcbba8YzbTXM1HQ9EeHW7M21T1Ce5PiBsY1Bpxx5K3Kq`, a classic SPL mint created on devnet at 6
decimals, with its own token account (`66RkDwxF51Vzx6Yc7PAGoqkMY6X6bn74gXjT1CiMLhaV`) and its
own delegate, the new mandate account. It is a second asset. `open_mandate` and `charge` already
take the mint they are given, and [tools/second-mint.ts](tools/second-mint.ts) only configures
that path. SKR is the mainnet asset that mint field would name. This mint is not SKR, and it is
not the demo mint `2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU`.

## Repository layout

```
programs/veto/            the Anchor program: state, policy, zero-copy ledger
app/                      the Android app: Expo, custom dev client, Seed Vault via MWA
watcher/                  unattended agent: live SE3 feed, charge, JSONL diary
indexer/                  rebuild Paid and Refused history from transaction logs
tools/                    export one decision as JSON and verify it against the chain
scripts/devnet-setup.sh   recreate the chain deploy and demo fixtures from nothing
docs/DECISION_RECORD.md   stable schema for that JSON
docs/PROBLEM.md           the problem, who has it, what they do today, what Veto does
docs/PLAN.md              build plan, milestones, and prior art
docs/PITCH.md             the pitch: position and the sixty seconds
docs/DECK.md              the deck, slide by slide
docs/GCP_SETUP.md         the watcher GCP project, checked by scripts/gcp-verify.sh
docs/internal/            working notes: decisions, self-review, design brief, design decision
```

## Build and run

Requires Rust, the Solana CLI and Anchor. From a fresh clone:

```bash
make test
```

That builds the program and runs the suite, including the refusal test: a
refused charge produces a transaction that confirms, moves nothing, and records why.

`make test` rather than `anchor build && cargo test` for two reasons, both documented in the
Makefile. Anchor 1.2 emits an SBPFv3 ELF that LiteSVM 0.10 cannot load, so the test build pins
SBPF v0. And `target/` is gitignored, so a fresh clone has no program keypair and Anchor needs
`--ignore-keys` rather than rewriting the program id to match a throwaway key.

To provision a chain and the demo fixtures, `make setup` for devnet or `make localnet` against a
local validator.

The history indexer lives in `indexer/`. It walks program logs rather than trusting the 32-entry
ring, because a busy week wraps the ring and the full trail has to survive that. `make
indexer-test` typechecks and tests it. `make indexer-seed` opens a mandate and submits one paid
charge and several refused ones so the CLI can be compared against the ring.

To take a decision off the phone and check it from a laptop:

```bash
cd indexer && npm ci
cd ../tools && npm ci
npx tsx produce.ts
npx tsx export.ts --signature <tx> --out refused.json
npx tsx verify.ts refused.json
npx tsx export.ts --mandate <mandate> --format csv --out rule.csv
npx tsx verify.ts rule.csv
```

The JSON schema, the bulk envelope, and the CSV columns are in
[docs/DECISION_RECORD.md](docs/DECISION_RECORD.md). Verify re-reads the cluster; it does
not trust the file. Bulk rows come from the indexer, not the 32-entry ring. The
file itself states `completeness=payments`: complete over charges that landed,
never over attempts.

## Threat model

What a key can do under a mandate.

- **A compromised agent key** can submit charges to the named merchant, up to the per-payment
  maximum, up to the remaining cap, until the expiry. That is the blast radius, and it is the point:
  the mandate is what the owner agreed to lose in the worst case. The owner revokes in one signature.
- **A compromised agent key cannot** widen any field of the mandate, name a different merchant,
  extend the expiry, grant itself an override, or touch any other mandate. Every widening
  instruction requires the owner's signature, and `charge` requires `has_one = agent`.
- **The program cannot move funds the owner has not delegated.** The SPL delegation is the hard
  ceiling underneath the program's own accounting.
- **A malicious merchant** can only receive what the mandate allows. A merchant cannot submit a
  charge at all; only the named agent signs `charge`.
- **A forged mandate account cannot be substituted.** `charge` re-derives the mandate address from
  the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA.
- **Known limit.** The ledger records every decision this program reaches. A frozen source or
  destination is inspected in `evaluate` and recorded as a refusal. Anchor account validation
  failures (wrong mint, wrong source, wrong ledger) and token-program declines this program does
  not inspect are errors with no entry. It cannot record a charge the agent never attempted, and
  nothing on chain can. No payment happens without a record, and no submitted attempt is judged by
  the agent instead of by the chain.

## License

Apache-2.0
